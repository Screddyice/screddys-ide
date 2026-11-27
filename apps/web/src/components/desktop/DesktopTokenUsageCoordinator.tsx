import type { DesktopBridge } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef } from "react";

import { useEnvironmentProviders } from "../../state/environments";
import { useUsage } from "../../state/usage";
import { buildDesktopUsageSnapshot, usagePlans } from "./desktopUsageSnapshot";
import { useTokenThroughput } from "./useTokenThroughput";
import { useUsageRange } from "./useUsageRange";

// One read a minute keeps the menu bar throughput current.
const REFRESH_MS = 60_000;

export function DesktopTokenUsageCoordinator() {
  const bridge = window.desktopBridge;
  if (
    typeof bridge?.setTokenUsageMenu !== "function" ||
    typeof bridge.onTokenUsageMenuAction !== "function"
  )
    return null;
  return (
    <TokenUsagePublisher
      subscribe={bridge.onTokenUsageMenuAction}
      publish={bridge.setTokenUsageMenu}
    />
  );
}

function TokenUsagePublisher({
  subscribe,
  publish,
}: {
  readonly subscribe: NonNullable<DesktopBridge["onTokenUsageMenuAction"]>;
  readonly publish: NonNullable<DesktopBridge["setTokenUsageMenu"]>;
}) {
  const { range, rollOver } = useUsageRange();
  const { environments, isPending, refresh } = useUsage(range.month);
  const plans = usagePlans(useEnvironmentProviders());
  const snapshot = buildDesktopUsageSnapshot(
    environments,
    range.month.untilDay,
    range.weekStart,
    plans,
  );
  const rate = useTokenThroughput(environments, snapshot?.today.totalTokens ?? null);
  const summary = snapshot && rate !== null ? { ...snapshot, tokensPerMinute: rate } : snapshot;
  const busy = useRef(false);
  const navigate = useNavigate();
  const requestRefresh = useEffectEvent(() => {
    // Midnight or a time zone change moves "today", even while nothing can be read.
    const next = rollOver();
    if (busy.current || !environments.some((host) => host.canReadDiagnostics && host.isConnected)) {
      return;
    }
    busy.current = true;
    void refresh(next.month)
      .finally(() => {
        busy.current = false;
      })
      .catch(() => {});
  });
  const openUsage = useEffectEvent(() => void navigate({ to: "/usage" }));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Owns native menu subscriptions and a refresh timer while the renderer is mounted.
  useEffect(() => {
    const unsubscribe = subscribe((action) => {
      if (action === "refresh") requestRefresh();
      if (action === "open") openUsage();
    });
    const timer = window.setInterval(() => requestRefresh(), REFRESH_MS);
    return () => {
      window.clearInterval(timer);
      unsubscribe();
      void publish({ loading: false, summary: null }).catch(() => {});
    };
  }, [subscribe, publish]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Updates the native menu when authenticated usage data changes.
  useEffect(() => {
    void publish({ loading: isPending, summary }).catch(() => {});
  }, [publish, isPending, summary]);

  return null;
}
