import {
  USAGE_CONTRACT_VERSION,
  type DesktopTokenUsagePeriod,
  type DesktopTokenUsageSummary,
} from "@t3tools/contracts";
import { isCompatibleUsageContractVersion, type MergedUsage } from "@t3tools/shared/usageMerge";

import { mergeAnsweredUsage, type EnvironmentUsageStatus } from "../../state/usage";
import { PROVIDER_PRESENTATION } from "../usage/usageProviders";

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

export function buildDesktopUsageSnapshot(
  environments: readonly EnvironmentUsageStatus[],
  today: string,
  firstDayOfWeek: string,
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
    providers: month.providers.map((provider) => ({
      label: PROVIDER_PRESENTATION[provider.provider].label,
      totalTokens: provider.totalTokens,
      models: month.models
        .filter((model) => model.provider === provider.provider)
        .toSorted((a, b) => b.totalTokens - a.totalTokens)
        .slice(0, 5)
        .map((model) => ({
          label: model.model.replace(/\p{C}/gu, " ").slice(0, 120),
          totalTokens: model.totalTokens,
        })),
    })),
  };
}
