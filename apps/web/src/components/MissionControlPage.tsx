import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { resolveThreadActivityTimestamp } from "@t3tools/client-runtime/state/thread-sort";
import { AuthOrchestrationOperateScope, ProviderDriverKind } from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ActivityIcon,
  ArrowRightIcon,
  CircleAlertIcon,
  FolderPlusIcon,
  HistoryIcon,
  PlusIcon,
  ServerIcon,
} from "lucide-react";
import { useId, useState } from "react";

import { openCommandPalette } from "../commandPaletteBus";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useClientSettings } from "../hooks/useSettings";
import { cn } from "../lib/utils";
import { workspaceAreaProps } from "../lib/workspaceFocus";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useVisibleThreadShells,
} from "../state/entities";
import { useEnvironmentProviders, useEnvironments } from "../state/environments";
import { useEnvironmentsWithScope } from "../state/session";
import { formatDayAwareTimestamp } from "../timestampFormat";
import { SplitThreadButton } from "./chat/SplitThreadButton";
import { ProviderInstanceIcon } from "./chat/ProviderInstanceIcon";
import {
  resolveMissionControlThreadStatus,
  type MissionControlThreadStatus,
} from "./MissionControl.logic";
import { MissionControlAgentActivity } from "./MissionControlAgentActivity.tsx";
import { MissionControlPriorities } from "./MissionControlPriorities.tsx";
import { ProjectFavicon } from "./ProjectFavicon";
import { sortScopedProjectsForSidebar } from "./Sidebar.logic";
import { WorkspacePageHeader } from "./WorkspacePageHeader";
import { Button } from "./ui/button";
import { SidebarInset } from "./ui/sidebar";
import { toastManager } from "./ui/toast";

const threadStatuses = {
  approval: { label: "Approval needed", tone: "text-warning-foreground" },
  input: { label: "Input needed", tone: "text-warning-foreground" },
  request: { label: "Guest request", tone: "text-warning-foreground" },
  preparing: { label: "Setting up", tone: "text-info-foreground" },
  working: { label: "Running", tone: "text-info-foreground" },
  waiting: { label: "Waiting", tone: "text-muted-foreground" },
  failed: { label: "Failed", tone: "text-error-foreground" },
  limited: { label: "Usage limit", tone: "text-warning-foreground" },
  ready: { label: "Ready", tone: "text-muted-foreground" },
  settled: { label: "Settled", tone: "text-muted-foreground" },
  offline: { label: "Disconnected", tone: "text-muted-foreground" },
} satisfies Record<MissionControlThreadStatus, { label: string; tone: string }>;

const runningStatuses = new Set(["preparing", "working"]);
const attentionStatuses = new Set(["approval", "input", "request", "failed", "limited"]);

const views = [
  { id: "recent", title: "Recent threads", empty: "No recent threads.", icon: HistoryIcon },
  { id: "running", title: "Running", empty: "No threads are running.", icon: ActivityIcon },
  {
    id: "attention",
    title: "Needs attention",
    empty: "No threads need attention.",
    icon: CircleAlertIcon,
  },
] as const;

const recentThreadLimit = 8;
const projectLimit = 6;

function projectKey(project: EnvironmentProject) {
  return scopedProjectKey(scopeProjectRef(project.environmentId, project.id));
}

export function MissionControlPage() {
  const [panel, setPanel] = useState<"priorities" | "activity">("priorities");
  const [view, setView] = useState<(typeof views)[number]["id"]>("recent");
  const [showAllProjects, setShowAllProjects] = useState(false);
  const threadListId = useId();
  const projectListId = useId();
  const allProjects = useProjects();
  const threads = useVisibleThreadShells();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const { environments } = useEnvironments();
  const providerSnapshots = useEnvironmentProviders();
  const operable = useEnvironmentsWithScope(environments, AuthOrchestrationOperateScope);
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const startThread = useNewThreadHandler();
  const navigate = useNavigate();

  const environmentById = new Map(environments.map((entry) => [entry.environmentId, entry]));
  const connected = environments.filter(({ connection }) => connection.phase === "connected");
  const availableProjects = allProjects.filter((project) => project.archivedAt == null);
  const projectByKey = new Map(availableProjects.map((project) => [projectKey(project), project]));
  const recent = threads
    .filter((thread) => thread.archivedAt === null && thread.deletedAt === null)
    .map((thread) => {
      const environment = environmentById.get(thread.environmentId);
      const project = projectByKey.get(
        scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
      );
      const status = resolveMissionControlThreadStatus(
        thread,
        environment?.connection.phase === "connected",
      );
      const activity = resolveThreadActivityTimestamp(thread);
      const instance = thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
      const provider = providerSnapshots
        .get(thread.environmentId)
        ?.find((entry) => entry.instanceId === instance);
      return {
        thread,
        project,
        environment,
        status,
        activity,
        provider,
        instance,
        activityMs: activity ? Date.parse(activity) : 0,
      };
    })
    .sort((left, right) => right.activityMs - left.activityMs);
  const running = recent.filter(({ status }) => runningStatuses.has(status));
  const attention = recent.filter(({ status }) => attentionStatuses.has(status));
  const threadViews = { recent: recent.slice(0, recentThreadLimit), running, attention };
  const shown = threadViews[view];
  const activeView = views.find(({ id }) => id === view) ?? views[0];
  const projects = sortScopedProjectsForSidebar(
    availableProjects.filter((project) => !project.isScratch),
    threads,
    "updated_at",
  );
  const projectRows = showAllProjects ? projects : projects.slice(0, projectLimit);
  const startInProject = (project: EnvironmentProject) => {
    void startThread(scopeProjectRef(project.environmentId, project.id)).catch((error: unknown) =>
      toastManager.add({
        type: "error",
        title: "Couldn’t start a new thread",
        description: error instanceof Error ? error.message : "Try again from Mission Control.",
      }),
    );
  };

  return (
    <SidebarInset
      {...workspaceAreaProps("home", 1, "Mission Control")}
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none"
    >
      <WorkspacePageHeader electron className="justify-end">
        <SplitThreadButton
          layout={{
            paneCount: 1,
            setPaneCount: (panes) => {
              if (panes !== 1) void navigate({ to: "/split", search: { panes } });
            },
          }}
        />
      </WorkspacePageHeader>
      <div className="@container scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-5 pt-4 pb-10 @sm:px-7 @xl:pt-7">
          <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4 border-b border-border pb-5">
            <div className="flex min-w-0 items-center gap-3">
              <img src="/icon-192x192.png" alt="" className="size-11 shrink-0 object-contain" />
              <h1 className="text-2xl leading-tight font-semibold tracking-tight @xl:text-3xl">
                Mission Control
              </h1>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" onClick={() => openCommandPalette({ open: "add-project" })}>
                <FolderPlusIcon /> Add project
              </Button>
              <Button onClick={() => openCommandPalette({ open: "new-thread-in" })}>
                <PlusIcon /> New thread
              </Button>
            </div>
          </header>

          <div className="space-y-4">
            <nav aria-label="Mission Control views" className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant={panel === "priorities" ? "secondary" : "outline"}
                aria-pressed={panel === "priorities"}
                onClick={() => setPanel("priorities")}
              >
                Priorities
              </Button>
              <Button
                size="sm"
                variant={panel === "activity" ? "secondary" : "outline"}
                aria-pressed={panel === "activity"}
                onClick={() => setPanel("activity")}
              >
                <ActivityIcon className="size-4" aria-hidden />
                Agent activity
              </Button>
            </nav>
            {panel === "priorities" ? (
              <MissionControlPriorities />
            ) : (
              <MissionControlAgentActivity
                threads={threads}
                projects={allProjects}
                environments={environments}
              />
            )}
          </div>

          <div className="grid grid-cols-1 gap-2 @sm:grid-cols-3">
            {views.map(({ id, title, icon: Icon }) => (
              <button
                key={id}
                type="button"
                aria-pressed={view === id}
                aria-controls={threadListId}
                className={cn(
                  "flex min-w-0 items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring @lg:px-4 @lg:py-3",
                  view === id
                    ? "border-primary/40 bg-primary/8"
                    : "border-border bg-card hover:bg-accent/50",
                )}
                onClick={() => setView(id)}
              >
                <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 text-sm font-medium">{title}</span>
                <span className="font-mono text-sm text-muted-foreground tabular-nums">
                  {threadViews[id].length}
                </span>
              </button>
            ))}
          </div>

          <div className="grid min-w-0 items-start gap-5 @3xl:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
            <section
              aria-label={activeView.title}
              id={threadListId}
              className="min-w-0 rounded-xl border border-border bg-card"
            >
              <h2 className="border-b border-border px-4 py-3 text-sm font-semibold">
                {activeView.title}
              </h2>
              {shown.length > 0 ? (
                <ul className="divide-y divide-border/70">
                  {shown.map(
                    ({ thread, project, environment, status, activity, provider, instance }) => (
                      <li key={scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))}>
                        <Link
                          to="/$environmentId/$threadId"
                          params={{ environmentId: thread.environmentId, threadId: thread.id }}
                          className="flex items-center gap-3 px-4 py-3 outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                        >
                          <ProviderInstanceIcon
                            driverKind={provider?.driver ?? ProviderDriverKind.make(instance)}
                            displayName={provider?.displayName ?? instance}
                            size="compact"
                            className="shrink-0"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium" dir="auto">
                              {thread.title}
                            </span>
                            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                              {[
                                project?.title,
                                environments.length > 1 ? environment?.label : null,
                                activity
                                  ? formatDayAwareTimestamp(activity, timestampFormat)
                                  : null,
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </span>
                          </span>
                          <span className={cn("shrink-0 text-xs", threadStatuses[status].tone)}>
                            {threadStatuses[status].label}
                          </span>
                          <ArrowRightIcon
                            aria-hidden="true"
                            className="size-3.5 shrink-0 text-muted-foreground"
                          />
                        </Link>
                      </li>
                    ),
                  )}
                </ul>
              ) : (
                <p className="px-4 py-5 text-sm text-muted-foreground">
                  {bootstrapped ? activeView.empty : "Loading threads…"}
                </p>
              )}
            </section>

            <section
              aria-label="Projects"
              className="min-w-0 rounded-xl border border-border bg-card"
            >
              <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
                <h2 className="text-sm font-semibold">Projects</h2>
                <span className="font-mono text-xs text-muted-foreground tabular-nums">
                  {projects.length}
                </span>
              </div>
              {projectRows.length > 0 ? (
                <ul id={projectListId} className="divide-y divide-border/70">
                  {projectRows.map((project) => {
                    const environment = environmentById.get(project.environmentId);
                    const canStart =
                      environment?.connection.phase === "connected" &&
                      operable.has(project.environmentId);
                    return (
                      <li key={projectKey(project)} className="flex items-center gap-3 px-4 py-3">
                        <ProjectFavicon project={project} className="size-4" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium" dir="auto">
                            {project.title}
                          </span>
                          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                            {environment && environments.length > 1
                              ? `${environment.label} · `
                              : ""}
                            {project.workspaceRoot}
                          </span>
                        </span>
                        <Button
                          aria-label={`New thread in ${project.title}`}
                          variant="ghost-muted"
                          size="icon-sm"
                          disabled={!canStart}
                          onClick={() => startInProject(project)}
                        >
                          <PlusIcon />
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="px-4 py-5 text-sm text-muted-foreground">
                  {bootstrapped
                    ? "Add a project to start working in a folder."
                    : "Loading projects…"}
                </p>
              )}
              {projects.length > projectLimit ? (
                <div className="border-t border-border px-3 py-2">
                  <Button
                    size="sm"
                    variant="ghost-muted"
                    aria-controls={projectListId}
                    aria-expanded={showAllProjects}
                    onClick={() => setShowAllProjects(!showAllProjects)}
                  >
                    {showAllProjects ? "Show fewer projects" : "Show all projects"}
                  </Button>
                </div>
              ) : null}
            </section>
          </div>

          <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <ServerIcon aria-hidden="true" className="size-3.5" />
              {bootstrapped
                ? `${connected.length} of ${environments.length} environments connected`
                : "Connecting to environments…"}
            </span>
            <Button size="sm" variant="ghost-muted" render={<Link to="/settings/connections" />}>
              Connections <ArrowRightIcon />
            </Button>
          </footer>
        </div>
      </div>
    </SidebarInset>
  );
}
