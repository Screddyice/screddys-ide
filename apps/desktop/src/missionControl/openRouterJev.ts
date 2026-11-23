// @effect-diagnostics nodeBuiltinImport:off -- Hashes the encrypted credential to invalidate cached decisions when the account changes.
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import type { MissionControlJevSetupResult } from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";

import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import type { JevDecider } from "./jev.ts";
import { obj } from "./sources.ts";

const credentialFile = "mission-control-jev.enc";
const decisionsUrl = "https://openrouter.ai/api/alpha/decisions";
const model = "typesafe/jev-1.14";
const unavailable = { _tag: "OpenRouterJevUnavailable" } as const;
const validKey = (key: string) => /^[!-~]{16,256}$/.test(key);

function openRouterJev(key: string, revision: string): JevDecider {
  return {
    revision,
    decide(text, questions) {
      const request = HttpClientRequest.post(decisionsUrl).pipe(
        HttpClientRequest.setHeader("Authorization", "Bearer " + key),
        HttpClientRequest.bodyJsonUnsafe({ model, state: { text }, questions }),
      );
      return Effect.runPromise(
        HttpClient.execute(request).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap((response) => response.json),
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
          Effect.provideService(HttpClient.TracerPropagationEnabled, false),
          Effect.provide(FetchHttpClient.layer),
          Effect.timeout("15 seconds"),
          Effect.withTracerEnabled(false),
          Effect.mapError(() => unavailable),
        ),
      );
    },
  };
}

export const hasSecureJevStorage = Effect.gen(function* () {
  const storage = yield* ElectronSafeStorage.ElectronSafeStorage;
  return yield* storage.isEncryptionAvailable;
}).pipe(Effect.orElseSucceed(() => false));

export const loadOpenRouterJev = Effect.fn("desktop.missionControl.loadOpenRouterJev")(
  function* (baseDir: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const storage = yield* ElectronSafeStorage.ElectronSafeStorage;
    const encrypted = yield* fs.readFileString(path.join(baseDir, credentialFile));
    if (!(yield* hasSecureJevStorage)) return undefined;
    const bytes = Buffer.from(encrypted, "base64");
    const key = yield* storage.decryptString(bytes);
    if (!validKey(key)) return undefined;
    return openRouterJev(key, NodeCrypto.createHash("sha256").update(bytes).digest("hex"));
  },
  Effect.orElseSucceed(() => undefined),
);

export const saveOpenRouterJev = Effect.fn("desktop.missionControl.saveOpenRouterJev")(function* (
  baseDir: string,
  input: unknown,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(baseDir, credentialFile);
  if (input === null) {
    return yield* fs.remove(filePath, { force: true }).pipe(
      Effect.as({ ok: true } as const),
      Effect.orElseSucceed(() => ({
        ok: false as const,
        error: "Could not remove the saved key.",
      })),
    );
  }
  const key = typeof input === "string" ? input.trim() : "";
  if (!validKey(key)) {
    return { ok: false as const, error: "Enter a valid OpenRouter API key." };
  }
  if (!(yield* hasSecureJevStorage)) {
    return { ok: false as const, error: "Secure desktop storage is unavailable." };
  }

  const verified = yield* Effect.promise(async (): Promise<MissionControlJevSetupResult> => {
    // Only this fixed sample is sent during setup.
    const successful = { ok: true } as const;
    try {
      const result = await openRouterJev(key, "").decide("A triangle has three sides.", {
        setup: {
          type: "choice",
          instructions: "Choose the number of sides stated in the sentence.",
          criteria: { three: "Three sides", four: "Four sides" },
        },
      });
      const answer = obj(obj(obj(result).answers).setup);
      if (
        answer.type === "choice" &&
        answer.choice === "three" &&
        typeof obj(answer.probabilities).three === "number"
      ) {
        return successful;
      }
      return { ok: false, error: "OpenRouter did not return a valid JEV decision." };
    } catch {
      // Public setup errors never include a provider body, request headers, or the key.
      return {
        ok: false,
        error:
          "Could not verify JEV with OpenRouter. Check your key and account credits, or try again.",
      };
    }
  });
  if (!verified.ok) return verified;

  const storage = yield* ElectronSafeStorage.ElectronSafeStorage;
  return yield* storage.encryptString(key).pipe(
    Effect.flatMap((encrypted) =>
      writeFileStringAtomically({ filePath, contents: Buffer.from(encrypted).toString("base64") }),
    ),
    Effect.as({ ok: true } as const),
    Effect.orElseSucceed(() => ({
      ok: false as const,
      error: "Could not save the key in secure desktop storage.",
    })),
  );
});
