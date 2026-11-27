import { describe, expect, it } from "vite-plus/test";

import {
  addTokenSample,
  throughputFromSamples,
  missionControlThreadView,
  summarizeRunningAgents,
  tokensPerMinute,
} from "./MissionControl.logic";

describe("summarizeRunningAgents", () => {
  it("counts only running rows and pairs each family with today's tokens", () => {
    const rows = [
      { provider: "claude", status: "running" },
      { provider: "claude", status: "running" },
      { provider: "claude", status: "recent" },
      { provider: "openai", status: "completed" },
      { provider: "nebos", status: "running" },
    ] as const;
    const today = [
      { provider: "claude", totalTokens: 1_200_000 },
      { provider: "codex", totalTokens: 50_000 },
    ] as const;
    expect(summarizeRunningAgents(rows, today)).toEqual([
      { provider: "claude", running: 2, todayTokens: 1_200_000 },
      { provider: "openai", running: 0, todayTokens: 50_000 },
      { provider: "nebos", running: 1, todayTokens: null },
    ]);
  });

  it("leaves tokens unknown when no usage report has arrived", () => {
    expect(summarizeRunningAgents([{ provider: "cursor", status: "running" }], null)).toEqual([
      { provider: "cursor", running: 1, todayTokens: null },
    ]);
  });
});

describe("missionControlThreadView", () => {
  it.each([
    ["working", "running"],
    ["preparing", "running"],
    ["ready", "attention"],
    ["approval", "attention"],
    ["failed", "attention"],
    ["settled", null],
    ["waiting", null],
    ["offline", null],
  ] as const)("puts a %s thread under %s", (status, view) => {
    expect(missionControlThreadView(status)).toBe(view);
  });
});

describe("tokensPerMinute", () => {
  const at = (minutes: number) => Date.parse("2026-11-24T05:00:00Z") + minutes * 60_000;

  it("averages the tokens added between two usage reads", () => {
    expect(tokensPerMinute({ tokens: 1_000, atMs: at(0) }, { tokens: 7_000, atMs: at(2) })).toBe(
      3_000,
    );
    expect(tokensPerMinute({ tokens: 1_000, atMs: at(0) }, { tokens: 1_000, atMs: at(5) })).toBe(0);
  });

  it("has no rate without an earlier read, or across midnight when today's total resets", () => {
    expect(tokensPerMinute(null, { tokens: 7_000, atMs: at(2) })).toBeNull();
    expect(
      tokensPerMinute({ tokens: 9_000, atMs: at(0) }, { tokens: 100, atMs: at(2) }),
    ).toBeNull();
    expect(
      tokensPerMinute({ tokens: 1_000, atMs: at(2) }, { tokens: 2_000, atMs: at(2) }),
    ).toBeNull();
  });
});

describe("throughputFromSamples", () => {
  const at = (seconds: number) => Date.parse("2026-11-24T05:00:00Z") + seconds * 1000;
  const reads = (...pairs: [number, number][]) =>
    pairs.reduce<ReturnType<typeof addTokenSample>>(
      (samples, [seconds, tokens]) => addTokenSample(samples, { tokens, atMs: at(seconds) }),
      [],
    );

  it("measures across at least 45 seconds, so reads seconds apart don't read as 0/min", () => {
    // Three readers share the usage report, so reads can land seconds apart.
    expect(throughputFromSamples(reads([0, 1_000], [5, 1_000]))).toBeNull();
    expect(throughputFromSamples(reads([0, 1_000], [55, 4_000], [60, 4_000]))).toBe(3_000);
  });

  it("starts over at midnight and drops reads older than five minutes", () => {
    expect(throughputFromSamples(reads([0, 9_000], [60, 100]))).toBeNull();
    expect(reads([0, 1], [200, 2], [400, 3]).map(({ tokens }) => tokens)).toEqual([2, 3]);
  });
});
