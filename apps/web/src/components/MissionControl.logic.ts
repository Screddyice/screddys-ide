import type {
  MissionControlAgentProvider,
  MissionControlAgentRow,
  UsageProviderKind,
} from "@t3tools/contracts";

import { resolveSidebarThreadStatus } from "./Sidebar.logic";

export type MissionControlThreadStatus =
  | ReturnType<typeof resolveSidebarThreadStatus>
  | "settled"
  | "offline";

export function resolveMissionControlThreadStatus(
  thread: Parameters<typeof resolveSidebarThreadStatus>[0] & {
    readonly settledOverride: "settled" | "active" | null;
  },
  connected: boolean,
): MissionControlThreadStatus {
  if (thread.settledOverride === "settled") return "settled";
  return connected ? resolveSidebarThreadStatus(thread) : "offline";
}

const runningStatuses: ReadonlySet<MissionControlThreadStatus> = new Set(["preparing", "working"]);
// A finished thread stays the user's move until they settle it.
const attentionStatuses: ReadonlySet<MissionControlThreadStatus> = new Set([
  "approval",
  "input",
  "request",
  "failed",
  "limited",
  "ready",
]);

export function missionControlThreadView(
  status: MissionControlThreadStatus,
): "running" | "attention" | null {
  if (runningStatuses.has(status)) return "running";
  return attentionStatuses.has(status) ? "attention" : null;
}

/** Usage providers that report tokens for each Mission Control agent family. */
const usageProviderByAgent = {
  openai: "codex",
  claude: "claude",
  cursor: "cursor",
  grok: "grok",
} as const satisfies Partial<Record<MissionControlAgentProvider, UsageProviderKind>>;

export interface RunningAgentSummary {
  readonly provider: MissionControlAgentProvider;
  readonly running: number;
  /** Today's tokens from the same usage report as the menu bar; null when none reported. */
  readonly todayTokens: number | null;
}

export function summarizeRunningAgents(
  rows: readonly Pick<MissionControlAgentRow, "provider" | "status">[],
  todayUsage:
    | readonly { readonly provider: UsageProviderKind; readonly totalTokens: number }[]
    | null,
): RunningAgentSummary[] {
  const tokens = new Map(todayUsage?.map((entry) => [entry.provider, entry.totalTokens]));
  const providers: MissionControlAgentProvider[] = ["claude", "openai", "cursor", "grok", "nebos"];
  return providers.flatMap((provider) => {
    const running = rows.filter(
      (row) => row.provider === provider && row.status === "running",
    ).length;
    const kind = provider === "nebos" ? undefined : usageProviderByAgent[provider];
    const todayTokens = kind && todayUsage ? (tokens.get(kind) ?? 0) : null;
    return running > 0 || (todayTokens ?? 0) > 0 ? [{ provider, running, todayTokens }] : [];
  });
}

export interface TokenSample {
  readonly tokens: number;
  readonly atMs: number;
}

/** Tokens added per minute between two reads of today's total; null when the pair cannot say. */
export function tokensPerMinute(
  previous: TokenSample | null,
  current: TokenSample | null,
): number | null {
  if (!previous || !current) return null;
  const minutes = (current.atMs - previous.atMs) / 60_000;
  // Today's total drops at midnight, so a smaller reading is a new day, not a negative rate.
  if (minutes <= 0 || current.tokens < previous.tokens) return null;
  return Math.round((current.tokens - previous.tokens) / minutes);
}

const MIN_THROUGHPUT_GAP_MS = 45_000;
const KEEP_SAMPLES_MS = 5 * 60_000;

/** Adds a read of today's total, keeping the last five minutes; a smaller total is a new day. */
export function addTokenSample(
  samples: readonly TokenSample[],
  sample: TokenSample,
): readonly TokenSample[] {
  const latest = samples.at(-1);
  if (latest !== undefined && sample.tokens < latest.tokens) return [sample];
  return [
    ...samples.filter(({ atMs }) => atMs < sample.atMs && sample.atMs - atMs <= KEEP_SAMPLES_MS),
    sample,
  ];
}

/**
 * Tokens per minute since the newest read at least 45 seconds old. The menu bar, Mission Control
 * and the Usage page each re-read usage every minute, so consecutive reads can be seconds apart.
 */
export function throughputFromSamples(samples: readonly TokenSample[]): number | null {
  const current = samples.at(-1);
  if (current === undefined) return null;
  const baseline = samples.findLast(({ atMs }) => current.atMs - atMs >= MIN_THROUGHPUT_GAP_MS);
  return tokensPerMinute(baseline ?? null, current);
}
