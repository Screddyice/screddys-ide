import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  ownedHomeRecovery,
  takeOverLocalServer,
  type StaleServerProbe,
  type TakeOverResult,
} from "./DesktopStaleServer.ts";

const ENTRY = "/Applications/Screddy.app/Contents/Resources/app.asar/apps/server/dist/bin.mjs";

const runtimeState = (serverVersion: string, pid = 41374) =>
  JSON.stringify({
    version: 1,
    pid,
    host: "127.0.0.1",
    port: 3774,
    origin: "http://127.0.0.1:3774",
    startedAt: "2026-11-23T22:49:14.941Z",
    serverVersion,
  });

const probe = (input: {
  readonly contents: string | undefined;
  readonly alive?: boolean;
  readonly command?: string;
  /** How many liveness checks after the signal still see the process. */
  readonly exitsAfterChecks?: number;
}) => {
  const signalled: Array<number> = [];
  const events: Array<string> = [];
  let checksAfterSignal = 0;
  const value: StaleServerProbe = {
    readRuntimeState: Effect.succeed(input.contents),
    isAlive: () =>
      Effect.sync(() => {
        if (signalled.length === 0) return input.alive ?? true;
        checksAfterSignal += 1;
        const alive = checksAfterSignal <= (input.exitsAfterChecks ?? 0);
        events.push(alive ? "alive" : "gone");
        return alive;
      }),
    commandOf: () => Effect.succeed(input.command ?? `/Applications/Screddy.app/x ${ENTRY} start`),
    terminate: (pid) => Effect.sync(() => void signalled.push(pid)),
    pause: Effect.sync(() => void events.push("pause")),
  };
  return { value, signalled, events, checks: () => checksAfterSignal };
};

describe("takeOverLocalServer", () => {
  it.effect("stops a live server from this install, whatever version it runs", () =>
    Effect.gen(function* () {
      for (const version of ["0.1.47", "0.1.48"]) {
        const { value, signalled, events } = probe({
          contents: runtimeState(version),
          exitsAfterChecks: 2,
        });
        const result = yield* takeOverLocalServer({ backendEntryPath: ENTRY, probe: value });
        expect(result).toEqual({ _tag: "Stopped", pid: 41374, serverVersion: version });
        expect(signalled).toEqual([41374]);
        // It waits, pausing between checks, until the old server exits and frees the lock.
        expect(events).toEqual(["alive", "pause", "alive", "pause", "gone"]);
      }
    }),
  );

  it.effect("stops waiting for a server that will not exit and reports it as stuck", () =>
    Effect.gen(function* () {
      const { value, signalled, checks } = probe({
        contents: runtimeState("0.1.48"),
        exitsAfterChecks: Number.POSITIVE_INFINITY,
      });
      const result = yield* takeOverLocalServer({ backendEntryPath: ENTRY, probe: value });
      expect(result).toEqual({ _tag: "Stuck", pid: 41374 });
      expect(signalled).toEqual([41374]);
      expect(checks()).toBeLessThanOrEqual(100);
    }),
  );

  it.effect("never signals a server from another program or install", () =>
    Effect.gen(function* () {
      // A reused PID, or the stock `t3` service of another install.
      for (const command of ["/usr/bin/vim notes.txt", "/opt/example/.t3/runtime/t3 serve"]) {
        const { value, signalled } = probe({ contents: runtimeState("0.1.48"), command });
        const result = yield* takeOverLocalServer({ backendEntryPath: ENTRY, probe: value });
        expect(result).toEqual({ _tag: "Foreign", pid: 41374 });
        expect(signalled).toEqual([]);
      }
    }),
  );

  it.effect("finds nothing to stop without a live recorded server", () =>
    Effect.gen(function* () {
      const cases = [
        { contents: undefined },
        { contents: "not json" },
        { contents: runtimeState("0.1.48"), alive: false },
      ];
      for (const input of cases) {
        const { value, signalled } = probe(input);
        const result = yield* takeOverLocalServer({ backendEntryPath: ENTRY, probe: value });
        expect(result._tag).toBe("Kept");
        expect(signalled).toEqual([]);
      }
    }),
  );
});

describe("ownedHomeRecovery", () => {
  const recovery = (results: ReadonlyArray<TakeOverResult>) => {
    const calls: Array<string> = [];
    let next = 0;
    const recover = ownedHomeRecovery({
      takeOver: Effect.sync(() => {
        calls.push("takeOver");
        return results[Math.min(next++, results.length - 1)]!;
      }),
      restart: Effect.sync(() => void calls.push("restart")),
      giveUp: Effect.sync(() => void calls.push("giveUp")),
      pause: Effect.void,
      maxAttempts: 3,
    });
    return { recover, calls };
  };
  const stopped: TakeOverResult = { _tag: "Stopped", pid: 1, serverVersion: "0.1.71" };

  it.effect("stops the background server that won the race and starts again", () =>
    Effect.gen(function* () {
      const { recover, calls } = recovery([stopped]);
      yield* recover;
      expect(calls).toEqual(["takeOver", "restart"]);
    }),
  );

  it.effect("retries while the new owner has not recorded itself yet", () =>
    Effect.gen(function* () {
      const { recover, calls } = recovery([{ _tag: "Kept" }, stopped]);
      yield* recover;
      yield* recover;
      expect(calls).toEqual(["takeOver", "restart", "takeOver", "restart"]);
    }),
  );

  it.effect("gives up at once for another program's server or one that will not exit", () =>
    Effect.gen(function* () {
      for (const result of [
        { _tag: "Foreign", pid: 7 },
        { _tag: "Stuck", pid: 7 },
      ] as const) {
        const { recover, calls } = recovery([result]);
        yield* recover;
        expect(calls).toEqual(["takeOver", "giveUp"]);
      }
    }),
  );

  it.effect("gives up once the attempts run out", () =>
    Effect.gen(function* () {
      const { recover, calls } = recovery([stopped]);
      for (let attempt = 0; attempt < 4; attempt++) yield* recover;
      expect(calls).toEqual([
        "takeOver",
        "restart",
        "takeOver",
        "restart",
        "takeOver",
        "restart",
        "giveUp",
      ]);
    }),
  );
});
