// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Runs the real plug-in backend against a temporary home.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it, vi } from "vite-plus/test";

import {
  SNAPSHOT_MAX_AGE_MS,
  SNAPSHOT_RELATIVE_PATH,
  parseTokenMonitorSnapshot,
  tokenMonitorMenuItems,
  srLogoClickAction,
} from "./tokenMonitorSection.ts";

const NOW = 1_800_000_000_000;

describe("the Token Speedometer plug-in", () => {
  it("writes a snapshot this menu can read", async () => {
    const plugin = NodeModule.createRequire(import.meta.url)(
      "../../../../../integrations/token-monitor-speedometer/activity.cjs",
    ) as {
      activate: (context: object) => {
        call: (method: string) => Promise<unknown>;
        dispose: () => void;
      };
    };
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "screddy-home-"));
    const previous = process.env.T3CODE_HOME;
    process.env.T3CODE_HOME = home;
    const rows = {
      usage: [{ totalTokens: 1_234, cost: { knownUsd: 1.5, completeness: "partial" } }],
      limits: [{ label: "Claude", windows: [{ displayLabel: "Weekly", usedPercent: 37 }] }],
    };
    const instance = plugin.activate({
      host: {
        call: async (_method: string, query: { resource: keyof typeof rows }) => ({
          availability: "available",
          rows: rows[query.resource],
        }),
      },
    });
    try {
      const file = NodePath.join(home, "userdata", ...SNAPSHOT_RELATIVE_PATH);
      await vi.waitFor(() => expect(NodeFS.existsSync(file)).toBe(true));
      const read = () => parseTokenMonitorSnapshot(NodeFS.readFileSync(file, "utf8"));
      await vi.waitFor(() => expect(read()).not.toBeNull());
      const parsed = read();
      expect(parsed?.today).toEqual({ totalTokens: 1_234, knownUsd: 1.5, costComplete: false });
      expect(parsed?.limits).toEqual([
        { label: "Claude", windows: [{ label: "Weekly", remainingPercent: 63 }] },
      ]);
      expect(parsed?.trayIcon).toBe(false);

      // Token Monitor drawing the speedometer as its menu-bar icon is shared at once.
      await instance.call("trayShown");
      await vi.waitFor(() => expect(read()?.trayIcon).toBe(true));
    } finally {
      instance.dispose();
      if (previous === undefined) delete process.env.T3CODE_HOME;
      else process.env.T3CODE_HOME = previous;
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });
});

const snapshot = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: 1,
    writtenAt: NOW - 30_000,
    trayIcon: true,
    today: { totalTokens: 174_736_292, knownUsd: 48.73, costComplete: true },
    limits: [
      { label: "Claude", windows: [{ label: "Weekly", remainingPercent: 63.4 }] },
      { label: "Grok", windows: [{ label: "Weekly", remainingPercent: 46 }] },
    ],
    ...overrides,
  });

const labels = (items: ReturnType<typeof tokenMonitorMenuItems>) =>
  items.map((item) => (item.type === "separator" ? "---" : item.label));

describe("parseTokenMonitorSnapshot", () => {
  it("reads the snapshot the Token Monitor plug-in writes", () => {
    const parsed = parseTokenMonitorSnapshot(snapshot());
    expect(parsed?.today?.totalTokens).toBe(174_736_292);
    expect(parsed?.limits.map((provider) => provider.label)).toEqual(["Claude", "Grok"]);
  });

  it("rejects anything that is not that snapshot", () => {
    expect(parseTokenMonitorSnapshot("not json")).toBeNull();
    expect(parseTokenMonitorSnapshot(snapshot({ version: 2 }))).toBeNull();
    expect(parseTokenMonitorSnapshot(snapshot({ writtenAt: "yesterday" }))).toBeNull();
    expect(parseTokenMonitorSnapshot(snapshot({ trayIcon: "yes" }))).toBeNull();
    expect(
      parseTokenMonitorSnapshot(
        snapshot({ limits: [{ label: "Claude", windows: [{ label: "Weekly" }] }] }),
      ),
    ).toBeNull();
  });
});

describe("tokenMonitorMenuItems", () => {
  const open = vi.fn();

  it("adds nothing when Token Monitor is not installed", () => {
    expect(
      tokenMonitorMenuItems(
        { installed: false, snapshot: parseTokenMonitorSnapshot(snapshot()) },
        NOW,
        open,
      ),
    ).toEqual([]);
  });

  it("shows today's tokens and cost and every plan window", () => {
    const items = tokenMonitorMenuItems(
      { installed: true, snapshot: parseTokenMonitorSnapshot(snapshot()) },
      NOW,
      open,
    );
    expect(labels(items)).toEqual([
      "---",
      "Token Monitor",
      "Today · 175M tokens · $48.73",
      "Claude Weekly · 63% left",
      "Grok Weekly · 46% left",
      "Open Token Monitor…",
    ]);
    expect(items.filter((item) => item.enabled === false).map((item) => item.label)).toEqual([
      "Token Monitor",
      "Today · 175M tokens · $48.73",
      "Claude Weekly · 63% left",
      "Grok Weekly · 46% left",
    ]);
    items.at(-1)?.click?.(undefined as never, undefined, undefined as never);
    expect(open).toHaveBeenCalledOnce();
  });

  it("marks a partial cost and leaves an unknown cost out", () => {
    const partial = tokenMonitorMenuItems(
      {
        installed: true,
        snapshot: parseTokenMonitorSnapshot(
          snapshot({ today: { totalTokens: 1_200, knownUsd: 3.5, costComplete: false } }),
        ),
      },
      NOW,
      open,
    );
    expect(labels(partial)).toContain("Today · 1.20K tokens · $3.50+");
    const unknown = tokenMonitorMenuItems(
      {
        installed: true,
        snapshot: parseTokenMonitorSnapshot(
          snapshot({ today: { totalTokens: 1_200, knownUsd: null, costComplete: false } }),
        ),
      },
      NOW,
      open,
    );
    expect(labels(unknown)).toContain("Today · 1.20K tokens");
  });

  it("never shows old numbers as current", () => {
    const stale = parseTokenMonitorSnapshot(snapshot({ writtenAt: NOW - SNAPSHOT_MAX_AGE_MS - 1 }));
    for (const state of [
      { installed: true, snapshot: stale },
      { installed: true, snapshot: null },
    ]) {
      expect(labels(tokenMonitorMenuItems(state, NOW, open))).toEqual([
        "---",
        "Token Monitor",
        "No recent numbers from Token Monitor",
        "Open Token Monitor…",
      ]);
    }
  });
});

describe("srLogoClickAction", () => {
  it("opens Token Monitor's panel when the SR logo is clicked and Token Monitor is installed", () => {
    expect(srLogoClickAction(true, "left")).toBe("open-token-monitor");
  });

  it("opens Screddy's menu on a right-click, or on any click without Token Monitor", () => {
    expect(srLogoClickAction(true, "right")).toBe("menu");
    expect(srLogoClickAction(false, "left")).toBe("menu");
    expect(srLogoClickAction(false, "right")).toBe("menu");
  });
});
