import type {
  UsageAccountConfig,
  UsageAccountProvider,
  UsageProviderKind,
  UsageSource,
  UsageSummary,
} from "@t3tools/contracts";
import { bucketTokens } from "@t3tools/shared/usageMerge";

import { PROVIDER_PRESENTATION } from "./usageProviders";

export const USAGE_ACCOUNT_PROVIDERS: ReadonlyArray<{
  readonly value: UsageAccountProvider;
  readonly label: string;
  /** The folder inside the home that holds the transcripts Screddy reads. */
  readonly folder: string;
  readonly example: string;
}> = [
  { value: "claude", label: "Claude Code", folder: "projects", example: "~/.claude-work" },
  { value: "codex", label: "Codex", folder: "sessions", example: "~/.codex-work" },
  { value: "grok", label: "Grok Build", folder: "sessions", example: "~/.grok-work" },
];

export function usageAccountProviderInfo(provider: UsageAccountProvider) {
  return USAGE_ACCOUNT_PROVIDERS.find((entry) => entry.value === provider)!;
}

/** "~/TeamNebula/team-context" names "team-context"; "~/.claude-backup" names "claude-backup". */
export function defaultUsageAccountLabel(homePath: string): string {
  const trimmed = homePath.trim();
  const name =
    trimmed
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ?? "";
  return name.replace(/^\.+/, "") || trimmed;
}

/** A folder named for Codex or Grok picks that provider; anything else is a Claude home. */
export function guessUsageAccountProvider(homePath: string): UsageAccountProvider {
  const name = defaultUsageAccountLabel(homePath).toLowerCase();
  if (name.includes("codex")) return "codex";
  if (name.includes("grok")) return "grok";
  return "claude";
}

/** A readable id from the label that no existing account uses. */
export function newUsageAccountId(
  label: string,
  existing: Readonly<Record<string, unknown>>,
): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "account";
  let id = base;
  for (let suffix = 2; Object.hasOwn(existing, id); suffix += 1) id = `${base}-${suffix}`;
  return id;
}

/** Why an account can't be saved, or null when it can. */
export function usageAccountProblem(
  draft: Pick<UsageAccountConfig, "provider" | "label" | "homePath">,
  existing: Readonly<Record<string, UsageAccountConfig>>,
): string | null {
  const homePath = draft.homePath.trim();
  const label = draft.label.trim();
  if (homePath === "") return "Choose the account's home folder.";
  if (!homePath.startsWith("/") && !homePath.startsWith("~") && !/^[A-Za-z]:[\\/]/.test(homePath)) {
    return "Use a full path, or one that starts with ~/.";
  }
  if (label === "") return "Give the account a name.";
  const others = Object.values(existing).filter((account) => account.provider === draft.provider);
  const providerLabel = usageAccountProviderInfo(draft.provider).label;
  if (others.some((account) => account.homePath.trim() === homePath)) {
    return `This ${providerLabel} folder is already added.`;
  }
  if (others.some((account) => account.label.trim() === label)) {
    return `Another ${providerLabel} account is already called ${label}.`;
  }
  return null;
}

export interface UsageSourceTotals {
  readonly provider: UsageProviderKind;
  readonly dir: string;
  readonly account: string | undefined;
  readonly status: UsageSource["status"];
  readonly totalTokens: number;
  readonly costUsd: number;
  readonly sessions: number;
}

/** Each folder the server read, with the tokens and cost its transcripts added in the window. */
export function usageSourceTotals(summary: UsageSummary): UsageSourceTotals[] {
  const byDir = new Map<string, { totalTokens: number; costUsd: number }>();
  for (const bucket of summary.buckets) {
    if (bucket.sourcePath === undefined) continue;
    const key = `${bucket.provider}\0${bucket.sourcePath}`;
    const entry = byDir.get(key) ?? { totalTokens: 0, costUsd: 0 };
    entry.totalTokens += bucketTokens(bucket);
    entry.costUsd += bucket.costUsd;
    byDir.set(key, entry);
  }
  return summary.sources.map((source) => {
    const { provider, resolvedHomePath: dir } = source.fingerprint;
    const totals = byDir.get(`${provider}\0${dir}`);
    return {
      provider,
      dir,
      account: source.account,
      status: source.status,
      totalTokens: totals?.totalTokens ?? 0,
      costUsd: totals?.costUsd ?? 0,
      sessions: source.distinctSessions,
    };
  });
}

export type UsageAccountStatus =
  | { readonly kind: "off" }
  | { readonly kind: "pending" }
  | { readonly kind: "missing"; readonly folder: string }
  | { readonly kind: "counting"; readonly totalTokens: number; readonly sessions: number };

/** How the latest usage read saw an account's folder. */
export function usageAccountStatus(
  account: UsageAccountConfig,
  summary: UsageSummary | null,
): UsageAccountStatus {
  if (!account.enabled) return { kind: "off" };
  const source = summary
    ? usageSourceTotals(summary).find(
        (entry) => entry.account === account.label && entry.provider === account.provider,
      )
    : undefined;
  if (source === undefined) return { kind: "pending" };
  if (source.status === "missing") {
    return { kind: "missing", folder: usageAccountProviderInfo(account.provider).folder };
  }
  return { kind: "counting", totalTokens: source.totalTokens, sessions: source.sessions };
}

/** An account's own name, else its home folder ("~/.claude"), else "Cursor account" for a non-folder source. */
export function usageSourceName(
  provider: UsageProviderKind,
  dir: string,
  account: string | undefined,
): string {
  if (account) return account;
  if (!/^(?:[/~]|[A-Za-z]:[\\/])/.test(dir))
    return `${PROVIDER_PRESENTATION[provider].label} account`;
  return dir.replace(/[\\/](?:projects|sessions)$/, "").replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

export interface UsageAccountRow extends UsageSourceTotals {
  readonly key: string;
  readonly name: string;
  readonly environmentLabel: string;
}

/** One row per folder the chosen environments read, busiest first; idle unnamed folders are left out. */
export function usageAccountRows(
  environments: readonly {
    readonly environmentId: string;
    readonly label: string;
    readonly summary: UsageSummary | null;
  }[],
  hiddenProviders: ReadonlySet<UsageProviderKind>,
): UsageAccountRow[] {
  return environments
    .flatMap((environment) =>
      environment.summary === null
        ? []
        : usageSourceTotals(environment.summary)
            .filter(
              (source) =>
                !hiddenProviders.has(source.provider) &&
                (source.totalTokens > 0 || source.account !== undefined),
            )
            .map((source) => ({
              ...source,
              key: `${environment.environmentId}\0${source.provider}\0${source.dir}`,
              name: usageSourceName(source.provider, source.dir, source.account),
              environmentLabel: environment.label,
            })),
    )
    .toSorted((a, b) => b.totalTokens - a.totalTokens);
}
