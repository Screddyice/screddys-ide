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
