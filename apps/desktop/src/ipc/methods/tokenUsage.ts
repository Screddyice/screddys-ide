// @effect-diagnostics nodeBuiltinImport:off -- Opens the same user's Token Monitor app by bundle id.
import * as NodeChildProcess from "node:child_process";

import { DesktopTokenUsageMenuState, type DesktopTokenUsagePeriod } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { formatCount, formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import { Menu, nativeImage, Tray, webContents, type MenuItemConstructorOptions } from "electron";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import * as DesktopAssets from "../../app/DesktopAssets.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopTokenMonitorPlugin from "../../app/DesktopTokenMonitorPlugin.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import {
  SET_TOKEN_USAGE_MENU_CHANNEL,
  TOKEN_USAGE_MENU_OPEN_ACTION,
  TOKEN_USAGE_MENU_REFRESH_ACTION,
} from "../channels.ts";
import {
  SNAPSHOT_RELATIVE_PATH,
  TOKEN_MONITOR_BUNDLE_ID,
  parseTokenMonitorSnapshot,
  srLogoClickAction,
  tokenMonitorMenuItems,
  type TokenMonitorMenuState,
} from "./tokenMonitorSection.ts";
import { macTokenMonitorPanelDeps, makeTokenMonitorPanel } from "./tokenMonitorPanel.ts";

interface UsageMenuActions {
  readonly open: () => void;
  readonly refresh: () => void;
}

const SNAPSHOT_POLL = "30 seconds";

function openTokenMonitor() {
  NodeChildProcess.execFile(
    "/usr/bin/open",
    ["-b", TOKEN_MONITOR_BUNDLE_ID],
    { timeout: 5_000 },
    () => {},
  );
}

class TokenUsageTrayInitError extends Schema.TaggedError<TokenUsageTrayInitError>()(
  "TokenUsageTrayInitError",
  { cause: Schema.Defect() },
) {}

const EMPTY_MENU: DesktopTokenUsageMenuState = { loading: true, summary: null };

const info = (label: string): MenuItemConstructorOptions => ({ label, enabled: false });

function periodMenu(label: string, usage: DesktopTokenUsagePeriod): MenuItemConstructorOptions {
  return {
    label: `${label} · ${formatTokens(usage.totalTokens)} tokens`,
    submenu: [
      info(`Total tokens  ${formatCount(usage.totalTokens)}`),
      info(`Uncached input  ${formatCount(usage.uncachedInputTokens)}`),
      info(`Cached input  ${formatCount(usage.cachedInputTokens)}`),
      info(`Cache writes  ${formatCount(usage.cacheCreationTokens)}`),
      info(`Output  ${formatCount(usage.outputTokens)}`),
      info(`Reasoning within output  ${formatCount(usage.reasoningTokens)}`),
      ...(usage.costUsd === null ? [] : [info(`Estimated cost  ${formatUsd(usage.costUsd)}`)]),
    ],
  };
}

/** The text beside the menu bar logo: today's token total, nothing until usage has loaded. */
export function usageTrayTitle({ summary }: DesktopTokenUsageMenuState): string {
  return summary === null ? "" : formatTokens(summary.today.totalTokens);
}

/** The menu bar icon's tooltip: today's tokens, then the throughput once it is measured. */
export function usageTrayTooltip({ summary }: DesktopTokenUsageMenuState): string {
  if (summary === null) return "Screddy Token Usage";
  const today = `${formatTokens(summary.today.totalTokens)} tokens`;
  return summary.tokensPerMinute === undefined
    ? today
    : `${today} · ${formatTokens(summary.tokensPerMinute)}/min`;
}

export function usageMenuTemplate(
  { loading, summary }: DesktopTokenUsageMenuState,
  actions: UsageMenuActions,
  tokenMonitor: readonly MenuItemConstructorOptions[] = [],
): MenuItemConstructorOptions[] {
  const template = [info("Screddy Token Usage"), { type: "separator" as const }];
  if (summary === null) {
    template.push(info(loading ? "Checking usage…" : "Usage unavailable"));
  } else {
    if (summary.topModel) {
      template.push(
        info(
          `Most used · ${summary.topModel.label} · ${formatTokens(summary.topModel.totalTokens)} tokens in 30 days`,
        ),
      );
    }
    if (summary.tokensPerMinute !== undefined) {
      template.push(info(`Throughput · ${formatTokens(summary.tokensPerMinute)} tokens/min`));
    }
    template.push(
      periodMenu("Today", summary.today),
      periodMenu("Last 7 days", summary.week),
      periodMenu("Last 30 days", summary.month),
      info(
        `${formatCount(summary.sessions)} sessions · ${formatCount(summary.records)} usage records in 30 days`,
      ),
    );
    if (summary.providers.length > 0) {
      template.push({
        label: "Providers and top models · 30 days",
        submenu: summary.providers.map((provider) => ({
          label: `${provider.label}${provider.plan ? ` · ${provider.plan}` : ""} · ${formatTokens(provider.totalTokens)} tokens`,
          ...(provider.models.length > 0
            ? {
                submenu: provider.models.map((model) =>
                  info(`${model.label} · ${formatTokens(model.totalTokens)} tokens`),
                ),
              }
            : { enabled: false }),
        })),
      });
    }
    if (summary.isPartial) template.push(info("Some usage sources are unavailable or refreshing"));
    if (summary.hasUnpricedUsage) template.push(info("Cost excludes usage without pricing"));
  }
  template.push(
    ...tokenMonitor,
    { type: "separator" },
    { label: "Refresh", click: actions.refresh },
    { label: "Open Usage in Screddy…", click: actions.open },
  );
  return template;
}

function startTokenUsageTray(iconPath: string, actions: UsageMenuActions) {
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  if (icon.isEmpty()) return null;
  const tray = new Tray(icon);
  let usage = EMPTY_MENU;
  let monitor: MenuItemConstructorOptions[] = [];
  let tokenMonitorInstalled = false;
  let menu = Menu.buildFromTemplate(usageMenuTemplate(usage, actions, monitor));
  let previous: string | undefined;
  function render() {
    const current = JSON.stringify([usage, monitor.map((item) => item.label ?? item.type)]);
    if (current === previous) return;
    menu = Menu.buildFromTemplate(usageMenuTemplate(usage, actions, monitor));
    // Today's total sits beside the logo; throughput and the breakdown stay in the tooltip and menu.
    // Fixed-width digits keep the item from shifting as the count changes.
    tray.setTitle(usageTrayTitle(usage), { fontType: "monospacedDigit" });
    tray.setToolTip(usageTrayTooltip(usage));
    previous = current;
  }
  // Clicking the logo again closes the panel it opened.
  const panel = makeTokenMonitorPanel(macTokenMonitorPanelDeps(openTokenMonitor));
  // No setContextMenu: it would take over the left click that opens Token Monitor's panel.
  const onClick = (button: "left" | "right") => () => {
    if (srLogoClickAction(tokenMonitorInstalled, button) === "open-token-monitor") {
      panel.click();
    } else {
      tray.popUpContextMenu(menu);
    }
  };
  tray.on("click", onClick("left"));
  tray.on("right-click", onClick("right"));
  render();
  return {
    update(state: DesktopTokenUsageMenuState) {
      usage = state;
      render();
    },
    setTokenMonitor(state: TokenMonitorMenuState, now: number) {
      tokenMonitorInstalled = state.installed;
      monitor = tokenMonitorMenuItems(state, now, openTokenMonitor);
      render();
    },
    destroy: () => {
      panel.dispose();
      tray.destroy();
    },
  };
}

export const installTokenUsageMenu = Effect.fn("desktop.ipc.installTokenUsageMenu")(function* () {
  if ((yield* HostProcess.Platform) !== "darwin") return;
  const assets = yield* DesktopAssets.DesktopAssets;
  const window = yield* DesktopWindow.DesktopWindow;
  const png = (yield* assets.iconPaths).png;
  if (Option.isNone(png)) return;

  let owner: Electron.WebContents | undefined;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const tray = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        startTokenUsageTray(png.value, {
          open: () => {
            void runPromise(
              window.dispatchMenuAction(TOKEN_USAGE_MENU_OPEN_ACTION).pipe(Effect.ignoreCause),
            );
          },
          refresh: () => {
            void runPromise(
              window
                .dispatchMenuAction(TOKEN_USAGE_MENU_REFRESH_ACTION, {
                  reveal: owner === undefined,
                })
                .pipe(Effect.ignoreCause),
            );
          },
        }),
      catch: (cause) => new TokenUsageTrayInitError({ cause }),
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not create the desktop token usage menu", cause).pipe(
          Effect.as(null),
        ),
      ),
    ),
    (entry) => Effect.sync(() => entry?.destroy()),
  );
  if (tray === null) return;

  // Token Monitor's numbers, from the snapshot its Token Speedometer plug-in writes.
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fs = yield* FileSystem.FileSystem;
  const snapshotPath = environment.path.join(environment.stateDir, ...SNAPSHOT_RELATIVE_PATH);
  const tokenMonitorDir = DesktopTokenMonitorPlugin.tokenMonitorDirectory(environment);
  yield* Effect.gen(function* () {
    const installed = yield* fs.exists(tokenMonitorDir).pipe(Effect.orElseSucceed(() => false));
    const text = installed
      ? yield* fs.readFileString(snapshotPath).pipe(Effect.option)
      : Option.none<string>();
    const snapshot = Option.match(text, { onNone: () => null, onSome: parseTokenMonitorSnapshot });
    tray.setTokenMonitor({ installed, snapshot }, yield* Clock.currentTimeMillis);
  }).pipe(Effect.repeat(Schedule.spaced(SNAPSHOT_POLL)), Effect.forkScoped);

  function clear() {
    unbind();
    tray?.update(EMPTY_MENU);
  }
  const clearOnNavigation = ({
    isSameDocument,
    isMainFrame,
  }: Electron.WebContentsDidStartNavigationEventParams) => {
    if (isMainFrame && !isSameDocument) clear();
  };
  function unbind() {
    owner?.off("destroyed", clear);
    owner?.off("render-process-gone", clear);
    owner?.off("did-start-navigation", clearOnNavigation);
    owner = undefined;
  }
  yield* Effect.addFinalizer(() => Effect.sync(unbind));

  const ipc = yield* DesktopIpc.DesktopIpc;
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: SET_TOKEN_USAGE_MENU_CHANNEL,
      payload: DesktopTokenUsageMenuState,
      result: Schema.Void,
      handler: (state, event) =>
        Effect.sync(() => {
          if (event === undefined) return;
          const sender = webContents.fromId(event.sender.id);
          if (sender === undefined || sender.isDestroyed()) return;
          if (sender !== owner) {
            unbind();
            owner = sender;
            owner.on("destroyed", clear);
            owner.on("render-process-gone", clear);
            owner.on("did-start-navigation", clearOnNavigation);
          }
          tray.update(state);
        }),
    }),
  );
});
