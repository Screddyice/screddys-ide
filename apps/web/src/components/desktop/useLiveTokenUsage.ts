import type { UsageProviderKind } from "@t3tools/contracts";
import { useEffect, useEffectEvent } from "react";

import { useUsage } from "../../state/usage";
import { buildDesktopUsageSnapshot } from "./desktopUsageSnapshot";
import { useTokenThroughput } from "./useTokenThroughput";
import { useUsageRange } from "./useUsageRange";

const REFRESH_MS = 60_000;

/** The menu bar's usage report and throughput, re-read every minute while the caller is mounted. */
export function useLiveTokenUsage(plans?: ReadonlyMap<UsageProviderKind, string>) {
  const { range, rollOver } = useUsageRange();
  const { environments, refresh } = useUsage(range.month);
  const snapshot = buildDesktopUsageSnapshot(
    environments,
    range.month.untilDay,
    range.weekStart,
    plans,
  );
  const rate = useTokenThroughput(environments, snapshot?.today.totalTokens ?? null);
  const requestRefresh = useEffectEvent(() => {
    // Midnight or a time zone change moves "today", even while nothing can be read.
    const next = rollOver();
    if (!environments.some((host) => host.canReadDiagnostics && host.isConnected)) return;
    void refresh(next.month).catch(() => {});
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Owns the timer that re-reads usage while the caller is shown, so throughput stays current.
  useEffect(() => {
    const timer = window.setInterval(() => requestRefresh(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

  return { snapshot, rate };
}
