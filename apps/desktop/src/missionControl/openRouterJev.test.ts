import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";

import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import { loadOpenRouterJev, saveOpenRouterJev } from "./openRouterJev.ts";

const fixtureKey = "example-credential-only";

it.layer(NodeServices.layer)("Mission Control OpenRouter key", (it) => {
  it.effect("validates JEV before replacing the encrypted key and removes it on request", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "screddy-jev-setup-" });
      const keyPath = path.join(baseDir, "mission-control-jev.enc");

      using fetch = vi.spyOn(globalThis, "fetch");
      fetch.mockResolvedValueOnce(
        Response.json({
          answers: {
            setup: { type: "choice", choice: "three", probabilities: { three: 1, four: 0 } },
          },
        }),
      );
      const result = yield* saveOpenRouterJev(baseDir, fixtureKey);
      assert.deepStrictEqual(result, { ok: true });
      assert.deepStrictEqual(yield* fs.readFileString(keyPath), "AAECAw==");

      const [url, request] = fetch.mock.calls[0]!;
      assert.strictEqual(String(url), "https://openrouter.ai/api/alpha/decisions");
      assert.strictEqual(request?.redirect, "error");
      const payload = yield* Effect.promise(() => new Response(request?.body).json());
      assert.deepStrictEqual(payload.state, { text: "A triangle has three sides." });
      assert.isDefined(yield* loadOpenRouterJev(baseDir));

      fetch.mockResolvedValueOnce(new Response("private service details", { status: 401 }));
      const failed = yield* saveOpenRouterJev(baseDir, "alternate-fixture-only");
      assert.isFalse(failed.ok);
      assert.notInclude(JSON.stringify(failed), "private service details");
      assert.strictEqual(yield* fs.readFileString(keyPath), "AAECAw==");

      assert.deepStrictEqual(yield* saveOpenRouterJev(baseDir, null), { ok: true });
      assert.isUndefined(yield* loadOpenRouterJev(baseDir));
    }).pipe(
      Effect.provideService(ElectronSafeStorage.ElectronSafeStorage, {
        isEncryptionAvailable: Effect.succeed(true),
        encryptString: () => Effect.succeed(new Uint8Array([0, 1, 2, 3])),
        decryptString: () => Effect.succeed(fixtureKey),
        selectedStorageBackend: Effect.succeedNone,
      }),
    ),
  );
});
