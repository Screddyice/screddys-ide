import { expect, it, vi } from "vite-plus/test";
import "~/index.css";

import { render } from "../../../test/render";
import { SplitPaneThreadSelector } from "./SplitPaneThreadSelector";

it("names its pane, shows the thread title and links to the open picker", async () => {
  const onToggle = vi.fn();
  await using screen = await render(
    <SplitPaneThreadSelector
      paneNumber={2}
      title="Release notes"
      pickerId="picker-2"
      open
      onToggle={onToggle}
    />,
  );
  const chooser = screen.getByRole("button", { name: "Choose a thread for pane 2" });
  await expect.element(chooser).toHaveTextContent("Release notes");
  await expect.element(chooser).toHaveAttribute("aria-expanded", "true");
  await expect.element(chooser).toHaveAttribute("aria-controls", "picker-2");
  await chooser.click();
  expect(onToggle).toHaveBeenCalledOnce();
});

it("asks for a thread when the pane is empty and its picker is closed", async () => {
  await using screen = await render(
    <SplitPaneThreadSelector
      paneNumber={1}
      title={null}
      pickerId="picker-1"
      open={false}
      onToggle={() => {}}
    />,
  );
  const chooser = screen.getByRole("button", { name: "Choose a thread for pane 1" });
  await expect.element(chooser).toHaveTextContent("Choose a thread");
  await expect.element(chooser).toHaveAttribute("aria-expanded", "false");
  await expect.element(chooser).not.toHaveAttribute("aria-controls");
});
