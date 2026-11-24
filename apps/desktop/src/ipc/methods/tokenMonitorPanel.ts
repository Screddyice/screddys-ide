// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Watches Token Monitor's panel and hands focus back with osascript.
import * as NodeChildProcess from "node:child_process";

import { TOKEN_MONITOR_BUNDLE_ID } from "./tokenMonitorSection.ts";

/** A click this soon after the panel closed is the click that closed it, through focus loss. */
const CLOSED_BY_THIS_CLICK_MS = 800;

export type PanelClick = "open" | "close" | "none";

/** Clicking the SR logo toggles Token Monitor's panel. */
export function panelClickAction(
  { visible, hiddenAt }: { readonly visible: boolean; readonly hiddenAt: number | null },
  now: number,
): PanelClick {
  if (visible) return "close";
  if (hiddenAt !== null && now - hiddenAt < CLOSED_BY_THIS_CLICK_MS) return "none";
  return "open";
}

export interface PanelWatcher {
  readonly kill: () => void;
}

export interface TokenMonitorPanelDeps {
  /** Reports "front <pid>" first, then "shown" and "hidden" as the panel changes. */
  readonly spawnWatcher: (
    onLine: (line: string) => void,
    onExit: () => void,
  ) => PanelWatcher | null;
  readonly open: () => void;
  /** Brings the app with this pid back to the front; Token Monitor then hides its panel. */
  readonly activate: (pid: number) => void;
  readonly now: () => number;
}

/**
 * Token Monitor only treats a click on its own icon as a toggle, and hides its panel whenever it
 * loses focus. So Screddy watches the panel it opened: a click while it shows hands focus back to
 * the app that was in front, and the click that just closed it does not open it again.
 */
export function makeTokenMonitorPanel(deps: TokenMonitorPanelDeps) {
  let visible = false;
  let hiddenAt: number | null = null;
  let frontPid = 0;
  let watcher: PanelWatcher | null = null;
  const markHidden = () => {
    if (visible) hiddenAt = deps.now();
    visible = false;
  };
  return {
    click(): PanelClick {
      const action = panelClickAction({ visible, hiddenAt }, deps.now());
      if (action === "close") deps.activate(frontPid);
      if (action !== "open") return action;
      watcher?.kill();
      hiddenAt = null;
      const current = deps.spawnWatcher(
        (line) => {
          if (line.startsWith("front ")) {
            frontPid = Number(line.slice("front ".length)) || 0;
            deps.open();
          } else if (line === "shown") {
            visible = true;
          } else if (line === "hidden") {
            markHidden();
          }
        },
        () => {
          markHidden();
          if (watcher === current) watcher = null;
        },
      );
      watcher = current;
      if (!current) deps.open();
      return action;
    },
    dispose() {
      watcher?.kill();
      watcher = null;
    },
  };
}

const PANEL_WATCH_SCRIPT = `
ObjC.import("CoreGraphics");
ObjC.import("AppKit");
const out = $.NSFileHandle.fileHandleWithStandardOutput;
const say = (line) => out.writeData($(line + "\\n").dataUsingEncoding($.NSUTF8StringEncoding));
function panelShowing() {
  const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier("${TOKEN_MONITOR_BUNDLE_ID}");
  if (apps.count === 0) return false;
  const pid = apps.objectAtIndex(0).processIdentifier;
  const list = $.CGWindowListCopyWindowInfo(
    $.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements,
    $.kCGNullWindowID,
  );
  $.CFMakeCollectable(list);
  for (let i = 0; i < $.CFArrayGetCount(list); i++) {
    const w = ObjC.castRefToObject($.CFArrayGetValueAtIndex(list, i));
    if (w.objectForKey("kCGWindowOwnerPID").js !== pid) continue;
    const b = ObjC.deepUnwrap(w.objectForKey("kCGWindowBounds"));
    if (b.Width >= 200 && b.Height >= 200) return true;
  }
  return false;
}
function run() {
  const front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  say("front " + (front.isNil() ? 0 : front.processIdentifier));
  let shown = false;
  for (let i = 0; i < 50 && !(shown = panelShowing()); i++) delay(0.1);
  if (!shown) return "";
  say("shown");
  for (let i = 0; i < 18000 && panelShowing(); i++) delay(0.1);
  say("hidden");
  return "";
}`;

/** The real Mac wiring: one osascript process watches while the panel is open. */
export function macTokenMonitorPanelDeps(open: () => void): TokenMonitorPanelDeps {
  return {
    spawnWatcher(onLine, onExit) {
      try {
        const child = NodeChildProcess.spawn("/usr/bin/osascript", [
          "-l",
          "JavaScript",
          "-e",
          PANEL_WATCH_SCRIPT,
        ]);
        let buffered = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          buffered += chunk;
          let newline: number;
          while ((newline = buffered.indexOf("\n")) >= 0) {
            const line = buffered.slice(0, newline).trim();
            if (line) onLine(line);
            buffered = buffered.slice(newline + 1);
          }
        });
        child.on("error", onExit);
        child.on("exit", onExit);
        return { kill: () => child.kill() };
      } catch {
        return null;
      }
    },
    open,
    activate(pid) {
      const script = `ObjC.import("AppKit");
const app = ${pid} > 0 ? $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid}) : null;
if (app && !app.isNil() && String(app.bundleIdentifier.js) !== "${TOKEN_MONITOR_BUNDLE_ID}") app.activateWithOptions(0);
else $.NSWorkspace.sharedWorkspace.launchApplication("Finder");`;
      NodeChildProcess.execFile(
        "/usr/bin/osascript",
        ["-l", "JavaScript", "-e", script],
        { timeout: 5_000 },
        () => {},
      );
    },
    now: () => Date.now(),
  };
}
