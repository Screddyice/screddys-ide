import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { SidebarProvider } from "../ui/sidebar";
import { SidebarWorkspaceLinks } from "./SidebarChrome";

it.each(["/", "/automations", "/settings/scheduled-tasks"])(
  "links Automations to its own page with every project and environment (at %s)",
  async (path) => {
    await using screen = await render(
      <SidebarProvider>
        <SidebarWorkspaceLinks showMissionControl />
      </SidebarProvider>,
      { router: path },
    );
    const automations = screen.getByRole("link", { name: "Automations" });
    await expect.element(automations).toHaveAttribute("href", "/automations");
    if (path !== "/") {
      await expect.element(automations).toHaveAttribute("data-active", "true");
    } else {
      await expect
        .element(screen.getByRole("link", { name: "Mission Control" }))
        .toHaveAttribute("data-active", "true");
    }
  },
);

it.each(["/", "/usage"])("lists Usage right under Automations (at %s)", async (path) => {
  await using screen = await render(
    <SidebarProvider>
      <SidebarWorkspaceLinks showMissionControl />
    </SidebarProvider>,
    { router: path },
  );
  const usage = screen.getByRole("link", { name: "Usage" });
  await expect.element(usage).toHaveAttribute("href", "/usage");
  const names = screen
    .getByRole("link")
    .elements()
    .map((link) => link.textContent);
  expect(names).toEqual(["Mission Control", "Automations", "Usage"]);
  if (path === "/usage") await expect.element(usage).toHaveAttribute("data-active", "true");
});
