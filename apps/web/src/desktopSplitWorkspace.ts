import { ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import * as Schema from "effect/Schema";

import { DraftId } from "./composerDraftStore";
import { readLocalStorageValue, writeLocalStorageValue } from "./hooks/useLocalStorage";

const WorkspaceRoute = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("split") }),
  Schema.Struct({ kind: Schema.Literal("server"), threadRef: ScopedThreadRef }),
  Schema.Struct({ kind: Schema.Literal("draft"), draftId: DraftId }),
]);
export type DesktopSplitWorkspaceRoute = typeof WorkspaceRoute.Type;

const Pane = Schema.Union([
  Schema.Struct({ kind: Schema.Literals(["primary", "blank"]) }),
  Schema.Struct({ kind: Schema.Literal("thread"), threadRef: ScopedThreadRef }),
  Schema.Struct({ kind: Schema.Literal("draft"), draftId: DraftId }),
]);
export type DesktopSplitPane = typeof Pane.Type;

const WorkspaceSnapshot = Schema.Struct({ route: WorkspaceRoute, panes: Schema.Array(Pane) });
type DesktopSplitWorkspaceSnapshot = typeof WorkspaceSnapshot.Type;
const StoredWorkspace = Schema.NullOr(WorkspaceSnapshot);
// Layouts saved while the Local Qwen pane existed still load: that pane comes back blank.
const LegacyStoredWorkspace = Schema.NullOr(
  Schema.Struct({
    route: WorkspaceRoute,
    panes: Schema.Array(Schema.Union([Pane, Schema.Struct({ kind: Schema.Literal("qwen") })])),
  }),
);
const storageKey = "screddy:split-workspace:v1";

export function sameDesktopSplitWorkspaceRoute(
  a: DesktopSplitWorkspaceRoute,
  b: DesktopSplitWorkspaceRoute,
): boolean {
  switch (a.kind) {
    case "split":
      return b.kind === "split";
    case "draft":
      return b.kind === "draft" && a.draftId === b.draftId;
    case "server":
      return b.kind === "server" && scopedThreadKey(a.threadRef) === scopedThreadKey(b.threadRef);
  }
}

export function readDesktopSplitWorkspace(): DesktopSplitWorkspaceSnapshot | null {
  const stored = readLocalStorageValue(storageKey, null, LegacyStoredWorkspace);
  if (!stored || stored.panes.length < 2 || stored.panes.length > 4) return null;
  const snapshot: DesktopSplitWorkspaceSnapshot = {
    route: stored.route,
    panes: stored.panes.map((pane) => (pane.kind === "qwen" ? { kind: "blank" } : pane)),
  };
  const primaryCount = snapshot.panes.filter((pane) => pane.kind === "primary").length;
  if (primaryCount !== (snapshot.route.kind === "split" ? 0 : 1)) return null;
  return snapshot;
}

export function saveDesktopSplitWorkspace(snapshot: DesktopSplitWorkspaceSnapshot | null): void {
  writeLocalStorageValue(storageKey, snapshot, null, StoredWorkspace);
}

function desktopSplitWorkspaceHref(snapshot: DesktopSplitWorkspaceSnapshot): string {
  switch (snapshot.route.kind) {
    case "split":
      return `/split?panes=${snapshot.panes.length}`;
    case "draft":
      return `/draft/${encodeURIComponent(snapshot.route.draftId)}`;
    case "server": {
      const { environmentId, threadId } = snapshot.route.threadRef;
      return `/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;
    }
  }
}

let startupRoute: DesktopSplitWorkspaceRoute | null = null;

export function restoreDesktopSplitWorkspaceOnLaunch(
  location: { href: string },
  replace: (href: string) => void,
): void {
  if (location.href !== "/") return;
  const workspace = readDesktopSplitWorkspace();
  if (!workspace) return;
  startupRoute = workspace.route;
  replace(desktopSplitWorkspaceHref(workspace));
}

export function isDesktopSplitWorkspaceStartupRoute(route: DesktopSplitWorkspaceRoute): boolean {
  return startupRoute !== null && sameDesktopSplitWorkspaceRoute(startupRoute, route);
}
