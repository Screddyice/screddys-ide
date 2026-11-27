import { formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import type { MenuItemConstructorOptions } from "electron";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * The "Token Monitor" part of the menu under the Screddy logo. Token Monitor is a separate
 * open-source app; the Token Speedometer plug-in Screddy installs into it writes this
 * snapshot (integrations/token-monitor-speedometer/activity.cjs) while it runs.
 */
export const TOKEN_MONITOR_BUNDLE_ID = "com.javis.tokenmonitor";
export const SNAPSHOT_RELATIVE_PATH = ["token-monitor", "snapshot.json"] as const;
/** Older numbers are not shown as current; the plug-in rewrites the file every 30 seconds. */
export const SNAPSHOT_MAX_AGE_MS = 10 * 60_000;
const MAX_LIMIT_ROWS = 8;

const Finite = Schema.Number.check(Schema.isFinite());

const TokenMonitorSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  writtenAt: Finite,
  /** The plug-in has drawn its menu-bar icon; macOS may still hide it, so this is not proof it shows. */
  trayIcon: Schema.Boolean,
  today: Schema.NullOr(
    Schema.Struct({
      totalTokens: Finite,
      knownUsd: Schema.NullOr(Finite),
      costComplete: Schema.Boolean,
    }),
  ),
  limits: Schema.Array(
    Schema.Struct({
      label: Schema.String,
      windows: Schema.Array(Schema.Struct({ label: Schema.String, remainingPercent: Finite })),
    }),
  ),
});
export type TokenMonitorSnapshot = typeof TokenMonitorSnapshot.Type;

const decodeSnapshot = Schema.decodeUnknownOption(Schema.fromJsonString(TokenMonitorSnapshot));

export const parseTokenMonitorSnapshot = (text: string): TokenMonitorSnapshot | null =>
  Option.getOrNull(decodeSnapshot(text));

export interface TokenMonitorMenuState {
  readonly installed: boolean;
  readonly snapshot: TokenMonitorSnapshot | null;
}

const info = (label: string): MenuItemConstructorOptions => ({ label, enabled: false });

/**
 * Screddy's SR logo always stays in the menu bar: Token Monitor's own icon can be hidden by a
 * full menu bar or by macOS settings, and nothing outside it can tell. With Token Monitor
 * installed, a click opens its panel; a right-click opens Screddy's menu.
 */
export const srLogoClickAction = (installed: boolean, button: "left" | "right") =>
  installed && button === "left" ? ("open-token-monitor" as const) : ("menu" as const);

export function tokenMonitorMenuItems(
  { installed, snapshot }: TokenMonitorMenuState,
  now: number,
  open: () => void,
): MenuItemConstructorOptions[] {
  if (!installed) return [];
  const items: MenuItemConstructorOptions[] = [{ type: "separator" }, info("Token Monitor")];
  const fresh =
    snapshot !== null &&
    snapshot.writtenAt <= now &&
    now - snapshot.writtenAt <= SNAPSHOT_MAX_AGE_MS
      ? snapshot
      : null;
  if (fresh === null) {
    items.push(info("No recent numbers from Token Monitor"));
  } else {
    if (fresh.today !== null) {
      const cost =
        fresh.today.knownUsd === null
          ? ""
          : ` · ${formatUsd(fresh.today.knownUsd)}${fresh.today.costComplete ? "" : "+"}`;
      items.push(info(`Today · ${formatTokens(fresh.today.totalTokens)} tokens${cost}`));
    }
    const rows = fresh.limits.flatMap((provider) =>
      provider.windows.map((window) => {
        const left = Math.round(Math.min(100, Math.max(0, window.remainingPercent)));
        return info(`${provider.label} ${window.label} · ${left}% left`);
      }),
    );
    items.push(...rows.slice(0, MAX_LIMIT_ROWS));
  }
  items.push({ label: "Open Token Monitor…", click: open });
  return items;
}
