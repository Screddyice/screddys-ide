import { formatTokens } from "@t3tools/shared/usageFormat";
import { useEffect, useEffectEvent, useState } from "react";

import { useUsage } from "../state/usage";
import { buildDesktopUsageSnapshot, currentUsageRange } from "./desktop/desktopUsageSnapshot";
import { useTokenThroughput } from "./desktop/useTokenThroughput";

const REFRESH_MS = 60_000;

/** Today's tokens and the current throughput, from the same usage report as the menu bar. */
export function MissionControlTokenBar() {
  // Held in state: useUsage re-renders whenever its window object changes identity.
  const [range, setRange] = useState(currentUsageRange);
  const { environments, refresh } = useUsage(range.month);
  const snapshot = buildDesktopUsageSnapshot(environments, range.month.untilDay, range.weekStart);
  const rate = useTokenThroughput(environments, snapshot?.today.totalTokens ?? null);
  const requestRefresh = useEffectEvent(() => {
    if (!environments.some((host) => host.canReadDiagnostics && host.isConnected)) return;
    const next = currentUsageRange();
    // Midnight or a time zone change moves "today", so the bar follows it on the next read.
    if (
      next.month.untilDay !== range.month.untilDay ||
      next.month.timeZone !== range.month.timeZone
    ) {
      setRange(next);
    }
    void refresh(next.month).catch(() => {});
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Owns the timer that re-reads usage while Mission Control is open, so throughput stays current.
  useEffect(() => {
    const timer = window.setInterval(() => requestRefresh(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

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
