import { createMemoryHistory } from "@tanstack/react-router";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform (React Compiler over ~4k lines)
// takes 6-11s; importing it here keeps that out of the test's timeout.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  dispatchedCommands,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
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

// Its own file: the app's shell subscription outlives a test, and it must list this thread.
it("saves an existing thread's model pick and keeps the picker usable in a narrow pane", async () => {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  await using _restoreViewport = {
    [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
  };
  await page.viewport(1120, 760);
  const thread = threadWithHistory("thread-model-pick", 1);
  using _environment = installFakeEnvironment([thread], { acceptCommands: true });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByText("Answer 0 for thread-model-pick.")).toBeVisible();

  await page.getByRole("button", { name: "GPT-5.4", exact: true }).click();
  await page.getByRole("option", { name: /GPT-5\.5/ }).click();
  await vi.waitFor(() =>
    expect(
      dispatchedCommands().filter((command) => command.type === "thread.model-selection.set"),
    ).toEqual([
      expect.objectContaining({
        threadId: thread.id,
        modelSelection: expect.objectContaining({ instanceId: "codex", model: "gpt-5.5" }),
      }),
    ]),
  );
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("option", { name: /GPT-5\.5/ })).not.toBeInTheDocument();

  const editor = page.getByTestId("composer-editor").element();
  const shell = editor.closest<HTMLElement>('[data-slot="composer-shell"]')!;
  const body = shell.querySelector<HTMLElement>("[data-chat-composer-body]")!;
  const footer = shell.querySelector<HTMLElement>("[data-chat-composer-footer]")!;
  const actions = footer.querySelector<HTMLElement>('[data-chat-composer-actions="right"]')!;
  const normalPadding = Number.parseFloat(getComputedStyle(body).paddingTop);
  shell.style.width = "200px";

  expect(Number.parseFloat(getComputedStyle(body).paddingTop)).toBeLessThan(normalPadding);
  expect(getComputedStyle(actions).flexWrap).toBe("wrap");
  const placeholder = page.getByText("Ask anything. @ files, $ skills, / commands", {
    exact: true,
  });
  expect(getComputedStyle(placeholder.element()).whiteSpace).toBe("nowrap");
  const footerBounds = footer.getBoundingClientRect();
  const buttons = [...footer.querySelectorAll("button")]
    .filter(
      (button) => getComputedStyle(button).visibility === "visible" && !button.closest("[inert]"),
    )
    .map((button) => button.getBoundingClientRect())
    .filter(({ width, height }) => width > 0 && height > 0);
  expect(buttons.length).toBeGreaterThan(1);
  for (const [index, button] of buttons.entries()) {
    expect(button.left).toBeGreaterThanOrEqual(footerBounds.left);
    expect(button.right).toBeLessThanOrEqual(footerBounds.right);
    expect(
      buttons
        .slice(index + 1)
        .some(
          (other) =>
            Math.min(button.right, other.right) > Math.max(button.left, other.left) + 0.5 &&
            Math.min(button.bottom, other.bottom) > Math.max(button.top, other.top) + 0.5,
        ),
    ).toBe(false);
  }
});
