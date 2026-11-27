import {
  USAGE_CONTRACT_VERSION,
  type DesktopTokenUsagePeriod,
  type DesktopTokenUsageSummary,
  type UsageProviderKind,
} from "@t3tools/contracts";
import { makeWindow } from "@t3tools/shared/usageFormat";
import { isCompatibleUsageContractVersion, type MergedUsage } from "@t3tools/shared/usageMerge";

import { mergeAnsweredUsage, type EnvironmentUsageStatus } from "../../state/usage";
import { PROVIDER_PRESENTATION } from "../usage/usageProviders";

/** The window the menu bar reports; readers of the same window share one usage fetch. */
export function currentUsageRange() {
  const now = new Date();
  return { month: makeWindow(30, now), weekStart: makeWindow(7, now).sinceDay };
}

function period(usage: MergedUsage): DesktopTokenUsagePeriod {
  return {
    totalTokens: usage.totalTokens,
    uncachedInputTokens: usage.uncachedInputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    costUsd: usage.records === 0 || usage.costQuality.unpricedShare >= 1 ? null : usage.costUsd,
  };
}

const modelLabel = (model: string) => model.replace(/\p{C}/gu, " ").slice(0, 120);

/** "Claude Ultra Subscription" reads as "Ultra" beside the provider's own name; "Grok account" names no plan. */
function planName(authLabel: string): string | null {
  const name = authLabel
    .replace(/\s+subscription$/i, "")
    .replace(/^(claude|chatgpt|codex|cursor|grok|supergrok)\s+/i, "")
    .trim();
  if (/^account$/i.test(name)) return null;
  return (name || authLabel).slice(0, 120);
}

/** Each usage provider's signed-in plan label, from the first environment that reports one. */
export function usagePlans(
  providersByEnvironment: ReadonlyMap<
    unknown,
    readonly { readonly driver: string; readonly auth: { readonly label?: string | undefined } }[]
  >,
): ReadonlyMap<UsageProviderKind, string> {
  const plans = new Map<UsageProviderKind, string>();
  for (const [kind, { driverKind }] of Object.entries(PROVIDER_PRESENTATION)) {
    for (const providers of providersByEnvironment.values()) {
      const label = providers.find((provider) => provider.driver === driverKind)?.auth.label;
      if (label && !plans.has(kind as UsageProviderKind))
        plans.set(kind as UsageProviderKind, label);
    }
  }
  return plans;
}

export function buildDesktopUsageSnapshot(
  environments: readonly EnvironmentUsageStatus[],
  today: string,
  firstDayOfWeek: string,
  plans: ReadonlyMap<UsageProviderKind, string> = new Map(),
): DesktopTokenUsageSummary | null {
  const month = mergeAnsweredUsage(environments);
  const hasReport = environments.some(
    ({ summary }) =>
      summary !== null &&
      isCompatibleUsageContractVersion(summary.contractVersion, USAGE_CONTRACT_VERSION),
  );
  if (!hasReport) return null;
  const dailyUsage = mergeAnsweredUsage(environments, (bucket) => bucket.day === today);
  const week = mergeAnsweredUsage(environments, (bucket) => bucket.day >= firstDayOfWeek);
  const topModel = month.models.toSorted((a, b) => b.totalTokens - a.totalTokens)[0];
  return {
    today: period(dailyUsage),
    week: period(week),
    month: period(month),
    records: month.records,
    sessions: month.sessions,
    isPartial:
      month.contractMismatches.length > 0 ||
      environments.some(
        ({ summary, error, isConnected, isPending }) =>
          !isConnected ||
          error !== null ||
          isPending ||
          summary?.sources.some(
            ({ status, malformedRecords, refreshing }) =>
              status === "partial" || status === "failed" || malformedRecords > 0 || refreshing,
          ),
      ),
    hasUnpricedUsage: month.costQuality.unpricedShare > 0,
    providers: month.providers
      .toSorted((a, b) => b.totalTokens - a.totalTokens)
      .map((provider) => {
        const authLabel = plans.get(provider.provider);
        const plan = authLabel ? planName(authLabel) : null;
        return {
          label: PROVIDER_PRESENTATION[provider.provider].label,
          ...(plan ? { plan } : {}),
          totalTokens: provider.totalTokens,
          models: month.models
            .filter((model) => model.provider === provider.provider)
            .toSorted((a, b) => b.totalTokens - a.totalTokens)
            .slice(0, 5)
            .map((model) => ({ label: modelLabel(model.model), totalTokens: model.totalTokens })),
        };
      }),
    ...(topModel
      ? { topModel: { label: modelLabel(topModel.model), totalTokens: topModel.totalTokens } }
      : {}),
  };
}
