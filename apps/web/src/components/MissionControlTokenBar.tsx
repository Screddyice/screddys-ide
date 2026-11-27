import { formatTokens } from "@t3tools/shared/usageFormat";

import { useLiveTokenUsage } from "./desktop/useLiveTokenUsage";

/** Today's tokens and the current throughput, from the same usage report as the menu bar. */
export function MissionControlTokenBar() {
  const { snapshot, rate } = useLiveTokenUsage();
  if (!snapshot) return null;
  return (
    <p className="min-w-0 truncate text-xs text-muted-foreground" aria-label="Token usage today">
      <span className="font-medium text-foreground">
        {formatTokens(snapshot.today.totalTokens)}
      </span>{" "}
      tokens today
      <span aria-hidden="true"> · </span>
      {rate === null ? (
        "measuring throughput…"
      ) : (
        <>
          <span className="font-medium text-foreground">{formatTokens(rate)}</span> tokens/min
        </>
      )}
    </p>
  );
}
