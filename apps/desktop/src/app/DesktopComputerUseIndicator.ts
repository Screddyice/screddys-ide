// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off -- Native tray callbacks use the same wall clock as the independent bridge.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { Menu, nativeImage, Tray } from "electron";

import {
  decodeActivity,
  DIRECTORY_NAME,
  EXPIRES_AFTER_MS,
} from "@t3tools/shared/ComputerUseActivity";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const ACTIVITY_FILE = /^activity-[0-9a-f-]+\.json$/u;
const CLEANUP_AFTER_MS = 60_000;

async function activeApplications(directory: string): Promise<Array<string | null>> {
  const entries = await NodeFSP.readdir(directory, { withFileTypes: true }).catch(() => []);
  const now = Date.now();
  const activities = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && ACTIVITY_FILE.test(entry.name))
      .map(async (entry) => {
        const path = NodePath.join(directory, entry.name);
        const data = await NodeFSP.readFile(path, "utf8").catch(() => "");
        const activity = decodeActivity(data);
        if (activity === undefined) return;
        const age = now - activity.heartbeatAt;
        if (age > CLEANUP_AFTER_MS) await NodeFSP.rm(path, { force: true }).catch(() => {});
        if (age <= EXPIRES_AFTER_MS) return activity;
      }),
  );
  const applications = activities
    .filter((activity) => activity !== undefined)
    .sort((left, right) => right.startedAt - left.startedAt)
    .map((activity) => activity.application);
  return [...new Set(applications)];
}

function startComputerUseIndicator(stateDir: string, iconPath: string): () => void {
  const icon = nativeImage.createFromPath(iconPath).resize({ height: 18, width: 18 });
  if (icon.isEmpty()) return () => {};
  const directory = NodePath.join(stateDir, DIRECTORY_NAME);
  let tray: Tray | undefined;
  let previous = "";
  let stopped = false;
  let refreshing = false;

  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      const applications = await activeApplications(directory);
      if (stopped) return;
      if (applications.length === 0) {
        tray?.destroy();
        tray = undefined;
        previous = "";
        return;
      }
      const current = JSON.stringify(applications);
      if (current === previous) return;
      tray ??= new Tray(icon);
      tray.setToolTip("Screddy Computer Use");
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: "CuaDriver is active", enabled: false },
          { type: "separator" },
          ...applications.map((application) => ({
            label: application === null ? "Application not reported" : `Using ${application}`,
            enabled: false,
          })),
        ]),
      );
      previous = current;
    } finally {
      refreshing = false;
    }
  }

  const refreshSafely = () => void refresh().catch(() => {});
  const timer = setInterval(refreshSafely, 500).unref();
  refreshSafely();
  return () => {
    stopped = true;
    clearInterval(timer);
    tray?.destroy();
  };
}

export const install = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  if (environment.platform !== "darwin") return;
  const assets = yield* DesktopAssets.DesktopAssets;
  const icons = yield* assets.iconPaths;
  const path = Option.getOrUndefined(icons.png);
  if (path === undefined) return;
  yield* Effect.acquireRelease(
    Effect.sync(() => startComputerUseIndicator(environment.stateDir, path)),
    (stop) => Effect.sync(stop),
  );
});
