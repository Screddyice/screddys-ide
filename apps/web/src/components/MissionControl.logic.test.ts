import { describe, expect, it } from "vite-plus/test";

import { missionControlThreadView, summarizeRunningAgents } from "./MissionControl.logic";

describe("summarizeRunningAgents", () => {
  it("counts only running rows and pairs each family with today's tokens", () => {
    const rows = [
      { provider: "claude", status: "running" },
      { provider: "claude", status: "running" },
      { provider: "claude", status: "recent" },
      { provider: "openai", status: "completed" },
      { provider: "nebos", status: "running" },
    ] as const;
    const today = [
      { provider: "claude", totalTokens: 1_200_000 },
      { provider: "codex", totalTokens: 50_000 },
    ] as const;
    expect(summarizeRunningAgents(rows, today)).toEqual([
      { provider: "claude", running: 2, todayTokens: 1_200_000 },
      { provider: "openai", running: 0, todayTokens: 50_000 },
      { provider: "nebos", running: 1, todayTokens: null },
    ]);
  });

  it("leaves tokens unknown when no usage report has arrived", () => {
    expect(summarizeRunningAgents([{ provider: "cursor", status: "running" }], null)).toEqual([
      { provider: "cursor", running: 1, todayTokens: null },
    ]);
  });
});

describe("missionControlThreadView", () => {
  it.each([
    ["working", "running"],
    ["preparing", "running"],
    ["ready", "attention"],
    ["approval", "attention"],
    ["failed", "attention"],
    ["settled", null],
    ["waiting", null],
    ["offline", null],
  ] as const)("puts a %s thread under %s", (status, view) => {
    expect(missionControlThreadView(status)).toBe(view);
  });
});
