import type { HostAutomation, HostAutomations } from "@t3tools/contracts";
import { RefreshCwIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const groups = [
  ["scheduled", "Scheduled"],
  ["background", "Always running"],
  ["login", "At login"],
  ["on-demand", "On demand"],
] as const satisfies readonly (readonly [HostAutomation["kind"], string])[];

const states: Record<
  HostAutomation["state"],
  readonly [string, "success" | "outline" | "error" | "warning" | "secondary"]
> = {
  running: ["Running", "success"],
  idle: ["Ready", "outline"],
  failed: ["Failed", "error"],
  "not-loaded": ["Not loaded", "warning"],
  paused: ["Paused", "secondary"],
  disabled: ["Disabled", "secondary"],
  unknown: ["System", "outline"],
};

function sourceLabel({ source, scope }: HostAutomation) {
  if (source === "cron") return "Cron";
  if (source === "codex") return "Codex";
  return scope === "system" ? "System launchd" : "Launch agent";
}

function AutomationRow({ item }: { item: HostAutomation }) {
  const [label, variant] = states[item.state];
  return (
    <SettingsRow
      title={
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="break-all">{item.name}</span>
          <Badge variant="outline">{sourceLabel(item)}</Badge>
        </span>
      }
      description={
        <span className="flex min-w-0 flex-col gap-1">
          <span>{item.schedule}</span>
          <Tooltip>
            <TooltipTrigger
              render={
                <code className="truncate font-mono text-xs">{item.command ?? item.path}</code>
              }
            />
            <TooltipPopup variant="code" className="max-w-xl break-all">
              {item.command ? `${item.command} (${item.path})` : item.path}
            </TooltipPopup>
          </Tooltip>
        </span>
      }
      control={
        <Badge variant={variant}>
          {item.detail && item.state === "failed" ? `${label} · ${item.detail}` : label}
        </Badge>
      }
    />
  );
}

/**
 * Everything this Mac runs on a schedule or in the background: launchd jobs, cron lines and Codex
 * automations. Read-only; the desktop app reads them when the page opens and on Refresh.
 */
export function HostAutomationsSection() {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{
    revision: number;
    data?: HostAutomations;
    failed: boolean;
  }>();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Reads this Mac's jobs over desktop IPC and drops a reply that arrives after the page closed.
  useEffect(() => {
    if (!bridge?.getHostAutomations) return;
    let active = true;
    void bridge.getHostAutomations().then(
      (data) => {
        if (active) setResult({ revision, data, failed: false });
      },
      () => {
        if (active)
          setResult((previous) => ({
            revision,
            failed: true,
            ...(previous?.data ? { data: previous.data } : {}),
          }));
      },
    );
    return () => {
      active = false;
    };
  }, [bridge, revision]);
  const loading = result?.revision !== revision;
  const data = result?.data;
  const failed = result?.failed === true && !data;

  if (!bridge?.getHostAutomations || data?.available === false) return null;
  return (
    <SettingsSection
      title="On this Mac"
      variant="plain"
      headerAction={
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={loading}
          onClick={() => setRevision((current) => current + 1)}
        >
          <RefreshCwIcon className={cn("size-3", loading && "animate-spin")} />
          Refresh
        </Button>
      }
    >
      {failed ? (
        <SettingsSection title="Unavailable">
          <SettingsRow title="This Mac's scheduled jobs could not be read." />
        </SettingsSection>
      ) : !data ? (
        <SettingsSection title="Loading">
          <SettingsRow title="Reading launch agents, cron and Codex automations…" />
        </SettingsSection>
      ) : (
        <div className="space-y-6">
          {groups.map(([kind, title]) => {
            const items = data.items.filter((item) => item.kind === kind);
            return items.length ? (
              <SettingsSection key={kind} title={`${title} · ${items.length}`}>
                {items.map((item) => (
                  <AutomationRow key={item.id} item={item} />
                ))}
              </SettingsSection>
            ) : null;
          })}
        </div>
      )}
    </SettingsSection>
  );
}
