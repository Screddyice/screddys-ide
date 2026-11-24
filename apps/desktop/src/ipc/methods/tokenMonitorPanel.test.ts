import { describe, expect, it, vi } from "vite-plus/test";

import { makeTokenMonitorPanel, panelClickAction, type PanelWatcher } from "./tokenMonitorPanel.ts";

describe("panelClickAction", () => {
  it("closes the panel when it is showing", () => {
    expect(panelClickAction({ visible: true, hiddenAt: null }, 5_000)).toBe("close");
  });

  it("leaves it closed when this same click just closed it", () => {
    // Token Monitor hides its panel as soon as it loses focus, which a click on the logo causes.
    expect(panelClickAction({ visible: false, hiddenAt: 4_700 }, 5_000)).toBe("none");
  });

  it("opens it otherwise", () => {
    expect(panelClickAction({ visible: false, hiddenAt: null }, 5_000)).toBe("open");
    expect(panelClickAction({ visible: false, hiddenAt: 1_000 }, 5_000)).toBe("open");
  });
});

describe("makeTokenMonitorPanel", () => {
  function setup() {
    let clock = 10_000;
    let emit: (line: string) => void = () => {};
    let exit: () => void = () => {};
    const watcher: PanelWatcher = { kill: vi.fn() };
    const deps = {
      spawnWatcher: vi.fn((onLine: (line: string) => void, onExit: () => void) => {
        emit = onLine;
        exit = onExit;
        return watcher;
      }),
      open: vi.fn(),
      activate: vi.fn(),
      now: () => clock,
    };
    const panel = makeTokenMonitorPanel(deps);
    return {
      panel,
      deps,
      watcher,
      emit: (line: string) => emit(line),
      exit: () => exit(),
      advance: (ms: number) => {
        clock += ms;
      },
    };
  }

  it("notes the app in front before opening Token Monitor, then hands focus back to close", () => {
    const t = setup();
    expect(t.panel.click()).toBe("open");
    expect(t.deps.open).not.toHaveBeenCalled();
    t.emit("front 321");
    expect(t.deps.open).toHaveBeenCalledOnce();
    t.emit("shown");
    t.advance(2_000);
    expect(t.panel.click()).toBe("close");
    expect(t.deps.activate).toHaveBeenCalledExactlyOnceWith(321);
  });

  it("does not reopen the panel that the same click closed", () => {
    const t = setup();
    t.panel.click();
    t.emit("front 321");
    t.emit("shown");
    t.advance(2_000);
    t.emit("hidden");
    t.exit();
    t.advance(150);
    expect(t.panel.click()).toBe("none");
    expect(t.deps.spawnWatcher).toHaveBeenCalledOnce();
    t.advance(2_000);
    expect(t.panel.click()).toBe("open");
    expect(t.deps.spawnWatcher).toHaveBeenCalledTimes(2);
  });

  it("still opens Token Monitor when the watcher cannot start", () => {
    const t = setup();
    t.deps.spawnWatcher.mockReturnValueOnce(null as unknown as PanelWatcher);
    expect(t.panel.click()).toBe("open");
    expect(t.deps.open).toHaveBeenCalledOnce();
  });

  it("stops watching when disposed", () => {
    const t = setup();
    t.panel.click();
    t.panel.dispose();
    expect(t.watcher.kill).toHaveBeenCalledOnce();
  });
});
