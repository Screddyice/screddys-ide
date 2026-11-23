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
}

export type StaleServerResult =
  | { readonly _tag: "Kept" }
  | { readonly _tag: "Restarted"; readonly pid: number; readonly serverVersion: string };

const kept: StaleServerResult = { _tag: "Kept" };

/**
 * A server that outlives the app (the launchd background service) keeps running the
 * bundle it started from after an app update. Stopping it lets its supervisor start
 * the installed version; only the server this install's entry point launched is touched.
 */
export const restartStaleLocalServer = Effect.fn("desktop.staleServer.restart")(function* (input: {
  readonly appVersion: string;
  readonly backendEntryPath: string;
  readonly probe: StaleServerProbe;
}) {
  const contents = yield* input.probe.readRuntimeState;
  if (contents === undefined) return kept;
  const state = decodeRuntimeState(contents);
  if (Option.isNone(state)) return kept;
  const { pid, serverVersion } = state.value;
  if (serverVersion === input.appVersion) return kept;
  if (!(yield* input.probe.isAlive(pid))) return kept;
  const command = yield* input.probe.commandOf(pid);
  if (command === undefined || !command.includes(input.backendEntryPath)) return kept;
  yield* input.probe.terminate(pid);
  return { _tag: "Restarted", pid, serverVersion } satisfies StaleServerResult;
});

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

/** Runs once at startup for packaged builds on platforms with `ps`. */
export const restartStaleLocalServerAtStartup = Effect.fn("desktop.staleServer.atStartup")(
  function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    if (!environment.isPackaged || environment.isDevelopment || environment.platform === "win32") {
      return kept;
    }
    const fileSystem = yield* FileSystem.FileSystem;
    const runtimeStatePath = environment.path.join(environment.stateDir, "server-runtime.json");
    const result = yield* restartStaleLocalServer({
      appVersion: environment.appVersion,
      backendEntryPath: environment.backendEntryPath,
      probe: {
        readRuntimeState: fileSystem
          .readFileString(runtimeStatePath)
          .pipe(Effect.orElseSucceed(() => undefined)),
        isAlive,
        commandOf,
        terminate,
      },
    });
    if (result._tag === "Restarted") {
      yield* logInfo("stopped a local server running another app version", {
        pid: result.pid,
        serverVersion: result.serverVersion,
        appVersion: environment.appVersion,
      });
    }
    return result;
  },
  Effect.catchCause((cause) =>
    logWarning("could not check for a stale local server", { cause }).pipe(Effect.as(kept)),
  ),
);
