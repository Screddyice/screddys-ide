import { scopeProjectRef, scopedProjectKey } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { resolveThreadActivityTimestamp } from "@t3tools/client-runtime/state/thread-sort";
import type {
  MissionControlAgentActivity as AgentActivity,
  MissionControlAgentProvider,
  MissionControlAgentRow,
  MissionControlAgentStatus,
  TimestampFormat,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowUpRightIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useClientSettings } from "../hooks/useSettings";
import { cn } from "../lib/utils";
import { formatDayAwareTimestamp } from "../timestampFormat";
import { useEnvironmentProviders, type EnvironmentPresentation } from "../state/environments";
import { Button } from "./ui/button";

const providerLabels = {
  openai: "OpenAI / Codex",
  claude: "Claude",
  cursor: "Cursor",
  grok: "Grok",
  nebos: "Team Nebula bots",
} satisfies Record<MissionControlAgentProvider, string>;

const statuses = {
  running: ["Running", "text-info-foreground", 0],
  "needs-input": ["Needs input", "text-warning-foreground", 1],
  queued: ["Queued", "text-muted-foreground", 2],
  failed: ["Failed", "text-error-foreground", 3],
  completed: ["Completed", "text-muted-foreground", 3],
  stopped: ["Stopped", "text-muted-foreground", 3],
  recent: ["Recent", "text-muted-foreground", 3],
} as const satisfies Record<MissionControlAgentStatus, readonly [string, string, number]>;

const providers = new Map<string, MissionControlAgentProvider>([
  ["codex", "openai"],
  ["claudeAgent", "claude"],
  ["cursor", "cursor"],
  ["grok", "grok"],
]);

type ActivityRow = MissionControlAgentRow & {
  thread?: Pick<EnvironmentThreadShell, "environmentId" | "id">;
};

function screddyAgentStatus(
  thread: EnvironmentThreadShell,
  connected: boolean,
): MissionControlAgentStatus {
  if (!connected) return "recent";
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return "needs-input";
  const run = thread.latestRun;
  const runtime = thread.runtime;
  const status = runtime?.activeRunId ? runtime.status : run?.status;
  switch (status) {
    case "running":
      return runtime?.activeRunId && !(run?.runId === runtime.activeRunId && run.turnEnded)
        ? "running"
        : "recent";
    case "preparing":
    case "starting":
    case "queued":
    case "waiting":
      return "queued";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
    case "rolled_back":
      return "stopped";
    default:
      return "recent";
  }
}

function AgentRow({ row, timeFormat }: { row: ActivityRow; timeFormat: TimestampFormat }) {
  const [status, tone] = statuses[row.status];
  const metadata = [
    providerLabels[row.provider],
    row.source,
    row.detail,
    row.updatedAt && formatDayAwareTimestamp(row.updatedAt, timeFormat),
  ]
    .filter(Boolean)
    .join(" · ");
  const content = (
    <>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium" dir="auto">
          {row.title}
        </span>
        <span className="mt-1 block truncate text-xs text-muted-foreground" dir="auto">
          {metadata}
        </span>
      </span>
      <span className={cn("shrink-0 text-xs", tone)}>{status}</span>
      {row.url && (
        <ArrowUpRightIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      )}
    </>
  );
  const className = "flex w-full items-center gap-3 px-4 py-3 text-left outline-none";
  const interactive =
    "hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
  const url = row.url;
  return (
    <li>
      {row.thread ? (
        <Link
          to="/$environmentId/$threadId"
          params={{ environmentId: row.thread.environmentId, threadId: row.thread.id }}
          className={cn(className, interactive)}
        >
          {content}
        </Link>
      ) : url ? (
        <button
          type="button"
          className={cn(className, interactive)}
          onClick={() => void window.desktopBridge?.openExternal(url)}
        >
          {content}
        </button>
      ) : (
        <div className={className}>{content}</div>
      )}
    </li>
  );
}

export function MissionControlAgentActivity({
  threads,
  projects,
  environments,
}: {
  threads: readonly EnvironmentThreadShell[];
  projects: readonly EnvironmentProject[];
  environments: readonly EnvironmentPresentation[];
}) {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  const [provider, setProvider] = useState<MissionControlAgentProvider | "all">("all");
  const [activeOnly, setActiveOnly] = useState(false);
  const [limit, setLimit] = useState(18);
  const [revision, setRevision] = useState(0);
  const [feed, setFeed] = useState<{ revision: number; data?: AgentActivity; error: boolean }>();
  const providerSnapshots = useEnvironmentProviders();
  const timeFormat = useClientSettings((settings) => settings.timestampFormat);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Starts and cleans up a read from the desktop account feeds.
  useEffect(() => {
    if (!bridge?.getMissionControlAgentActivity) return;
    let active = true;
    void bridge.getMissionControlAgentActivity(revision > 0).then(
      (data) => {
        if (active) setFeed({ revision, data, error: false });
      },
      () => {
        if (active)
          setFeed((previous) => ({
            revision,
            error: true,
            ...(previous?.data ? { data: previous.data } : {}),
          }));
      },
    );
    return () => {
      active = false;
    };
  }, [bridge, revision]);

  const fetching = Boolean(bridge?.getMissionControlAgentActivity && feed?.revision !== revision);
  const byEnvironment = new Map(
    environments.map((environment) => [environment.environmentId, environment]),
  );
  const byProject = new Map(
    projects.map((project) => [
      scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
      project.title,
    ]),
  );
  const visibleThreads = threads.flatMap((thread): ActivityRow[] => {
    if (thread.deletedAt !== null || thread.archivedAt !== null) return [];
    const instance = thread.runtime?.providerInstanceId ?? thread.providerInstanceId;
    const snapshot = providerSnapshots
      .get(thread.environmentId)
      ?.find((entry) => entry.instanceId === instance);
    const kind = providers.get(snapshot?.driver ?? instance);
    if (!kind) return [];
    const environment = byEnvironment.get(thread.environmentId);
    const connected = environment?.connection.phase === "connected";
    const projectName = byProject.get(
      scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
    );
    return [
      {
        id: `screddy:${thread.environmentId}:${thread.id}`,
        provider: kind,
        source:
          environment && environments.length > 1 ? `Screddy · ${environment.label}` : "Screddy",
        title: thread.title,
        detail: [projectName, connected ? null : "Environment offline"].filter(Boolean).join(" · "),
        status: screddyAgentStatus(thread, connected),
        updatedAt: resolveThreadActivityTimestamp(thread),
        url: null,
        thread,
      },
    ];
  });
  const codexSessions = new Set(
    threads.map((thread) => String(thread.activeProviderThreadId ?? "")),
  );
  const externalRows = (feed?.data?.rows ?? []).filter(
    (row) =>
      !row.id.startsWith("codex-local:") || !codexSessions.has(row.id.slice("codex-local:".length)),
  );
  const allRows = [...visibleThreads, ...externalRows].toSorted(
    (a, b) =>
      statuses[a.status][2] - statuses[b.status][2] ||
      (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") ||
      a.id.localeCompare(b.id),
  );
  const visible = allRows.filter(
    (row) =>
      (provider === "all" || row.provider === provider) &&
      (!activeOnly || statuses[row.status][2] < 3),
  );
  const sourceRows = (feed?.data?.sources ?? []).filter(
    (source) => provider === "all" || provider === source.provider,
  );

  return (
    <section aria-label="Agent activity" className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Agent activity</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Screddy updates live.{" "}
            {feed?.data?.checkedAt
              ? `Account feeds checked at ${new Date(feed.data.checkedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`
              : "Account feeds are snapshots."}
          </p>
        </div>
        {bridge?.getMissionControlAgentActivity && (
          <Button
            variant="outline"
            size="sm"
            disabled={fetching}
            onClick={() => setRevision((value) => value + 1)}
          >
            <RefreshCwIcon className={cn("size-4", fetching && "animate-spin")} />
            Refresh activity
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2" aria-label="Agent provider filters">
        {(["all", ...Object.keys(providerLabels)] as const).map((key) => {
          const id = key as typeof provider;
          return (
            <Button
              key={id}
              size="sm"
              variant={provider === id ? "secondary" : "outline"}
              aria-pressed={provider === id}
              onClick={() => {
                setProvider(id);
                setLimit(18);
              }}
            >
              {id === "all" ? "All agents" : providerLabels[id]}
            </Button>
          );
        })}
        <Button
          size="sm"
          variant={activeOnly ? "secondary" : "outline"}
          aria-pressed={activeOnly}
          onClick={() => {
            setActiveOnly(!activeOnly);
            setLimit(18);
          }}
        >
          Active only
        </Button>
      </div>
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        {visible.length ? (
          <ul className="divide-y divide-border/70">
            {visible.slice(0, limit).map((row) => (
              <AgentRow key={row.id} row={row} timeFormat={timeFormat} />
            ))}
          </ul>
        ) : (
          <p className="px-4 py-6 text-sm text-muted-foreground" role="status">
            {fetching
              ? "Checking account feeds…"
              : activeOnly
                ? "No active runs reported by these sources."
                : "No activity reported by these sources."}
          </p>
        )}
        {visible.length > limit && (
          <Button
            className="m-2"
            variant="ghost"
            size="sm"
            onClick={() => setLimit((count) => count + 18)}
          >
            Show more activity
          </Button>
        )}
      </div>
      {feed?.error && (
        <p role="status" className="text-xs text-warning-foreground">
          The account activity refresh failed.
        </p>
      )}
      {sourceRows.length > 0 && (
        <details
          className="rounded-lg border border-border px-4 py-3 text-sm"
          open={!visible.length}
        >
          <summary className="cursor-pointer">Activity sources and coverage</summary>
          <ul className="mt-3 space-y-2 text-xs text-muted-foreground">
            {sourceRows.map((source) => {
              const url = source.url;
              return (
                <li key={source.label}>
                  {url ? (
                    <button
                      type="button"
                      className="font-medium text-foreground underline underline-offset-2"
                      onClick={() => void window.desktopBridge?.openExternal(url)}
                    >
                      {source.label}
                    </button>
                  ) : (
                    <span className="font-medium text-foreground">{source.label}</span>
                  )}
                  {" · "}
                  {source.coverage === "connected"
                    ? "Connected"
                    : source.coverage === "partial"
                      ? "Partial coverage"
                      : source.coverage === "dashboard"
                        ? "Dashboard link"
                        : "Unavailable"}
                  {source.detail && ` · ${source.detail}`}
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </section>
  );
}
