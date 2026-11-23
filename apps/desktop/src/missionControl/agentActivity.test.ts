import { describe, expect, it } from "vite-plus/test";

import { providerStatus, workstreamStatus } from "./agentActivity.ts";

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
