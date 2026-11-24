import { formatTokens } from "@t3tools/shared/usageFormat";
import { useEffect, useEffectEvent, useState } from "react";

import { useUsage } from "../state/usage";
import { buildDesktopUsageSnapshot, currentUsageRange } from "./desktop/desktopUsageSnapshot";
import { tokensPerMinute, type TokenSample } from "./MissionControl.logic";

const REFRESH_MS = 60_000;

/** Today's tokens and the current throughput, from the same usage report as the menu bar. */
export function MissionControlTokenBar() {
  // Recomputed each render so "today" rolls over at midnight; same window key as the menu bar.
  const range = currentUsageRange();
  const { environments, refresh } = useUsage(range.month);
  const snapshot = buildDesktopUsageSnapshot(environments, range.month.untilDay, range.weekStart);
  const readAtMs = Math.max(
    0,
    ...environments.map(({ summary }) => (summary ? Date.parse(summary.readAt) : 0)),
  );
  const [samples, setSamples] = useState<{
    readonly previous: TokenSample | null;
    readonly current: TokenSample | null;
  }>({ previous: null, current: null });
  // Each new usage read becomes the current sample and pushes the last one back.
  if (snapshot && readAtMs > 0 && samples.current?.atMs !== readAtMs) {
    setSamples({
      previous: samples.current,
      current: { tokens: snapshot.today.totalTokens, atMs: readAtMs },
    });
  }
  const requestRefresh = useEffectEvent(() => {
    if (!environments.some((host) => host.canReadDiagnostics && host.isConnected)) return;
    void refresh(currentUsageRange().month).catch(() => {});
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Owns the timer that re-reads usage while Mission Control is open, so throughput stays current.
  useEffect(() => {
    const timer = window.setInterval(() => requestRefresh(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

  if (!snapshot) return null;
  const rate = tokensPerMinute(samples.previous, samples.current);
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
