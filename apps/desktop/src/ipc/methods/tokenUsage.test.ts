import type { DesktopTokenUsagePeriod, DesktopTokenUsageSummary } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import { usageMenuTemplate, usageTrayTitle, usageTrayTooltip } from "./tokenUsage.ts";

const period = (totalTokens: number): DesktopTokenUsagePeriod => ({
  totalTokens,
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  costUsd: null,
});
const summary = (tokensPerMinute?: number): DesktopTokenUsageSummary => ({
  today: period(2_730_000_000),
  week: period(0),
  month: period(0),
  providers: [],
  records: 0,
  sessions: 0,
  isPartial: false,
  hasUnpricedUsage: false,
  ...(tokensPerMinute === undefined ? {} : { tokensPerMinute }),
});

describe("usageTrayTooltip", () => {
  it("shows today's tokens and, once measured, the throughput", () => {
    expect(usageTrayTooltip({ loading: true, summary: null })).toBe("Screddy Token Usage");
    expect(usageTrayTooltip({ loading: false, summary: summary() })).toBe("2.73B tokens");
    expect(usageTrayTooltip({ loading: false, summary: summary(1_200_000) })).toBe(
      "2.73B tokens · 1.20M/min",
    );
    expect(usageTrayTooltip({ loading: false, summary: summary(0) })).toBe("2.73B tokens · 0/min");
  });
});

describe("usageTrayTitle", () => {
  it("shows today's total beside the logo, then the throughput once it is measured", () => {
    expect(usageTrayTitle({ loading: true, summary: null })).toBe("");
    expect(usageTrayTitle({ loading: false, summary: summary() })).toBe("2.73B");
    expect(usageTrayTitle({ loading: false, summary: summary(1_200_000) })).toBe(
      "2.73B · 1.20M/min",
    );
    expect(usageTrayTitle({ loading: false, summary: summary(0) })).toBe("2.73B · 0/min");
  });
});

describe("usageMenuTemplate", () => {
  it("puts the Token Monitor section above Refresh and Open Usage", () => {
    const actions = { open: () => {}, refresh: () => {} };
    const tokenMonitor = [
      { type: "separator" as const },
      { label: "Token Monitor", enabled: false },
    ];
    const labels = usageMenuTemplate({ loading: false, summary: summary() }, actions, tokenMonitor)
      .slice(-5)
      .map((item) => item.label ?? item.type);
    expect(labels).toEqual([
      "separator",
      "Token Monitor",
      "separator",
      "Refresh",
      "Open Usage in Screddy…",
    ]);
  });
});
