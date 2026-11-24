import { describe, expect, it } from "vite-plus/test";

import {
  cursorLiveChats,
  providerStatus,
  turnLogStatus,
  workstreamStatus,
} from "./agentActivity.ts";

describe("Mission Control agent statuses", () => {
  it("preserves reported run states and leaves unknown states as recent", () => {
    expect(providerStatus("RUNNING")).toBe("running");
    // Claude Code reports a session mid-turn as busy.
    expect(providerStatus("busy")).toBe("running");
    expect(providerStatus("WAITING_FOR_BACKGROUND_WORK")).toBe("queued");
    expect(providerStatus("permission")).toBe("needs-input");
    expect(providerStatus("READY")).toBe("completed");
    expect(providerStatus("error")).toBe("failed");
    expect(providerStatus("cancelled")).toBe("stopped");
    expect(providerStatus("idle")).toBe("recent");
  });

  it("shows a pending workstream as running only with a current claim", () => {
    const now = Date.parse("2026-11-17T07:30:00Z");
    expect(workstreamStatus("pending", "2026-11-17T07:20:00Z", now)).toBe("running");
    expect(workstreamStatus("pending", "2026-11-17T07:00:00Z", now)).toBe("queued");
    expect(workstreamStatus("pending", null, now)).toBe("queued");
    expect(workstreamStatus("pending", "2026-11-17T08:00:00Z", now)).toBe("queued");
    expect(workstreamStatus("ok", "2026-11-17T07:20:00Z", now)).toBe("completed");
  });
});

describe("outside agent live state", () => {
  const now = Date.parse("2026-11-24T05:40:00Z");
  const fresh = now - 30_000;
  const codex = (...types: string[]) =>
    types
      .map((type) => JSON.stringify({ type: "event_msg", payload: { type } }))
      .concat(JSON.stringify({ type: "response_item", payload: { type: "message" } }))
      .join("\n");
  const grok = (...events: Array<string | { phase: string }>) =>
    events
      .map((event) =>
        JSON.stringify(
          typeof event === "string" ? { type: event } : { type: "phase_changed", ...event },
        ),
      )
      .join("\n");

  it("reports a Codex session with an unfinished turn as running", () => {
    const open = codex("task_started", "task_complete", "task_started");
    expect(turnLogStatus({ kind: "codex", log: open, lastWriteMs: fresh, now })).toBe("running");
    for (const end of ["task_complete", "turn_aborted"]) {
      const closed = codex("task_started", end);
      expect(turnLogStatus({ kind: "codex", log: closed, lastWriteMs: fresh, now })).toBe("recent");
    }
  });

  it("does not trust a turn marker quoted inside a message", () => {
    const quoted = JSON.stringify({
      type: "response_item",
      payload: { type: "message", text: '{"type":"event_msg","payload":{"type":"task_started"}}' },
    });
    // No marker in this slice: the reader widens the tail, then falls back to recent.
    expect(turnLogStatus({ kind: "codex", log: quoted, lastWriteMs: fresh, now })).toBeNull();
  });

  it("stops calling a session running once its log has gone quiet", () => {
    const open = codex("task_started");
    const stale = now - 11 * 60_000;
    expect(turnLogStatus({ kind: "codex", log: open, lastWriteMs: stale, now })).toBe("recent");
  });

  it("reads Grok Build turns and its permission prompt", () => {
    const status = (log: string) => turnLogStatus({ kind: "grok", log, lastWriteMs: fresh, now });
    expect(status(grok("turn_started", { phase: "streaming_reasoning" }))).toBe("running");
    expect(status(grok("turn_started", { phase: "permission_prompt" }))).toBe("needs-input");
    expect(status(grok("turn_started", { phase: "tool_execution" }, "turn_ended"))).toBe("recent");
    expect(status(grok("mcp_server_connected"))).toBeNull();
  });

  it("marks only the newest Cursor chat in a folder with a live cursor-agent", () => {
    const chats = [
      { id: "old", cwd: "/repo", updated: 1 },
      { id: "new", cwd: "/repo", updated: 2 },
      { id: "other", cwd: "/elsewhere", updated: 3 },
    ];
    expect([...cursorLiveChats(chats, ["/repo"])]).toEqual(["new"]);
    expect(cursorLiveChats(chats, []).size).toBe(0);
  });
});
