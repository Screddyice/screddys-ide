import { UsageDay, type UsageAccountConfig, type UsageSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  defaultUsageAccountLabel,
  guessUsageAccountProvider,
  newUsageAccountId,
  usageAccountProblem,
  usageAccountStatus,
  usageSourceTotals,
} from "./usageAccounts";

const account = (overrides: Partial<UsageAccountConfig> = {}): UsageAccountConfig => ({
  provider: "claude",
  label: "Team Nebula",
  homePath: "~/TeamNebula/team-context",
  enabled: true,
  ...overrides,
});

const totals = (outputTokens: number) => ({
  uncachedInputTokens: 10,
  cachedInputTokens: 100,
  cacheCreationTokens: 0,
  outputTokens,
  reasoningTokens: 0,
});

const source = (dir: string, extra: Partial<UsageSummary["sources"][number]> = {}) => ({
  fingerprint: { hostId: "mac", provider: "claude" as const, resolvedHomePath: dir, volumeId: "1" },
  status: "ok" as const,
  scannedFiles: 1,
  skippedFiles: 0,
  malformedRecords: 0,
  distinctSessions: 3,
  message: null,
  ...extra,
});

const summary: UsageSummary = {
  buckets: [
    {
      day: UsageDay.make("2026-11-26"),
      provider: "claude",
      model: "claude-fable-5",
      sourcePath: "/data/.claude/projects",
      totals: totals(890),
      costUsd: 1,
      cacheSavingsUsd: 0,
      costSource: "litellm",
      records: 1,
      unpricedRecords: 0,
      sessions: 1,
    },
    {
      day: UsageDay.make("2026-11-26"),
      provider: "claude",
      model: "claude-fable-5",
      sourcePath: "/data/TeamNebula/team-context/projects",
      totals: totals(1890),
      costUsd: 2,
      cacheSavingsUsd: 0,
      costSource: "litellm",
      records: 1,
      unpricedRecords: 0,
      sessions: 1,
    },
  ],
  sources: [
    source("/data/.claude/projects"),
    source("/data/TeamNebula/team-context/projects", { account: "Team Nebula" }),
    source("/data/gone/projects", { account: "Gone", status: "missing" }),
  ],
  pricing: { status: "fresh", fetchedAt: null },
  scanDurationMs: 1,
} as unknown as UsageSummary;

describe("usage accounts", () => {
  it("names an account and guesses its provider from the folder", () => {
    expect(defaultUsageAccountLabel("~/TeamNebula/team-context/")).toBe("team-context");
    expect(defaultUsageAccountLabel("/data/.claude-backup")).toBe("claude-backup");
    expect(guessUsageAccountProvider("~/.codex-work")).toBe("codex");
    expect(guessUsageAccountProvider("~/.grok")).toBe("grok");
    expect(guessUsageAccountProvider("~/TeamNebula/team-context")).toBe("claude");
  });

  it("makes a readable id no other account uses", () => {
    expect(newUsageAccountId("Team Nebula", {})).toBe("team-nebula");
    expect(newUsageAccountId("Team Nebula", { "team-nebula": 1, "team-nebula-2": 1 })).toBe(
      "team-nebula-3",
    );
    expect(newUsageAccountId("!!!", {})).toBe("account");
  });

  it("explains what stops an account from saving", () => {
    const existing = { team: account() };
    expect(usageAccountProblem({ ...account(), homePath: " " }, {})).toBe(
      "Choose the account's home folder.",
    );
    expect(usageAccountProblem({ ...account(), homePath: "relative/dir" }, {})).toBe(
      "Use a full path, or one that starts with ~/.",
    );
    expect(usageAccountProblem({ ...account(), label: "" }, {})).toBe("Give the account a name.");
    expect(usageAccountProblem({ ...account(), label: "Other" }, existing)).toBe(
      "This Claude Code folder is already added.",
    );
    expect(usageAccountProblem({ ...account(), homePath: "~/elsewhere" }, existing)).toBe(
      "Another Claude Code account is already called Team Nebula.",
    );
    // The same folder can hold a Codex home too.
    expect(usageAccountProblem({ ...account(), provider: "codex" }, existing)).toBeNull();
  });

  it("totals tokens and cost per folder and reports each account's state", () => {
    expect(usageSourceTotals(summary).map((entry) => [entry.account, entry.totalTokens])).toEqual([
      [undefined, 1000],
      ["Team Nebula", 2000],
      ["Gone", 0],
    ]);
    expect(usageAccountStatus(account(), summary)).toEqual({
      kind: "counting",
      totalTokens: 2000,
      sessions: 3,
    });
    expect(usageAccountStatus(account({ label: "Gone" }), summary)).toEqual({
      kind: "missing",
      folder: "projects",
    });
    expect(usageAccountStatus(account({ enabled: false }), summary)).toEqual({ kind: "off" });
    expect(usageAccountStatus(account({ label: "New" }), summary)).toEqual({ kind: "pending" });
    expect(usageAccountStatus(account(), null)).toEqual({ kind: "pending" });
  });
});
