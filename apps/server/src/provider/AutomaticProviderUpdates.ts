import type { ServerProvider } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/sql/SqlClient";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import * as ProviderMaintenanceRunner from "./providerMaintenanceRunner.ts";

const RETRY_DELAY_MS = 24 * 60 * 60 * 1_000;

export function isAutomaticUpdateCandidate(provider: ServerProvider, now: number) {
  const { compatibilityAdvisory, installed, enabled, updateState, versionAdvisory } = provider;
  if (!enabled || !installed || !versionAdvisory?.canUpdate) return false;
  if (versionAdvisory.status !== "behind_latest" || !versionAdvisory.latestVersion) return false;
  const latestStatus = compatibilityAdvisory?.latestVersionStatus;
  if (latestStatus === "broken" || latestStatus === "unsupported") return false;
  if (updateState?.status === "running" || updateState?.status === "queued") return false;
  return (
    (updateState?.status !== "failed" && updateState?.status !== "unchanged") ||
    !updateState.finishedAt ||
    now - Date.parse(updateState.finishedAt) >= RETRY_DELAY_MS
  );
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const background = yield* BackgroundPolicy.BackgroundPolicy;
    const registry = yield* ProviderRegistry.ProviderRegistry;
    const runner = yield* ProviderMaintenanceRunner.ProviderMaintenanceRunner;
    const sql = yield* SqlClient.SqlClient;

    const canRun = Effect.gen(function* () {
      const current = yield* settings.getSettings;
      if (!current.enableProviderUpdateChecks || !current.autoInstallProviderUpdates) return false;
      if (!(yield* background.shouldRunOpportunisticWork)) return false;
      const [state] = yield* sql<{ readonly busy: number }>`
        SELECT
          EXISTS (
            SELECT 1 FROM orchestration_v2_projection_runs
            WHERE status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
          ) OR EXISTS (
            SELECT 1 FROM orchestration_v2_thread_launch_workflows
            WHERE message_committed = 0 AND status NOT IN ('failed', 'rejected', 'cancelled')
          ) AS busy
      `;
      return state?.busy === 0;
    }).pipe(Effect.orElseSucceed(() => false));

    const update = Effect.gen(function* () {
      if (!(yield* canRun)) return;
      const providers = yield* registry.getProviders;
      const now = yield* Clock.currentTimeMillis;
      for (const provider of providers) {
        if (!isAutomaticUpdateCandidate(provider, now)) continue;
        yield* runner
          .updateProvider({
            provider: provider.driver,
            instanceId: provider.instanceId,
            canRunAutomatically: canRun,
          })
          .pipe(Effect.ignoreCause({ log: true }));
      }
    });

    yield* Effect.sleep("1 minute").pipe(
      Effect.andThen(Effect.repeat(update, Schedule.spaced("5 minutes"))),
      Effect.forkScoped,
    );
  }),
);
