import { UsageDay, type UsageSummary } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import "~/index.css";

import { render } from "../../../test/render";
import type { EnvironmentUsageStatus } from "../../state/usage";
import { UsageAccountBreakdown } from "./UsageAccountBreakdown";

const bucket = (sourcePath: string, outputTokens: number) => ({
  day: UsageDay.make("2026-11-26"),
  provider: "claude" as const,
  model: "claude-fable-5",
  sourcePath,
  totals: {
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens,
    reasoningTokens: 0,
  },
  costUsd: outputTokens / 1000,
  cacheSavingsUsd: 0,
  costSource: "litellm" as const,
  records: 1,
  unpricedRecords: 0,
  sessions: 1,
});

const source = (dir: string, extra: object = {}) => ({
  fingerprint: { hostId: "mac", provider: "claude" as const, resolvedHomePath: dir, volumeId: "1" },
  status: "ok" as const,
  scannedFiles: 1,
  skippedFiles: 0,
  malformedRecords: 0,
  distinctSessions: 4,
  message: null,
  ...extra,
});

const environment = (summary: UsageSummary): EnvironmentUsageStatus => ({
  environmentId: "local" as EnvironmentUsageStatus["environmentId"],
  label: "This Mac",
  isPending: false,
  canReadDiagnostics: true,
  isConnected: true,
  error: null,
  summary,
});

it("ranks each account folder by tokens, names added accounts and links to Settings", async () => {
  const summary = {
    buckets: [bucket("/data/.claude/projects", 1000), bucket("/data/team/projects", 3000)],
    sources: [
      source("/data/.claude/projects"),
      source("/data/team/projects", { account: "Team Nebula" }),
      source("/data/gone/projects", { account: "Old laptop", status: "missing" }),
    ],
  } as unknown as UsageSummary;
  await using screen = await render(
    <UsageAccountBreakdown
      environments={[environment(summary)]}
      hiddenProviders={new Set()}
      metric="tokens"
    />,
  );

  await expect.element(screen.getByText("Team Nebula")).toBeVisible();
  // Share sits in a column that narrow windows hide.
  await expect.element(screen.getByText("75.0%")).toBeInTheDocument();
  // Busiest first: the added account's 3K tokens rank above ~/.claude's 1K.
  const text = document.body.textContent ?? "";
  expect(text.indexOf("Team Nebula")).toBeLessThan(text.indexOf("/data/.claude"));
  await expect.element(screen.getByText("Claude Code · folder not found")).toBeVisible();
  await screen.getByRole("button", { name: "Add or manage usage accounts" }).click();
  await expect.poll(() => screen.router?.state.location.pathname).toBe("/settings/providers");
});
