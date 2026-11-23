import {
  EnvironmentId,
  USAGE_CONTRACT_VERSION,
  UsageDay,
  type UsageSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildDesktopUsageSnapshot } from "./desktopUsageSnapshot";

const today = UsageDay.make("2026-11-22");
const earlier = UsageDay.make("2026-11-16");
const month = UsageDay.make("2026-11-01");
const summary: UsageSummary = {
  contractVersion: USAGE_CONTRACT_VERSION,
  readAt: "2026-11-22T22:00:00Z",
  timeZone: "America/Los_Angeles",
  sinceDay: month,
  untilDay: today,
  scanDurationMs: 0,
  pricing: { status: "cached", source: "test", fetchedAt: null, knownModels: 1 },
  sources: [
    {
      fingerprint: {
        provider: "codex",
        hostId: "host",
        resolvedHomePath: "/test",
        volumeId: "dev:1",
      },
      status: "ok",
      scannedFiles: 3,
      skippedFiles: 0,
      malformedRecords: 0,
      distinctSessions: 1,
      message: null,
    },
  ],
  buckets: [today, earlier, month].map((day) => ({
    day,
    provider: "codex",
    model: "test-model",
    totals: {
      uncachedInputTokens: 30,
      cachedInputTokens: 15,
      cacheCreationTokens: 5,
      outputTokens: 30,
      reasoningTokens: 10,
    },
    costUsd: 0.5,
    costSource: "modelPriced",
    cacheSavingsUsd: 0,
    records: 1,
    unpricedRecords: 0,
    sessions: 1,
  })),
};

describe("desktop usage menu", () => {
  it("deduplicates paired routes and counts reasoning inside output", () => {
    const read = (id: string) => ({
      environmentId: EnvironmentId.make(id),
      label: id,
      isPending: false,
      canReadDiagnostics: true,
      isConnected: true,
      error: null,
      summary,
    });
    const result = buildDesktopUsageSnapshot(
      [read("mac"), read("alternate-route")],
      today,
      earlier,
    );
    expect(result?.today).toMatchObject({ totalTokens: 80, outputTokens: 30, reasoningTokens: 10 });
    expect(result?.week.totalTokens).toBe(160);
    expect(result?.month.totalTokens).toBe(240);
    expect(result?.month.costUsd).toBe(1.5);
    expect(result?.sessions).toBe(1);
    expect(result?.providers[0]?.models[0]?.label).toBe("test-model");
  });
});
