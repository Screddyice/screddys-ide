import type { DesktopBridge } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import "~/index.css";

import { render, stubGlobal } from "../../test/render";
import { MissionControlPage } from "./MissionControlPage";

it("defaults to Top priorities and shows the selected view in the top toolbar", async () => {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  await using _restoreViewport = {
    [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
  };
  await page.viewport(900, 420);
  const getMissionControl = vi.fn<DesktopBridge["getMissionControl"]>().mockResolvedValue({
    configured: true,
    fetchedAt: null,
    mailboxes: [],
    items: [],
    sources: [],
    context: null,
    nextCursor: null,
  });
  const getMissionControlAgentActivity = vi
    .fn<DesktopBridge["getMissionControlAgentActivity"]>()
    .mockResolvedValue({ checkedAt: null, rows: [], sources: [] });
  using _bridge = stubGlobal("desktopBridge", {
    getMissionControl,
    getMissionControlAgentActivity,
    getClientSettings: async () => null,
    getLocalEnvironmentEnabled: () => false,
    getLocalEnvironmentBootstraps: () => [],
  } satisfies Partial<DesktopBridge>);
  await using screen = await render(<MissionControlPage />);
  const selector = screen.getByRole("combobox", { name: "Mission Control view" });
  expect(selector.elements()).toHaveLength(1);
  await expect.element(selector).toHaveTextContent("Top priorities");
  const workspace = screen.getByRole("region", { name: "Mission Control", exact: true }).element();
  expect(selector.element().closest("header")).toBe(workspace.firstElementChild);
  await expect.element(screen.getByRole("heading", { name: "Top priorities" })).toBeVisible();
  expect(getMissionControl).toHaveBeenCalledWith({
    view: "priorities",
    filter: "all",
    refresh: false,
  });
  expect(getMissionControlAgentActivity).not.toHaveBeenCalled();

  const scrollArea = workspace.lastElementChild as HTMLElement;
  scrollArea.scrollTop = scrollArea.scrollHeight;
  expect(scrollArea.scrollTop).toBeGreaterThan(0);
  await selector.click();
  await expect
    .element(page.getByRole("option", { name: "Top priorities" }))
    .toHaveAttribute("aria-selected", "true");
  await page.getByRole("option", { name: "Agent activity" }).click();
  expect(scrollArea.scrollTop).toBe(0);
  await expect.element(selector).toHaveTextContent("Agent activity");
  await expect.element(screen.getByRole("heading", { name: "Agent activity" })).toBeVisible();
  await expect
    .element(screen.getByRole("heading", { name: "Top priorities" }))
    .not.toBeInTheDocument();

  await selector.click();
  await page.getByRole("option", { name: "Top priorities" }).click();
  await expect.element(selector).toHaveTextContent("Top priorities");
  await expect.element(screen.getByRole("heading", { name: "Top priorities" })).toBeVisible();
});
