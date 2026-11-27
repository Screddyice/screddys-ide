import { formatCount, formatTokens, formatUsd } from "@t3tools/shared/usageFormat";

import { useEnvironmentProviders } from "../../state/environments";
import { usagePlans } from "../desktop/desktopUsageSnapshot";
import { useLiveTokenUsage } from "../desktop/useLiveTokenUsage";

function Figure({
  label,
  value,
  detail,
}: {
  readonly label: string;
  readonly value: string;
  readonly detail?: string | undefined;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="truncate text-lg font-semibold text-foreground tabular-nums">{value}</span>
      {detail ? <span className="truncate text-xs text-muted-foreground">{detail}</span> : null}
    </div>
  );
}

/** The menu bar's numbers in full: today, throughput, week, 30 days, top model and each plan. */
export function UsageLivePanel() {
  const { snapshot, rate } = useLiveTokenUsage(usagePlans(useEnvironmentProviders()));
  if (!snapshot) return null;
  const { today, topModel } = snapshot;
  return (
    <section aria-label="Usage right now" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-sm font-medium text-foreground">Right now</h2>
        <span className="text-xs text-muted-foreground">
          Same numbers as the menu bar, read every minute
        </span>
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-5">
        <Figure
          label="Today"
          value={formatTokens(today.totalTokens)}
          detail={today.costUsd === null ? "Unpriced" : `${formatUsd(today.costUsd)} API estimate`}
        />
        <Figure
          label="Throughput"
          value={rate === null ? "Measuring…" : `${formatTokens(rate)}/min`}
          detail={rate === null ? "Ready after a minute" : "Over the last minute"}
        />
        <Figure label="This week" value={formatTokens(snapshot.week.totalTokens)} />
        <Figure
          label="Last 30 days"
          value={formatTokens(snapshot.month.totalTokens)}
          detail={`${formatCount(snapshot.sessions)} sessions`}
        />
        <Figure
          label="Top model"
          value={topModel?.label ?? "None yet"}
          detail={topModel ? `${formatTokens(topModel.totalTokens)} tokens in 30 days` : undefined}
        />
      </div>
      <p className="text-xs text-muted-foreground tabular-nums">
        Today: {formatTokens(today.uncachedInputTokens)} input ·{" "}
        {formatTokens(today.cachedInputTokens)} cached · {formatTokens(today.cacheCreationTokens)}{" "}
        cache writes · {formatTokens(today.outputTokens)} output
      </p>
      {snapshot.providers.length > 0 ? (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {snapshot.providers.map((provider) => (
            <li key={provider.label}>
              <span className="text-foreground">{provider.label}</span>
              {provider.plan ? ` (${provider.plan})` : ""} · {formatTokens(provider.totalTokens)} in
              30 days
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
