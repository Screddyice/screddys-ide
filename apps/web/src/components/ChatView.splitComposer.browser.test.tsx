import { createMemoryHistory } from "@tanstack/react-router";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";

import { AppRoot } from "~/AppRoot";
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getThemeSnapshot, setAppearanceMode } from "~/hooks/useTheme";
import { getRouter } from "~/router";
import { THEME_APPEARANCE_MODE_STORAGE_KEY } from "~/themePalette";
import {
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

it("uses a shorter composer in all four panes and expands it for multiline drafts", async () => {
  const { appearanceMode } = getThemeSnapshot();
  using _restoreAppearance = { [Symbol.dispose]: () => setAppearanceMode(appearanceMode) };
  setAppearanceMode("light");
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  await using _restoreViewport = {
    [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
  };
  await page.viewport(1512, 980);
  const threads = ["Build", "Review", "Design", "Release"].map((name) =>
    threadWithHistory(name, 3),
  );
  using _environment = installFakeEnvironment(threads, { acceptCommands: true });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${threads[0]!.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, { router: false });

  const primaryEditor = page.getByRole("textbox", { name: "Message Thread Build" });
  await expect.element(primaryEditor).toBeVisible();
  const sidebarFooter = page.elementLocator(
    document.querySelector('[data-slot="sidebar-footer"]')!,
  );
  const workspace = page.elementLocator(document.querySelector('[data-slot="sidebar-inset"]')!);
  const sidebarDarkMode = sidebarFooter.getByRole("button", { name: "Switch to dark mode" });
  expect(sidebarDarkMode.elements()).toHaveLength(1);
  const overlay = (editor: Element) => editor.closest<HTMLElement>("[data-chat-composer-overlay]")!;
  const height = (element: Element) => element.getBoundingClientRect().height;
  const singlePaneHeight = height(overlay(primaryEditor.element()));

  await page.getByRole("button", { name: "Split screen" }).click();
  await page.getByRole("menuitemradio", { name: "4 panes" }).click();
  await sidebarDarkMode.click();
  expect(document.documentElement.classList.contains("dark")).toBe(true);
  expect(localStorage.getItem(THEME_APPEARANCE_MODE_STORAGE_KEY)).toBe("dark");
  await expect
    .element(workspace.getByRole("button", { name: "Switch to light mode" }))
    .toBeVisible();
  for (const [index, thread] of threads.slice(1).entries()) {
    const pane = page.getByRole("region", { name: `Pane ${index + 2}`, exact: true });
    await pane.getByRole("button", { name: /Choose a thread/ }).click();
    await pane.getByRole("button", { name: thread.title, exact: true }).click();
    await expect
      .element(pane.getByRole("textbox", { name: `Message ${thread.title}` }))
      .toBeVisible();
  }

  for (const thread of threads) {
    const editor = page.getByRole("textbox", { name: `Message ${thread.title}` }).element();
    const composer = overlay(editor);
    expect(height(composer)).toBeLessThan(singlePaneHeight - 24);
    const footer = composer.querySelector("[data-chat-composer-footer]")!;
    expect(footer.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      editor.getBoundingClientRect().bottom - 1,
    );
  }

  const compactHeight = height(overlay(primaryEditor.element()));
  await primaryEditor.click();
  await userEvent.keyboard(
    "First line{Shift>}{Enter}{/Shift}Second line{Shift>}{Enter}{/Shift}Third line",
  );
  expect(primaryEditor.element().textContent).toMatch(
    /First line[\s\S]*Second line[\s\S]*Third line/,
  );
  expect(height(overlay(primaryEditor.element()))).toBeGreaterThan(compactHeight + 20);

  await page.getByRole("button", { name: "Split screen" }).click();
  await page.getByRole("menuitemradio", { name: "Single pane" }).click();
  const lightMode = workspace.getByRole("button", { name: "Switch to light mode" });
  await lightMode.click();
  expect(document.documentElement.classList.contains("dark")).toBe(false);
  expect(localStorage.getItem(THEME_APPEARANCE_MODE_STORAGE_KEY)).toBe("light");
  await expect.element(sidebarDarkMode).toBeVisible();
  expect(primaryEditor.element().textContent).toMatch(
    /First line[\s\S]*Second line[\s\S]*Third line/,
  );
});
