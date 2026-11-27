// @effect-diagnostics nodeBuiltinImport:off - Reads one process's command line by PID.
import * as NodeChildProcess from "node:child_process";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";

const { logInfo, logWarning } = DesktopObservability.makeComponentLogger("desktop-stale-server");

const decodeRuntimeState = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ pid: Schema.Int, serverVersion: Schema.String })),
);

export interface StaleServerProbe {
  readonly readRuntimeState: Effect.Effect<string | undefined>;
  readonly isAlive: (pid: number) => Effect.Effect<boolean>;
  readonly commandOf: (pid: number) => Effect.Effect<string | undefined>;
  readonly terminate: (pid: number) => Effect.Effect<void>;
  /** The wait between liveness checks while a stopped server exits. */
  readonly pause: Effect.Effect<void>;
}

export type TakeOverResult =
  | { readonly _tag: "Kept" }
  | { readonly _tag: "Stopped"; readonly pid: number; readonly serverVersion: string }
  | { readonly _tag: "Foreign"; readonly pid: number }
  | { readonly _tag: "Stuck"; readonly pid: number };

const kept: TakeOverResult = { _tag: "Kept" };

/** About ten seconds at the real pause: a server gets that long to shut down and free the lock. */
const EXIT_CHECKS = 100;

/**
 * A server that outlives the app (a launchd background service) owns the data folder's lock, and
 * the app's own server cannot start beside it. Opening the app takes over: it stops a live server
 * that this install's entry point started, whatever version it runs, and waits for it to exit. The
 * service starts it again once the app quits. A server from any other program is never touched.
 */
export const takeOverLocalServer = Effect.fn("desktop.staleServer.takeOver")(function* (input: {
  readonly backendEntryPath: string;
  readonly probe: StaleServerProbe;
}) {
  const contents = yield* input.probe.readRuntimeState;
  if (contents === undefined) return kept;
  const state = decodeRuntimeState(contents);
  if (Option.isNone(state)) return kept;
  const { pid, serverVersion } = state.value;
  if (!(yield* input.probe.isAlive(pid))) return kept;
  const command = yield* input.probe.commandOf(pid);
  if (command === undefined || !command.includes(input.backendEntryPath)) {
    return { _tag: "Foreign", pid } satisfies TakeOverResult;
  }
  yield* input.probe.terminate(pid);
  for (let check = 0; check < EXIT_CHECKS; check++) {
    if (!(yield* input.probe.isAlive(pid))) {
      return { _tag: "Stopped", pid, serverVersion } satisfies TakeOverResult;
    }
    yield* input.probe.pause;
  }
  return { _tag: "Stuck", pid } satisfies TakeOverResult;
});

/**
 * What the app does when its own server finds the data folder taken. launchd restarts a stopped
 * background server at once, so it can win the race against the app's server; stopping it again and
 * restarting wins once launchd's throttle holds the next respawn back. Another program's server, one
 * that will not exit, or running out of attempts ends in `giveUp`.
 */
export function ownedHomeRecovery(input: {
  readonly takeOver: Effect.Effect<TakeOverResult>;
  readonly restart: Effect.Effect<void>;
  readonly giveUp: Effect.Effect<void>;
  /** Lets a new owner that has not recorded itself yet do so before the next attempt. */
  readonly pause: Effect.Effect<void>;
  readonly maxAttempts: number;
}) {
  let attempts = 0;
  const recover = Effect.suspend(() => {
    if (attempts >= input.maxAttempts) return input.giveUp;
    attempts += 1;
    return input.takeOver.pipe(
      Effect.flatMap((result) => {
        switch (result._tag) {
          case "Stopped":
            return input.restart;
          case "Kept":
            return input.pause.pipe(Effect.andThen(input.restart));
          case "Foreign":
          case "Stuck":
            return input.giveUp;
        }
      }),
    );
  });
  /** Call once the server is up, so a later race in the same session gets the full number of attempts. */
  const reset = Effect.sync(() => {
    attempts = 0;
  });
  return { recover, reset };
}

const isAlive = (pid: number) =>
  Effect.sync(() => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });

const commandOf = (pid: number) =>
  Effect.callback<string | undefined>((resume) => {
    NodeChildProcess.execFile(
      "ps",
      ["-o", "command=", "-p", String(pid)],
      { timeout: 2_000 },
      (error, stdout) => resume(Effect.succeed(error ? undefined : stdout.trim() || undefined)),
    );
  });

const terminate = (pid: number) =>
  Effect.sync(() => {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // It exited between the check and the signal.
    }
  });

/** Takes over from a background server for packaged builds on platforms with `ps`. */
export const takeOverLocalServerForThisApp = Effect.fn("desktop.staleServer.forThisApp")(
  function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    if (!environment.isPackaged || environment.isDevelopment || environment.platform === "win32") {
      return kept;
    }
    const fileSystem = yield* FileSystem.FileSystem;
    const runtimeStatePath = environment.path.join(environment.stateDir, "server-runtime.json");
    const result = yield* takeOverLocalServer({
      backendEntryPath: environment.backendEntryPath,
      probe: {
        readRuntimeState: fileSystem
          .readFileString(runtimeStatePath)
          .pipe(Effect.orElseSucceed(() => undefined)),
        isAlive,
        commandOf,
        terminate,
        pause: Effect.sleep("100 millis"),
      },
    });
    if (result._tag === "Stopped") {
      yield* logInfo("stopped a local server so this app can own its data folder", {
        pid: result.pid,
        serverVersion: result.serverVersion,
        appVersion: environment.appVersion,
      });
    } else if (result._tag === "Stuck") {
      yield* logWarning("a local server did not exit after being stopped", { pid: result.pid });
    }
    return result;
  },
  Effect.catchCause((cause) =>
    logWarning("could not check for a local server to take over", { cause }).pipe(Effect.as(kept)),
  ),
);
