import type { DesktopBridge, MissionControlItem, MissionControlResponse } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import "~/index.css";

import { render } from "../../test/render";
import { MissionControlPriorities } from "./MissionControlPriorities";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

it("starts at five priorities and reveals five more per click", async () => {
  const items: MissionControlItem[] = Array.from({ length: 17 }, (_, index) => ({
    id: `task-${index + 1}`,
    source: "tasks",
    account: "Personal",
    title: `Priority ${index + 1}`,
    detail: "",
    url: null,
    activity: "2026-11-18T00:00:00Z",
    due: null,
    urgency: "normal",
  }));
  const getMissionControl = vi.fn<DesktopBridge["getMissionControl"]>().mockResolvedValue({
    configured: true,
    fetchedAt: null,
    mailboxes: [],
    items,
    sources: [],
    context: null,
    nextCursor: null,
  });
  const previousBridge = window.desktopBridge;
  window.desktopBridge = {
    ...previousBridge,
    getMissionControl,
    getLocalEnvironmentEnabled: () => false,
    getLocalEnvironmentBootstraps: () => [],
  } as DesktopBridge;
  try {
    await using screen = await render(<MissionControlPriorities />);
    const priority = (rank: number) => screen.getByText(`Priority ${rank}`, { exact: true });
    const seeMore = screen.getByRole("button", { name: "See more" });
    await expect.element(priority(5)).toBeVisible();
    await expect.element(priority(6)).not.toBeInTheDocument();
    await seeMore.click();
    await expect.element(priority(10)).toBeVisible();
    await expect.element(priority(11)).not.toBeInTheDocument();
    await seeMore.click();
    await expect.element(priority(15)).toBeVisible();
    await expect.element(priority(16)).not.toBeInTheDocument();
    await seeMore.click();
    await expect.element(priority(17)).toBeVisible();
    await expect.element(seeMore).not.toBeInTheDocument();
    await screen.getByRole("button", { name: "See less" }).click();
    await expect.element(priority(6)).not.toBeInTheDocument();
    await seeMore.click();
    await screen.getByRole("button", { name: "Personal tasks" }).click();
    await expect.element(priority(5)).toBeVisible();
    await expect.element(priority(6)).not.toBeInTheDocument();
  } finally {
    if (previousBridge) window.desktopBridge = previousBridge;
    else Reflect.deleteProperty(window, "desktopBridge");
  }
});

it("sends the reviewed reply and completes the exact Linear row on its own button", async () => {
  const reply: MissionControlItem = {
    id: "gmail:Personal:abcdef01",
    source: "email",
    account: "Personal",
    title: "Review request",
    detail: "",
    url: null,
    activity: "2026-11-18T00:00:00Z",
    due: null,
    urgency: "normal",
    canReply: true,
  };
  const issue: MissionControlItem = {
    ...reply,
    id: "linear:fa751e05-66cd-4d10-8014-a173c8b7d11d",
    source: "linear",
    title: "Fix checkout test",
    account: "Example workspace",
  };
  const getMissionControl = vi.fn<DesktopBridge["getMissionControl"]>().mockResolvedValue({
    configured: true,
    fetchedAt: null,
    mailboxes: ["Personal"],
    items: [reply, issue],
    sources: [],
    context: null,
    nextCursor: null,
  });
  const revision = "a".repeat(64);
  const getMissionControlReply = vi
    .fn<DesktopBridge["getMissionControlReply"]>()
    .mockResolvedValue({
      ok: true,
      from: "owner@example.test",
      to: "sender@example.test",
      subject: "Review request",
      snippet: "Could you review this?",
      revision,
    });
  const runMissionControlAction = vi
    .fn<DesktopBridge["runMissionControlAction"]>()
    .mockResolvedValueOnce({ ok: false, error: "Could not confirm the reply." })
    .mockResolvedValueOnce({ ok: true, message: "Reply sent." })
    .mockResolvedValueOnce({ ok: true, message: "Marked complete in Linear." });
  const previousBridge = window.desktopBridge;
  window.desktopBridge = {
    ...previousBridge,
    getMissionControl,
    getMissionControlReply,
    runMissionControlAction,
    getLocalEnvironmentEnabled: () => false,
    getLocalEnvironmentBootstraps: () => [],
  } as DesktopBridge;
  try {
    await using screen = await render(<MissionControlPriorities />);
    await screen.getByRole("button", { name: "Reply", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Reply to email" });
    await expect.element(dialog.getByText("sender@example.test")).toBeVisible();
    const send = dialog.getByRole("button", { name: "Send reply" });
    await expect.element(send).toBeDisabled();
    await dialog.getByRole("textbox", { name: "Your reply" }).fill("I’ll review today.");
    expect(runMissionControlAction).not.toHaveBeenCalled();
    await send.click();
    await expect.element(dialog.getByRole("alert")).toBeVisible();
    await expect
      .element(dialog.getByRole("textbox", { name: "Your reply" }))
      .toHaveValue("I’ll review today.");
    await send.click();
    await expect.element(screen.getByText("Review request")).not.toBeInTheDocument();
    expect(getMissionControlReply).toHaveBeenCalledExactlyOnceWith(reply.id);
    expect(runMissionControlAction).toHaveBeenNthCalledWith(2, {
      kind: "reply",
      itemId: reply.id,
      revision,
      body: "I’ll review today.",
    });

    await screen.getByRole("button", { name: "Mark complete" }).click();
    await expect.element(screen.getByText("Fix checkout test")).not.toBeInTheDocument();
    expect(runMissionControlAction).toHaveBeenNthCalledWith(3, {
      kind: "complete-linear",
      itemId: issue.id,
    });
  } finally {
    if (previousBridge) window.desktopBridge = previousBridge;
    else Reflect.deleteProperty(window, "desktopBridge");
  }
});

it("filters the cross-source queue and pages through mail for the selected account", async () => {
  const item: MissionControlItem = {
    id: "task-1",
    source: "tasks",
    account: "Personal",
    title: "Personal deadline",
    detail: "",
    url: null,
    activity: "2026-11-16T22:00:00Z",
    due: "2026-11-16",
    urgency: "normal",
  };
  const snapshot: MissionControlResponse = {
    configured: true,
    fetchedAt: null,
    mailboxes: ["Personal"],
    items: [
      item,
      { ...item, id: "srcos-1", source: "srcos", title: "SRCOS follow-up" },
      {
        ...item,
        id: "linear-1",
        source: "linear",
        account: "Example workspace",
        title: "Team issue",
      },
    ],
    sources: [
      { source: "tasks", account: "Personal", state: "ready", detail: "" },
      { source: "srcos", account: "Personal", state: "partial", detail: "" },
      { source: "linear", account: "Example workspace", state: "ready", detail: "" },
    ],
    context: "Example workspace guidance",
    srcosContext: "Personal workspace guidance",
    nextCursor: null,
  };
  const getMissionControl = vi.fn<DesktopBridge["getMissionControl"]>(async (request) => {
    if (request.view === "priorities") return snapshot;
    return {
      ...snapshot,
      items: [
        {
          ...item,
          id: "mail",
          source: "email",
          title: request.cursor ? "Older email" : "Recent email",
        },
      ],
      nextCursor: request.cursor ? null : "next-page",
    };
  });
  const previousBridge = window.desktopBridge;
  window.desktopBridge = { ...previousBridge, getMissionControl } as DesktopBridge;
  try {
    await using screen = await render(<MissionControlPriorities />);
    await expect.element(screen.getByText("Team issue")).toBeVisible();
    await screen.getByRole("button", { name: "Personal tasks" }).click();
    await expect.element(screen.getByRole("heading", { name: "Personal tasks" })).toBeVisible();
    await expect.element(screen.getByText("Personal deadline")).toBeVisible();
    await expect.element(screen.getByText("Team issue")).not.toBeInTheDocument();
    await expect.element(screen.getByText("SRCOS follow-up")).not.toBeInTheDocument();
    await screen.getByText("Sources", { exact: true }).click();
    await expect
      .element(screen.getByText("Google Tasks · Personal", { exact: true }))
      .toBeVisible();
    await expect
      .element(screen.getByText("SRCOS · Personal", { exact: true }))
      .not.toBeInTheDocument();
    await screen.getByRole("button", { name: "SRCOS", exact: true }).click();
    await expect.element(screen.getByText("SRCOS follow-up")).toBeVisible();
    await expect
      .element(screen.getByText("Personal workspace guidance", { exact: false }))
      .toBeVisible();
    await expect.element(screen.getByText("Personal deadline")).not.toBeInTheDocument();
    await expect.element(screen.getByText("Example workspace guidance")).not.toBeInTheDocument();
    await screen.getByRole("button", { name: "Workspace tasks" }).click();
    await expect.element(screen.getByText("Team issue")).toBeVisible();
    await expect.element(screen.getByText("SRCOS follow-up")).not.toBeInTheDocument();
    await expect
      .element(screen.getByText("Personal workspace guidance", { exact: false }))
      .not.toBeInTheDocument();
    await screen.getByRole("button", { name: "Personal mail" }).click();
    await expect.element(screen.getByText("Recent email")).toBeVisible();
    await screen.getByRole("button", { name: "Next" }).click();
    await expect.element(screen.getByText("Older email")).toBeVisible();
    await expect.element(screen.getByText("Recent email")).not.toBeInTheDocument();
    expect(getMissionControl).toHaveBeenLastCalledWith({
      view: "mail",
      account: "Personal",
      cursor: "next-page",
      replies: false,
    });
  } finally {
    if (previousBridge) window.desktopBridge = previousBridge;
    else Reflect.deleteProperty(window, "desktopBridge");
  }
});

it("loads a selected filter while All is pending and ignores the old response", async () => {
  const mailItem: MissionControlItem = {
    id: "email-1",
    source: "email",
    account: "Personal",
    title: "Mail reply fixture",
    detail: "",
    url: null,
    activity: "",
    due: null,
    urgency: "normal",
  };
  const snapshot: MissionControlResponse = {
    configured: true,
    fetchedAt: null,
    mailboxes: ["Personal"],
    items: [mailItem],
    sources: [{ source: "email", account: "Personal", state: "ready", detail: "" }],
    context: null,
    nextCursor: null,
  };
  const all = deferred<MissionControlResponse>();
  const slack = deferred<MissionControlResponse>();
  const getMissionControl = vi.fn<DesktopBridge["getMissionControl"]>((request) =>
    request.view === "priorities" && request.filter === "slack" ? slack.promise : all.promise,
  );
  const previousBridge = window.desktopBridge;
  window.desktopBridge = { ...previousBridge, getMissionControl } as DesktopBridge;
  try {
    await using screen = await render(<MissionControlPriorities />);
    await expect.element(screen.getByText("Checking your sources…")).toBeVisible();
    await screen.getByRole("button", { name: "Slack replies" }).click();
    await expect.element(screen.getByText("Checking Slack replies…")).toBeVisible();
    expect(getMissionControl).toHaveBeenLastCalledWith({
      view: "priorities",
      filter: "slack",
      refresh: false,
    });
    slack.resolve({
      ...snapshot,
      items: [{ ...mailItem, id: "slack-1", source: "slack", title: "Slack reply fixture" }],
      sources: [{ source: "slack", account: "Example workspace", state: "ready", detail: "" }],
    });
    await expect.element(screen.getByText("Slack reply fixture")).toBeVisible();
    all.resolve(snapshot);
    await all.promise;
    await expect.element(screen.getByText("Slack reply fixture")).toBeVisible();
    await expect.element(screen.getByText("Mail reply fixture")).not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "Personal mail" })).toBeVisible();
  } finally {
    if (previousBridge) window.desktopBridge = previousBridge;
    else Reflect.deleteProperty(window, "desktopBridge");
  }
});
