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
