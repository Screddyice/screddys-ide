import type { HostAutomation, HostAutomations } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import "~/index.css";

import { render, stubGlobal } from "../../../test/render";
import { HostAutomationsSection } from "./HostAutomationsSection";

const job = (
  fields: Pick<HostAutomation, "id" | "name" | "kind" | "state" | "schedule"> &
    Partial<HostAutomation>,
): HostAutomation => ({
  source: "launchd",
  scope: "user",
  command: "/bin/bash /opt/example/run.sh",
  path: "/opt/example/job.plist",
  ...fields,
});

const bridge = (getHostAutomations: () => Promise<HostAutomations>) =>
  stubGlobal("desktopBridge", {
    getHostAutomations,
    getLocalEnvironmentEnabled: () => true,
    getLocalEnvironmentBootstraps: () => [],
  });

it("lists this Mac's jobs by kind, shows a failure and reads again on Refresh", async () => {
  const getHostAutomations = vi.fn(async (): Promise<HostAutomations> => ({
    available: true,
    checkedAt: "2026-11-27T05:00:00.000Z",
    items: [
      job({
        id: "a",
        name: "com.example.backup",
        kind: "scheduled",
        state: "idle",
        schedule: "Sundays at 03:00",
      }),
      job({
        id: "b",
        name: "Daily Email",
        source: "codex",
        command: null,
        path: "/opt/example/automation.toml",
        kind: "scheduled",
        state: "paused",
        schedule: "Daily at 08:00",
      }),
      job({
        id: "c",
        name: "com.example.server",
        kind: "background",
        state: "running",
        schedule: "Always running",
        detail: "PID 12",
      }),
      job({
        id: "d",
        name: "com.example.login",
        kind: "login",
        state: "failed",
        schedule: "At login",
        detail: "Last exit 78",
      }),
    ],
  }));
  using _bridge = bridge(getHostAutomations);
  await using screen = await render(<HostAutomationsSection />);

  await expect.element(screen.getByText("Scheduled · 2")).toBeVisible();
  await expect.element(screen.getByText("Always running · 1")).toBeVisible();
  await expect.element(screen.getByText("At login · 1")).toBeVisible();
  await expect.element(screen.getByText("Failed · Last exit 78")).toBeVisible();
  await expect.element(screen.getByText("Codex")).toBeVisible();
  await expect.element(screen.getByText("/opt/example/automation.toml")).toBeVisible();
  await expect.element(screen.getByText("On demand", { exact: false })).not.toBeInTheDocument();

  await screen.getByRole("button", { name: "Refresh" }).click();
  await vi.waitFor(() => expect(getHostAutomations).toHaveBeenCalledTimes(2));
});

it("shows nothing where this Mac's jobs are unavailable", async () => {
  using _bridge = bridge(async () => ({ available: false, checkedAt: null, items: [] }));
  await using screen = await render(<HostAutomationsSection />);
  await expect.element(screen.getByText("On this Mac")).not.toBeInTheDocument();
});
