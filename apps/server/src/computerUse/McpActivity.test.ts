import { describe, expect, it } from "vite-plus/test";

import { makeMcpActivity } from "./McpActivity.ts";

function call(id: number, name: string, args: Record<string, unknown> = {}) {
  return { id, method: "tools/call", params: { name, arguments: args } };
}

function result(id: number, value: Record<string, unknown>) {
  return { id, result: { structuredContent: value } };
}

describe("CuaDriver activity", () => {
  it("ignores initialization and tracks the app from CuaDriver's own observations", () => {
    const activity = makeMcpActivity();
    activity.request({ id: 10, method: "initialize" }, 10);
    activity.request(call(11, "get_guide"), 11);
    expect(activity.current(11)).toBeUndefined();

    activity.request(call(1, "list_windows"), 20);
    expect(activity.current(20)?.application).toBeNull();
    activity.response(
      result(1, { windows: [{ pid: 72, app_name: "Calculator", title: "Private text" }] }),
      25,
    );
    activity.request(call(2, "get_window_state", { pid: 72, window_id: 84 }), 30);
    expect(activity.current(40_000)?.application).toBe("Calculator");
    activity.response(result(2, { pid: 72, app_name: "Calculator", snapshot_id: "s00000001" }), 50);
    activity.request(call(3, "click", { element_token: "s00000001:2" }), 55);
    expect(activity.current(55)?.application).toBe("Calculator");
    activity.response(result(3, { ok: true }), 60);
    expect(activity.current(10_061)).toBeUndefined();
  });

  it("tracks named batch targets and restores the other active call when one completes", () => {
    const activity = makeMcpActivity();
    activity.request(call(1, "run_steps", { app: "Finder", steps: [] }), 10);
    activity.request(call(2, "launch_app", { bundle_id: "com.apple.calculator" }), 20);
    expect(activity.current(21)?.application).toBe("com.apple.calculator");
    activity.response(result(2, { pid: 72, name: "Calculator" }), 25);
    expect(activity.current(26)?.application).toBe("Finder");
    activity.response(result(1, {}), 27);
    activity.request(call(3, "end_session"), 28);
    activity.response(result(3, {}), 29);
    expect(activity.current(29)).toBeUndefined();
  });

  it("drops a cancelled call without leaving the indicator active", () => {
    const activity = makeMcpActivity();
    activity.request(call(1, "get_window_state", { pid: 72, window_id: 84 }), 10);
    expect(activity.current(11)).toBeDefined();
    activity.request({ method: "notifications/cancelled", params: { requestId: 1 } }, 12);
    activity.response(result(1, { app_name: "Calculator" }), 13);
    expect(activity.current(13)).toBeUndefined();
  });

  it("keeps dynamic targets unknown and never uses window titles or script contents as labels", () => {
    const activity = makeMcpActivity();
    activity.request(call(1, "run_script", { script: "private input", app: "invalid" }), 10);
    activity.response(result(1, { title: "private text", result: { app_name: "Untrusted" } }), 11);
    expect(activity.current(11)?.application).toBeNull();
    activity.request(call(2, "get_desktop_state"), 12);
    expect(activity.current(12)?.application).toBe("Desktop");
  });
});
