import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { restartStaleLocalServer, type StaleServerProbe } from "./DesktopStaleServer.ts";

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
}) => {
  const signalled: Array<number> = [];
  const value: StaleServerProbe = {
    readRuntimeState: Effect.succeed(input.contents),
    isAlive: () => Effect.succeed(input.alive ?? true),
    commandOf: () => Effect.succeed(input.command ?? `/Applications/Screddy.app/x ${ENTRY} start`),
    terminate: (pid) => Effect.sync(() => void signalled.push(pid)),
  };
  return { value, signalled };
};

describe("restartStaleLocalServer", () => {
  it.effect("stops a live server of this home that runs another app version", () =>
    Effect.gen(function* () {
      const { value, signalled } = probe({ contents: runtimeState("0.1.47") });
      const result = yield* restartStaleLocalServer({
        appVersion: "0.1.48",
        backendEntryPath: ENTRY,
        probe: value,
      });
      expect(result).toEqual({ _tag: "Restarted", pid: 41374, serverVersion: "0.1.47" });
      expect(signalled).toEqual([41374]);
    }),
  );

  it.effect("leaves a server alone when it should not be stopped", () =>
    Effect.gen(function* () {
      const cases = [
        { contents: runtimeState("0.1.48") },
        { contents: undefined },
        { contents: "not json" },
        { contents: runtimeState("0.1.47"), alive: false },
        // A reused PID or a server from another install must never be signalled.
        { contents: runtimeState("0.1.47"), command: "/usr/bin/vim notes.txt" },
      ];
      for (const input of cases) {
        const { value, signalled } = probe(input);
        const result = yield* restartStaleLocalServer({
          appVersion: "0.1.48",
          backendEntryPath: ENTRY,
          probe: value,
        });
        expect(result._tag).toBe("Kept");
        expect(signalled).toEqual([]);
      }
    }),
  );
});
