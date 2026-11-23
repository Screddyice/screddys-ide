import type {
  DesktopBridge,
  MissionControlAgentActivity as AgentActivity,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { MissionControlAgentActivity } from "./MissionControlAgentActivity";

it("shows verified active runs separately from local history and labels dashboard coverage", async () => {
  const feed: AgentActivity = {
    checkedAt: "2026-11-17T07:20:00Z",
    rows: [
      {
        id: "cursor1",
        title: "Recent Cursor session",
        provider: "cursor",
        source: "Cursor on this Mac",
        detail: "Session history",
        status: "recent",
        updatedAt: null,
        url: null,
      },
      {
        id: "codex1",
        title: "Running Codex Cloud task",
        provider: "openai",
        source: "Codex Cloud",
        detail: "",
        status: "running",
        updatedAt: null,
        url: null,
      },
    ],
    sources: [
      {
        provider: "cursor",
        label: "Cursor Cloud",
        coverage: "dashboard",
        detail: "An API key is needed for in-app coverage.",
        url: "https://cursor.com/agents",
      },
    ],
  };
  const bridge = window.desktopBridge;
  window.desktopBridge = {
    ...bridge,
    getMissionControlAgentActivity: vi.fn(async () => feed),
  } as DesktopBridge;
  try {
    await using screen = await render(
      <MissionControlAgentActivity threads={[]} projects={[]} environments={[]} />,
      { router: false },
    );
    await expect.element(screen.getByText("Recent Cursor session")).toBeVisible();
    await screen.getByRole("button", { name: "Active only" }).click();
    await expect.element(screen.getByText("Running Codex Cloud task")).toBeVisible();
    await expect.element(screen.getByText("Recent Cursor session")).not.toBeInTheDocument();
    await screen.getByRole("button", { name: "Cursor", exact: true }).click();
    await expect
      .element(screen.getByText("No active runs reported by these sources."))
      .toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Cursor Cloud" })).toBeVisible();
    await expect.element(screen.getByText(/Dashboard link/)).toBeVisible();
  } finally {
    if (bridge) window.desktopBridge = bridge;
    else Reflect.deleteProperty(window, "desktopBridge");
  }
});
