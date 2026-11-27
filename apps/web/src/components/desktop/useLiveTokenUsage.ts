import type { UsageProviderKind } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useState } from "react";

import { useUsage } from "../../state/usage";
import { buildDesktopUsageSnapshot, currentUsageRange } from "./desktopUsageSnapshot";
import { useTokenThroughput } from "./useTokenThroughput";

const REFRESH_MS = 60_000;

/** The menu bar's usage report and throughput, re-read every minute while the caller is mounted. */
export function useLiveTokenUsage(plans?: ReadonlyMap<UsageProviderKind, string>) {
  // Held in state: useUsage re-renders whenever its window object changes identity.
  const [range, setRange] = useState(currentUsageRange);
  const { environments, refresh } = useUsage(range.month);
  const snapshot = buildDesktopUsageSnapshot(
    environments,
    range.month.untilDay,
    range.weekStart,
    plans,
  );
  const rate = useTokenThroughput(environments, snapshot?.today.totalTokens ?? null);
  const requestRefresh = useEffectEvent(() => {
    if (!environments.some((host) => host.canReadDiagnostics && host.isConnected)) return;
    const next = currentUsageRange();
    // Midnight or a time zone change moves "today", so the reading follows it on the next read.
    if (
      next.month.untilDay !== range.month.untilDay ||
      next.month.timeZone !== range.month.timeZone
    ) {
      setRange(next);
    }
    void refresh(next.month).catch(() => {});
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Owns the timer that re-reads usage while the caller is shown, so throughput stays current.
  useEffect(() => {
    const timer = window.setInterval(() => requestRefresh(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

  return { snapshot, rate };
}
