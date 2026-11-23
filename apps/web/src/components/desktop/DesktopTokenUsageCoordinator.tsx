import type { DesktopBridge } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { useUsage } from "../../state/usage";
import {
  buildDesktopUsageSnapshot,
  currentUsageRange as currentRange,
} from "./desktopUsageSnapshot";

const REFRESH_MS = 5 * 60_000;

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
  const [range, setRange] = useState(currentRange);
  const { environments, isPending, refresh } = useUsage(range.month);
  const snapshot = buildDesktopUsageSnapshot(environments, range.month.untilDay, range.weekStart);
  const busy = useRef(false);
  const navigate = useNavigate();
  const requestRefresh = useEffectEvent(() => {
    if (busy.current || !environments.some((host) => host.canReadDiagnostics && host.isConnected)) {
      return;
    }
    const next = currentRange();
    const windowChanged =
      next.month.untilDay !== range.month.untilDay || next.month.timeZone !== range.month.timeZone;
    if (windowChanged) setRange(next);
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
    void publish({ loading: isPending, summary: snapshot }).catch(() => {});
  }, [publish, isPending, snapshot]);

  return null;
}
