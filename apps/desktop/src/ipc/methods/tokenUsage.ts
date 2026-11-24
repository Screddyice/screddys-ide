import { DesktopTokenUsageMenuState, type DesktopTokenUsagePeriod } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { formatCount, formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import { Menu, nativeImage, Tray, webContents, type MenuItemConstructorOptions } from "electron";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopAssets from "../../app/DesktopAssets.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import {
  SET_TOKEN_USAGE_MENU_CHANNEL,
  TOKEN_USAGE_MENU_OPEN_ACTION,
  TOKEN_USAGE_MENU_REFRESH_ACTION,
} from "../channels.ts";

interface UsageMenuActions {
  readonly open: () => void;
  readonly refresh: () => void;
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

function usageMenuTemplate(
  { loading, summary }: DesktopTokenUsageMenuState,
  actions: UsageMenuActions,
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
  tray.setToolTip("Screddy Token Usage");
  let previous: string | undefined;
  function update(state: DesktopTokenUsageMenuState) {
    const current = JSON.stringify(state);
    if (current === previous) return;
    tray.setContextMenu(Menu.buildFromTemplate(usageMenuTemplate(state, actions)));
    tray.setTitle(
      state.summary === null ? "" : `${formatTokens(state.summary.today.totalTokens)} tokens`,
    );
    previous = current;
  }
  update(EMPTY_MENU);
  return { update, destroy: () => tray.destroy() };
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
