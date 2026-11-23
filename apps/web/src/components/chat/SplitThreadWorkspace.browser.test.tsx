import { EnvironmentId, ProjectId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { use } from "react";
import * as Option from "effect/Option";
import "~/index.css";

import { act, render } from "../../../test/render";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import {
  type DesktopSplitWorkspaceRoute,
  readDesktopSplitWorkspace,
  saveDesktopSplitWorkspace,
} from "../../desktopSplitWorkspace";
import { makeThreadFixture } from "../../test-fixtures";
import { WorkspaceTitlebarControls } from "./PanelLayoutControls";
import { PrimarySplitPaneMoveContext, SplitPaneMoveHandle } from "./SplitPaneMoveHandle";
import { SplitThreadWorkspace } from "./SplitThreadWorkspace";
import {
  dropThreadContext,
  endThreadContextDrag,
  moveThreadContextDrag,
} from "./threadContextDrag";

const fixtures = vi.hoisted(() => ({
  titles: ["Build", "Review", "Design", "Release"],
}));
const projectRef = {
  environmentId: EnvironmentId.make("environment-test"),
  projectId: ProjectId.make("project-test"),
};
const draftId = DraftId.make("split-pane-test-draft");
const newThreadId = ThreadId.make("split-pane-test-thread");

vi.mock("../../state/entities", () => ({
  readThreadShell: ({ threadId }: ScopedThreadRef) =>
    fixtures.titles.includes(threadId)
      ? makeThreadFixture({ id: threadId, title: threadId })
      : null,
  useVisibleThreadShells: () =>
    fixtures.titles.map((title) => makeThreadFixture({ id: ThreadId.make(title), title })),
  useQuietThreadShell: () => null,
  useAnyEnvironmentHiding: () => false,
  useHiddenThreadKeys: () => new Set(),
  useProjects: () => [
    { id: projectRef.projectId, environmentId: projectRef.environmentId, title: "Workspace" },
  ],
}));
vi.mock("../../state/shell", () => ({
  useEnvironmentShellStatus: () => "live",
}));
vi.mock("../../state/threads", () => ({
  useEnvironmentThread: () => ({ data: Option.none(), status: "empty" }),
  useOpenThreadFamily: () => undefined,
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [{ environmentId: projectRef.environmentId, connection: { phase: "connected" } }],
  }),
}));
vi.mock("../../state/session", () => ({
  useEnvironmentsWithScope: () => new Set([projectRef.environmentId]),
}));
vi.mock("../../hooks/useHandleNewThread", () => ({
  useNewThreadHandler: () => async () => {
    useComposerDraftStore
      .getState()
      .createIndependentDraft("project-test", projectRef, draftId, newThreadId, {});
    return { draftId, threadId: newThreadId };
  },
}));

vi.mock("../ChatView", () => ({
  default: ({ threadId, routeKind }: { threadId: string; routeKind: string }) => (
    <textarea aria-label={`Message ${threadId}`} data-route-kind={routeKind} />
  ),
}));

vi.mock("./AppearanceToggleButton", () => ({
  AppearanceToggleButton: () => null,
}));

it("selects four distinct threads and retains the remaining panes when one closes", async () => {
  await using screen = await render(<SplitThreadWorkspace standalone initialPaneCount={2} />);
  await screen.getByRole("button", { name: "Split screen" }).click();
  await page.getByRole("menuitemradio", { name: "4 panes" }).click();

  await screen.getByRole("button", { name: "Choose a thread for pane 1" }).click();
  await expect.element(screen.getByRole("group", { name: "Threads for pane 1" })).toBeVisible();
  await screen.getByRole("button", { name: "Choose a thread for pane 2" }).click();
  await expect.element(screen.getByRole("group", { name: "Threads for pane 2" })).toBeVisible();
  await expect
    .element(screen.getByRole("group", { name: "Threads for pane 1" }))
    .not.toBeInTheDocument();

  for (const [index, title] of fixtures.titles.entries()) {
    const pane = screen.getByRole("region", { name: `Pane ${index + 1}`, exact: true });
    await pane.getByRole("button", { name: /Choose a thread/ }).click();
    if (index > 0) {
      await expect
        .element(pane.getByRole("button", { name: "Build", exact: true }))
        .not.toBeInTheDocument();
    }
    await pane.getByRole("textbox", { name: "Search threads" }).fill(title);
    await pane.getByRole("button", { name: title, exact: true }).click();
    await expect.element(pane.getByRole("textbox", { name: `Message ${title}` })).toBeVisible();
  }

  await expect.element(screen.getByRole("textbox", { name: /^Message / })).toHaveLength(4);
  await screen.getByRole("button", { name: "Close pane 2" }).click();
  await expect.element(screen.getByRole("textbox", { name: /^Message / })).toHaveLength(3);
  await expect.element(screen.getByRole("textbox", { name: "Message Release" })).toBeVisible();
});

it("starts and promotes a new thread inside the selected pane", async () => {
  await using screen = await render(<SplitThreadWorkspace standalone initialPaneCount={2} />);
  const first = screen.getByRole("region", { name: "Pane 1", exact: true });
  const second = screen.getByRole("region", { name: "Pane 2", exact: true });
  await first.getByRole("button", { name: /Choose a thread/ }).click();
  await first.getByRole("button", { name: "Build", exact: true }).click();
  await second.getByRole("button", { name: /Choose a thread/ }).click();
  await second.getByRole("button", { name: "New thread", exact: true }).click();
  await second.getByRole("button", { name: "Workspace", exact: true }).click();
  const composer = second.getByRole("textbox", { name: `Message ${newThreadId}` });
  await expect.element(composer).toHaveAttribute("data-route-kind", "draft");

  const node = composer.element();
  await act(() => {
    const store = useComposerDraftStore.getState();
    store.markDraftThreadPromoting(draftId, {
      environmentId: projectRef.environmentId,
      threadId: newThreadId,
    });
    store.finalizePromotedDraftThread(draftId);
  });
  await expect.element(composer).toHaveAttribute("data-route-kind", "server");
  expect(composer.element()).toBe(node);
  await expect.element(first.getByRole("textbox", { name: "Message Build" })).toBeVisible();
  expect(screen.router?.state.location.pathname).toBe("/");
});

function PrimaryChatForMoveTest() {
  const move = use(PrimarySplitPaneMoveContext);
  return (
    <>
      {move && <SplitPaneMoveHandle move={move} title="Build" />}
      <textarea aria-label="Message Build" />
    </>
  );
}

it("restores ordered panes and independent draft IDs and clears the layout when closed", async () => {
  const prior = readDesktopSplitWorkspace();
  using _restoreStorage = { [Symbol.dispose]: () => saveDesktopSplitWorkspace(prior) };
  const build = { environmentId: projectRef.environmentId, threadId: ThreadId.make("Build") };
  const review = { environmentId: projectRef.environmentId, threadId: ThreadId.make("Review") };
  const route = { kind: "server", threadRef: build } satisfies DesktopSplitWorkspaceRoute;
  const restoredDraftId = DraftId.make("restored-split-pane-draft");
  const restoredDraftThreadId = ThreadId.make("restored-split-pane-thread");
  useComposerDraftStore
    .getState()
    .createIndependentDraft("project-test", projectRef, restoredDraftId, restoredDraftThreadId, {});
  saveDesktopSplitWorkspace({
    route,
    panes: [
      { kind: "thread", threadRef: review },
      { kind: "primary" },
      { kind: "blank" },
      { kind: "draft", draftId: restoredDraftId },
    ],
  });
  await using screen = await render(
    <div className="flex h-dvh min-w-0 flex-col">
      <SplitThreadWorkspace currentThread={build} persistenceRoute={route}>
        <PrimaryChatForMoveTest />
      </SplitThreadWorkspace>
    </div>,
  );
  await expect
    .element(
      screen
        .getByRole("region", { name: "Pane 1" })
        .getByRole("textbox", { name: "Message Review" }),
    )
    .toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Move pane 2", exact: true }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("region", { name: "Pane 3" }).getByText("Drag a thread here"))
    .toBeVisible();
  await expect
    .element(
      screen
        .getByRole("region", { name: "Pane 4" })
        .getByRole("textbox", { name: `Message ${restoredDraftThreadId}` }),
    )
    .toHaveAttribute("data-route-kind", "draft");
  await screen.getByRole("button", { name: "Split screen" }).click();
  await page.getByRole("menuitemradio", { name: "Single pane" }).click();
  await expect.poll(readDesktopSplitWorkspace).toBeNull();
  await expect.element(screen.getByRole("textbox", { name: "Message Build" })).toBeVisible();
});

it("moves mounted chats and their drafts through occupied and blank panes", async () => {
  const build = { environmentId: projectRef.environmentId, threadId: ThreadId.make("Build") };
  await using screen = await render(
    <div className="flex h-dvh min-w-0 flex-col">
      <SplitThreadWorkspace currentThread={build} initialPaneCount={3}>
        <PrimaryChatForMoveTest />
      </SplitThreadWorkspace>
    </div>,
  );
  await screen.getByRole("button", { name: "Choose a thread for pane 2" }).click();
  await screen.getByRole("button", { name: "Review", exact: true }).click();
  const primary = screen.getByRole("textbox", { name: "Message Build" });
  const review = screen.getByRole("textbox", { name: "Message Review" });
  await primary.fill("Primary draft");
  await review.fill("Review draft");
  const primaryNode = primary.element();
  const reviewNode = review.element();

  const reviewGrip = screen.getByRole("button", { name: "Move pane 2", exact: true });
  await reviewGrip.click();
  await page.getByRole("button", { name: "Swap with pane 1" }).click();
  const pane1 = screen.getByRole("region", { name: "Pane 1", exact: true });
  await expect.element(pane1.getByRole("textbox", { name: "Message Review" })).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Move pane 2", exact: true }))
    .toBeVisible();
  expect(primary.element()).toBe(primaryNode);
  expect(review.element()).toBe(reviewNode);

  await screen.getByRole("button", { name: "Move pane 1", exact: true }).click();
  await page.getByRole("button", { name: "Move to pane 3" }).click();
  const pane3 = screen.getByRole("region", { name: "Pane 3", exact: true });
  await expect.element(pane3.getByRole("textbox", { name: "Message Review" })).toBeVisible();
  await expect.element(pane1.getByText("Drag a thread here")).toBeVisible();
  expect(review.element()).toBe(reviewNode);
  await expect.element(review).toHaveValue("Review draft");
  await expect.element(primary).toHaveValue("Primary draft");
  expect(screen.router?.state.location.pathname).toBe("/");

  await screen.getByRole("button", { name: "Split screen" }).click();
  await page.getByRole("menuitemradio", { name: "Single pane" }).click();
  await expect.element(pane3).not.toBeInTheDocument();
  expect(primary.element()).toBe(primaryNode);
});

it("keeps split thread controls clear of the window toolbar at narrow and wide widths", async () => {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  await using _restoreViewport = {
    [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
  };
  await page.viewport(400, 360);
  await using screen = await render(
    <div className="flex h-dvh min-w-0 flex-col">
      <SplitThreadWorkspace initialPaneCount={2}>
        <WorkspaceTitlebarControls
          showMaximizeControl={false}
          rightPanelOpen={false}
          animationsActive={false}
          maximized={false}
          onToggleMaximized={() => {}}
        >
          <button type="button">Window panel control</button>
        </WorkspaceTitlebarControls>
        <div aria-label="Primary chat">Primary chat</div>
      </SplitThreadWorkspace>
    </div>,
  );
  const control = screen.getByRole("button", { name: "Window panel control" });
  const pane = screen.getByRole("region", { name: "Pane 2" });
  const chooser = pane.getByRole("button", { name: "Choose a thread for pane 2" });
  const close = pane.getByRole("button", { name: "Close pane 2" });
  const bounds = () => ({
    toolbar: control.element().getBoundingClientRect(),
    chooser: chooser.element().getBoundingClientRect(),
    close: close.element().getBoundingClientRect(),
  });

  expect(bounds().chooser.top).toBeGreaterThanOrEqual(bounds().toolbar.bottom);
  expect(bounds().close.right).toBeLessThanOrEqual(window.innerWidth);
  await chooser.click();
  await pane.getByRole("textbox", { name: "Search threads" }).fill("Review");
  await pane.getByRole("button", { name: "Review", exact: true }).click();
  await expect.element(pane.getByRole("textbox", { name: "Message Review" })).toBeVisible();

  await page.viewport(900, 600);
  await expect.poll(() => bounds().chooser.left).toBeGreaterThan(400);
  expect(bounds().chooser.top).toBeGreaterThanOrEqual(bounds().toolbar.bottom);
  expect(bounds().chooser.right).toBeLessThan(bounds().close.left);
  await close.click();
  await expect.element(pane).not.toBeInTheDocument();
});

it("resizes shared columns and rows and keeps the same pane elements", async () => {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  await using _restoreViewport = {
    [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
  };
  await page.viewport(1000, 720);
  await using screen = await render(
    <div className="flex h-dvh min-w-0 flex-col">
      <SplitThreadWorkspace standalone initialPaneCount={3} />
    </div>,
  );
  const pane = (number: number) =>
    screen.getByRole("region", { name: `Pane ${number}`, exact: true }).element();
  const top = pane(1);
  const left = pane(2);
  const right = pane(3);
  const widths = screen.getByRole("separator", { name: "Resize pane widths" });
  const rows = screen.getByRole("separator", { name: "Resize pane rows 1 and 2" });
  const bounds = (element: Element) => element.getBoundingClientRect();
  function drag(handle: Element, target: Element, dx: number, dy: number) {
    const rect = bounds(handle);
    const targetRect = bounds(target);
    const sourcePosition = { x: rect.width / 4, y: rect.height / 2 };
    return userEvent.dragAndDrop(handle, target, {
      sourcePosition,
      targetPosition: {
        x: rect.x + sourcePosition.x + dx - targetRect.x,
        y: rect.y + sourcePosition.y + dy - targetRect.y,
      },
    });
  }

  const initialLeft = bounds(left).width;
  const initialTop = bounds(top).height;
  expect(bounds(widths.element()).x).toBeCloseTo(bounds(left).right - 4, 0);
  expect(bounds(widths.element()).top).toBe(bounds(left).top);
  expect(bounds(rows.element()).y).toBeCloseTo(bounds(top).bottom - 4, 0);
  await drag(widths.element(), right, 80, 0);
  expect(bounds(left).width).toBeCloseTo(initialLeft + 80, 0);
  expect(bounds(top).height).toBe(initialTop);
  await drag(rows.element(), top, 0, -64);
  expect(bounds(top).height).toBeCloseTo(initialTop - 64, 0);
  expect(bounds(left).width).toBeCloseTo(initialLeft + 80, 0);
  await drag(rows.element(), left, 0, 64);
  expect(bounds(top).height).toBeCloseTo(initialTop, 0);
  await drag(widths.element(), left, -80, 0);
  expect(bounds(left).width).toBeCloseTo(initialLeft, 0);
  await drag(widths.element(), right, bounds(right).width - 10, 0);
  expect(bounds(right).width).toBeGreaterThanOrEqual(215);

  await page.viewport(400, 740);
  await expect.element(widths).not.toBeInTheDocument();
  await expect.element(rows).toBeVisible();
  const stackedInitial = bounds(top).height;
  await drag(rows.element(), left, 0, 46);
  expect(bounds(top).height).toBeCloseTo(stackedInitial + 46, 0);
  expect(pane(2)).toBe(left);
  expect(pane(3)).toBe(right);
});

it.each([
  { axis: "x", handleName: "Resize pane widths", dimension: "width" },
  { axis: "y", handleName: "Resize pane rows 1 and 2", dimension: "height" },
] as const)(
  "regrabs the $axis divider after a release over another pane",
  async ({ axis, handleName, dimension }) => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    await using _restoreViewport = {
      [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
    };
    await page.viewport(1000, 720);
    await using screen = await render(
      <div className="flex h-dvh min-w-0 flex-col">
        <SplitThreadWorkspace standalone initialPaneCount={4} />
      </div>,
    );
    const first = screen.getByRole("region", { name: "Pane 1", exact: true }).element();
    const next = screen
      .getByRole("region", { name: axis === "x" ? "Pane 2" : "Pane 3", exact: true })
      .element();
    const handle = screen.getByRole("separator", { name: handleName }).element();
    // The macOS input trace delivered move and release outside the divider
    // without activating the pointer capture requested during pointerdown.
    using _capture = vi.spyOn(handle, "setPointerCapture").mockImplementation(() => {});
    const initial = first.getBoundingClientRect()[dimension];

    async function drag(delta: number, destination: Element) {
      const rect = handle.getBoundingClientRect();
      const clientX = rect.x + rect.width / 2;
      const clientY = rect.y + rect.height / 2;
      const pointer = { bubbles: true, cancelable: true, isPrimary: true, pointerId: 1 };
      await act(() => {
        handle.dispatchEvent(
          new PointerEvent("pointerdown", { ...pointer, buttons: 1, clientX, clientY }),
        );
        const released = {
          ...pointer,
          clientX: clientX + (axis === "x" ? delta : 0),
          clientY: clientY + (axis === "y" ? delta : 0),
        };
        destination.dispatchEvent(new PointerEvent("pointermove", released));
        destination.dispatchEvent(new PointerEvent("pointerup", released));
      });
    }

    await drag(72, next);
    expect(first.getBoundingClientRect()[dimension]).toBeCloseTo(initial + 72, 0);
    await drag(-72, first);
    expect(first.getBoundingClientRect()[dimension]).toBeCloseTo(initial, 0);
    await drag(48, next);
    expect(first.getBoundingClientRect()[dimension]).toBeCloseTo(initial + 48, 0);
  },
);

it("opens a dragged sidebar thread in the blank pane without replacing another thread", async () => {
  await using screen = await render(
    <div className="flex h-dvh min-w-0 flex-col">
      <SplitThreadWorkspace standalone initialPaneCount={2} />
    </div>,
  );
  const first = screen.getByRole("region", { name: "Pane 1", exact: true });
  const second = screen.getByRole("region", { name: "Pane 2", exact: true });
  const pointIn = (pane: typeof first) => {
    const bounds = pane.element().getBoundingClientRect();
    return { x: bounds.left + 25, y: bounds.top + 65 };
  };
  const review = { environmentId: projectRef.environmentId, threadId: ThreadId.make("Review") };
  const build = { environmentId: projectRef.environmentId, threadId: ThreadId.make("Build") };

  await expect.element(second.getByText("Drag a thread here")).toBeVisible();
  const point = pointIn(second);
  moveThreadContextDrag(point, { title: "Review", count: 1 }, [review]);
  try {
    await expect.element(second).toHaveAttribute("data-thread-context-over", "true");
    await act(() => expect(dropThreadContext(point, [review])).toBe(true));
  } finally {
    endThreadContextDrag();
  }
  await expect.element(second.getByRole("textbox", { name: "Message Review" })).toBeVisible();
  await expect.element(second).not.toHaveAttribute("data-thread-context-drop");
  expect(dropThreadContext(point, [build])).toBe(false);

  await act(() => dropThreadContext(pointIn(first), [review]));
  await expect.element(first.getByText("Drag a thread here")).toBeVisible();
  await act(() => dropThreadContext(pointIn(first), [build]));
  await expect.element(first.getByRole("textbox", { name: "Message Build" })).toBeVisible();
  await expect.element(second.getByRole("textbox", { name: "Message Review" })).toBeVisible();
  expect(screen.router?.state.location.pathname).toBe("/");
});

it.each(["left", "right"] as const)(
  "previews and opens a split from the %s edge while preserving the current chat",
  async (side) => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    await using _restoreViewport = {
      [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
    };
    await page.viewport(900, 600);
    const build = { environmentId: projectRef.environmentId, threadId: ThreadId.make("Build") };
    const review = { environmentId: projectRef.environmentId, threadId: ThreadId.make("Review") };
    await using screen = await render(
      <div className="flex h-dvh min-w-0 flex-col">
        <SplitThreadWorkspace currentThread={build}>
          <textarea className="size-full" aria-label="Message Build" />
        </SplitThreadWorkspace>
      </div>,
    );
    const primary = screen.getByRole("textbox", { name: "Message Build" });
    await primary.fill("Draft in progress");
    const originalComposer = primary.element();
    const rect = originalComposer.getBoundingClientRect();
    const edge = { x: side === "left" ? rect.left + 12 : rect.right - 12, y: rect.top + 120 };
    const center = { x: rect.left + rect.width / 2, y: edge.y };
    const preview = () => screen.container.querySelector('[data-thread-context-over="true"]');
    try {
      moveThreadContextDrag(edge, { title: "Build", count: 1 }, [build]);
      expect(preview()).toBeNull();
      expect(dropThreadContext(center, [review])).toBe(false);
      moveThreadContextDrag(edge, { title: "Review", count: 1 }, [review]);
      expect(preview()?.getAttribute("data-thread-context-snap-edge")).toBe(side);
      moveThreadContextDrag(center, { title: "Review", count: 1 }, [review]);
      expect(preview()).toBeNull();
      moveThreadContextDrag(edge, { title: "Review", count: 1 }, [review]);
      await act(() => expect(dropThreadContext(edge, [review])).toBe(true));
    } finally {
      endThreadContextDrag();
    }

    const paneNumber = side === "left" ? 1 : 2;
    const pane = screen.getByRole("region", { name: `Pane ${paneNumber}`, exact: true });
    const chooser = pane.getByRole("button", { name: `Choose a thread for pane ${paneNumber}` });
    const close = pane.getByRole("button", { name: `Close pane ${paneNumber}` });
    await expect.element(pane.getByRole("textbox", { name: "Message Review" })).toBeVisible();
    expect(primary.element()).toBe(originalComposer);
    await expect.element(primary).toHaveValue("Draft in progress");
    const primaryX = primary.element().getBoundingClientRect().left;
    const paneX = pane.element().getBoundingClientRect().left;
    expect(paneX < primaryX).toBe(side === "left");
    expect(screen.router?.state.location.pathname).toBe("/");

    await page.viewport(400, 360);
    await expect.poll(() => pane.element().getBoundingClientRect().left).toBe(0);
    expect(chooser.element().getBoundingClientRect().right).toBeLessThan(
      close.element().getBoundingClientRect().left,
    );
    expect(close.element().getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
    await close.click();
    await expect.element(pane).not.toBeInTheDocument();
    expect(primary.element()).toBe(originalComposer);
  },
);
