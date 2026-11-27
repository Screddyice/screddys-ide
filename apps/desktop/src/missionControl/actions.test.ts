// @effect-diagnostics nodeBuiltinImport:off -- Temporary local reply receipts are part of the behavior under test.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it, vi } from "vite-plus/test";

import {
  completeMissionControlIssue,
  completeMissionControlTask,
  createMissionControlTask,
  previewMissionControlReply,
  sendMissionControlReply,
  updateMissionControlTask,
} from "./actions.ts";
import type { Bindings, Connector } from "./sources.ts";

const bindings: Bindings = {
  mail: [{ label: "Personal", selector: "owner", email: "owner@example.test" }],
  slack: "",
  linear: "team",
  linearEmail: "owner@example.test",
  tasks: "",
  nebos: "",
  srcosTenant: "",
};
const emailId = "gmail:Personal:12345678";

function mailboxFixture() {
  let recipient = "Sender <sender@example.test>";
  const proxy = vi.fn<Connector["proxy"]>(async (_, account, path) => {
    expect(account).toBe("owner");
    if (path.endsWith("/profile")) return { emailAddress: "owner@example.test" };
    return {
      id: "12345678",
      messages: [
        {
          id: "incoming1",
          internalDate: "1794952800000",
          labelIds: ["INBOX"],
          payload: {
            headers: [
              { name: "From", value: "Person <person@example.test>" },
              { name: "Reply-To", value: recipient },
              { name: "Subject", value: "Status update" },
              { name: "Message-ID", value: "<original@example.test>" },
              { name: "References", value: "<previous@example.test>" },
            ],
          },
        },
      ],
    };
  });
  const sendGmailReply = vi
    .fn<Connector["sendGmailReply"]>()
    .mockResolvedValue({ id: "sent1", threadId: "12345678" });
  return {
    api: { proxy, sendGmailReply } as unknown as Connector,
    sendGmailReply,
    changeRecipient(value: string) {
      recipient = value;
    },
  };
}

it("rechecks the recipient before sending and threads a single exact reply", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "screddy-reply-"));
  try {
    const { api, sendGmailReply, changeRecipient } = mailboxFixture();
    const preview = await previewMissionControlReply(api, bindings, emailId);
    expect(preview.to).toBe("sender@example.test");
    const batch = {
      kind: "reply" as const,
      itemId: emailId,
      revision: preview.revision,
      body: "Thank you.\nI'll review.",
    };
    changeRecipient("Someone else <another@example.test>");
    await expect(sendMissionControlReply(api, bindings, directory, batch)).rejects.toThrow(
      /email changed/,
    );
    expect(sendGmailReply).not.toHaveBeenCalled();
    changeRecipient("Sender <sender@example.test>");
    const result = await Promise.allSettled([
      sendMissionControlReply(api, bindings, directory, batch),
      sendMissionControlReply(api, bindings, directory, batch),
    ]);
    expect(result.filter((entry) => entry.status === "fulfilled")).not.toHaveLength(0);
    const [account, thread, raw] = sendGmailReply.mock.calls[0]!;
    expect(sendGmailReply).toHaveBeenCalledTimes(1);
    expect([account, thread]).toEqual(["owner", "12345678"]);
    const mime = Buffer.from(raw, "base64url").toString("utf8");
    expect(mime).toContain("To: sender@example.test\r\nSubject: Status update");
    expect(mime).toContain(
      "In-Reply-To: <original@example.test>\r\nReferences: <previous@example.test>\r\n <original@example.test>",
    );
    expect(Buffer.from(mime.split("\r\n\r\n")[1]!, "base64").toString("utf8")).toBe(
      "Thank you.\r\nI'll review.",
    );
    await expect(sendMissionControlReply(api, bindings, directory, batch)).resolves.toMatchObject({
      ok: true,
    });
    expect(sendGmailReply).toHaveBeenCalledTimes(1);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("does not resend after a send was attempted without an acknowledgement", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "screddy-reply-"));
  try {
    const { api, sendGmailReply } = mailboxFixture();
    sendGmailReply.mockRejectedValue(new Error("Lost acknowledgement"));
    const preview = await previewMissionControlReply(api, bindings, emailId);
    const action = {
      kind: "reply" as const,
      itemId: emailId,
      revision: preview.revision,
      body: "Review complete.",
    };
    await expect(sendMissionControlReply(api, bindings, directory, action)).rejects.toThrow(
      /Check Sent/,
    );
    await expect(
      sendMissionControlReply(api, bindings, directory, { ...action, body: "Edited" }),
    ).rejects.toThrow(/Check Sent/);
    expect(sendGmailReply).toHaveBeenCalledTimes(1);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

const slackBindings: Bindings = { ...bindings, slack: "slack-owner" };
const slackId = "slack:C0LAUNCH:1794952800.000100";

function slackFixture(
  channel = "C0LAUNCH",
  info: Record<string, unknown> = { id: "C0LAUNCH", name: "launch" },
) {
  let history: Record<string, unknown>[] = [];
  let thread: Record<string, unknown>[] = [
    { ts: "1794952800.000100", user: "U0OTHER", text: "Launch plan is in the doc" },
    { ts: "1794952860.000200", user: "U0OTHER", text: "<@U0ME> can you sign off?" },
  ];
  let token: Record<string, unknown> = {
    user_id: "U0ME",
    user: "owner",
    team_id: "T0TEAM",
    team: "Example",
  };
  const proxy = vi.fn<Connector["proxy"]>(async (toolkit, account, path, params) => {
    expect([toolkit, account]).toEqual(["slack", "slack-owner"]);
    if (path === "/api/auth.test") return token;
    if (path === "/api/conversations.info") {
      expect(params).toEqual({ channel });
      return { channel: info };
    }
    if (path === "/api/conversations.history") return { messages: history, has_more: false };
    if (path === "/api/users.info") return { user: { real_name: "Other Person" } };
    expect(path).toBe("/api/conversations.replies");
    expect(params).toMatchObject({ channel, ts: "1794952800.000100" });
    return { messages: thread, has_more: false };
  });
  const postSlackReply = vi.fn<Connector["postSlackReply"]>(
    async (_account, channel, threadTs, text) => {
      const message = { ts: "1794952900.000300", user: "U0ME", thread_ts: threadTs, text };
      thread = [...thread, message];
      return { ok: true, channel, ts: message.ts, message };
    },
  );
  return {
    api: { proxy, postSlackReply } as unknown as Connector,
    proxy,
    postSlackReply,
    setThread(messages: Record<string, unknown>[]) {
      thread = messages;
    },
    setHistory(messages: Record<string, unknown>[]) {
      history = messages;
    },
    setToken(value: Record<string, unknown>) {
      token = value;
    },
  };
}

it("previews the Slack thread, then posts one escaped reply in it as the connected account", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "screddy-reply-"));
  try {
    const { api, postSlackReply } = slackFixture();
    const preview = await previewMissionControlReply(api, slackBindings, slackId);
    expect(preview).toMatchObject({
      ok: true,
      from: "@owner (Example)",
      to: "#launch",
      subject: "Launch plan is in the doc",
      snippet: "@you can you sign off?",
    });
    const reply = {
      kind: "reply" as const,
      itemId: slackId,
      revision: preview.revision,
      body: "Signed off <!channel> & shipping",
    };
    await expect(
      sendMissionControlReply(api, slackBindings, directory, reply),
    ).resolves.toMatchObject({ ok: true, message: "Reply posted in Slack." });
    expect(postSlackReply).toHaveBeenCalledExactlyOnceWith(
      "slack-owner",
      "C0LAUNCH",
      "1794952800.000100",
      "Signed off &lt;!channel&gt; &amp; shipping",
    );
    await expect(
      sendMissionControlReply(api, slackBindings, directory, reply),
    ).resolves.toMatchObject({ message: "A reply to this message was already sent." });
    expect(postSlackReply).toHaveBeenCalledTimes(1);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("refuses a Slack reply once the thread changed, you already answered, or the token is a bot", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "screddy-reply-"));
  try {
    const { api, postSlackReply, setThread, setToken } = slackFixture();
    const preview = await previewMissionControlReply(api, slackBindings, slackId);
    const mention = { ts: "1794952860.000200", user: "U0OTHER", text: "<@U0ME> can you sign off?" };
    const root = { ts: "1794952800.000100", user: "U0OTHER", text: "Launch plan is in the doc" };
    setThread([root, mention, { ts: "1794952870.000300", user: "U0THIRD", text: "Same question" }]);
    await expect(
      sendMissionControlReply(api, slackBindings, directory, {
        kind: "reply",
        itemId: slackId,
        revision: preview.revision,
        body: "Done",
      }),
    ).rejects.toThrow(/thread changed/);

    // Answering the mention settles it, even when someone else posts afterwards.
    setThread([
      root,
      mention,
      { ts: "1794952880.000400", user: "U0ME", text: "Signed off" },
      { ts: "1794952890.000500", user: "U0THIRD", text: "Thanks" },
    ]);
    await expect(previewMissionControlReply(api, slackBindings, slackId)).rejects.toThrow(
      /already replied/,
    );

    setThread([root, mention]);
    setToken({ user_id: "U0ME", team_id: "T0TEAM", bot_id: "B0BOT" });
    await expect(previewMissionControlReply(api, slackBindings, slackId)).rejects.toThrow(
      /your own account/,
    );
    await expect(
      previewMissionControlReply(api, slackBindings, "slack:C0LAUNCH:not-a-thread"),
    ).rejects.toThrow(/not a configured Slack thread/);
    expect(postSlackReply).not.toHaveBeenCalled();
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("does not repost after Slack fails to confirm the reply came from you", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "screddy-reply-"));
  try {
    const { api, postSlackReply } = slackFixture();
    postSlackReply.mockResolvedValue({
      ok: true,
      channel: "C0LAUNCH",
      ts: "1794952900.000300",
      message: { user: "U0SOMEBOT", thread_ts: "1794952800.000100" },
    });
    const preview = await previewMissionControlReply(api, slackBindings, slackId);
    const reply = {
      kind: "reply" as const,
      itemId: slackId,
      revision: preview.revision,
      body: "Ok",
    };
    await expect(sendMissionControlReply(api, slackBindings, directory, reply)).rejects.toThrow(
      /Check the thread in Slack/,
    );
    await expect(sendMissionControlReply(api, slackBindings, directory, reply)).rejects.toThrow(
      /Check the thread in Slack/,
    );
    expect(postSlackReply).toHaveBeenCalledTimes(1);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("refuses a Slack reply after the message you saw is edited or a DM gets a new message", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "screddy-reply-"));
  try {
    // An edit that keeps the mention still changes what you'd be replying to.
    const channel = slackFixture();
    const before = await previewMissionControlReply(channel.api, slackBindings, slackId);
    channel.setThread([
      { ts: "1794952800.000100", user: "U0OTHER", text: "Launch plan is in the doc" },
      {
        ts: "1794952860.000200",
        user: "U0OTHER",
        text: "<@U0ME> can you sign off on the new budget?",
        edited: { user: "U0OTHER", ts: "1794952870.000000" },
      },
    ]);
    await expect(
      sendMissionControlReply(channel.api, slackBindings, directory, {
        kind: "reply",
        itemId: slackId,
        revision: before.revision,
        body: "Yes",
      }),
    ).rejects.toThrow(/thread changed/);

    // In a DM with no thread, a new message from the other person changes it too.
    const dmId = "slack:D0DIRECT:1794952800.000100";
    const dm = slackFixture("D0DIRECT", { id: "D0DIRECT", is_im: true, user: "U0OTHER" });
    dm.setThread([{ ts: "1794952800.000100", user: "U0OTHER", text: "Got a minute?" }]);
    const opened = await previewMissionControlReply(dm.api, slackBindings, dmId);
    expect(opened).toMatchObject({ to: "Direct message with Other Person" });
    dm.setHistory([{ ts: "1794952900.000900", user: "U0OTHER", text: "Never mind, sorted" }]);
    await expect(
      sendMissionControlReply(dm.api, slackBindings, directory, {
        kind: "reply",
        itemId: dmId,
        revision: opened.revision,
        body: "Sure",
      }),
    ).rejects.toThrow(/thread changed/);
    expect(channel.postSlackReply).not.toHaveBeenCalled();
    expect(dm.postSlackReply).not.toHaveBeenCalled();
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("does not post again after an unconfirmed reply, even once the thread moves on", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "screddy-reply-"));
  try {
    const { api, postSlackReply, setThread } = slackFixture();
    // Slack drops the acknowledgement; the reply hasn't shown up in the thread yet.
    postSlackReply.mockRejectedValue(new Error("socket hang up"));
    const preview = await previewMissionControlReply(api, slackBindings, slackId);
    await expect(
      sendMissionControlReply(api, slackBindings, directory, {
        kind: "reply",
        itemId: slackId,
        revision: preview.revision,
        body: "Ok",
      }),
    ).rejects.toThrow(/Check the thread in Slack/);
    setThread([
      { ts: "1794952800.000100", user: "U0OTHER", text: "Launch plan is in the doc" },
      { ts: "1794952860.000200", user: "U0OTHER", text: "<@U0ME> can you sign off?" },
      { ts: "1794952950.000700", user: "U0THIRD", text: "Bump" },
    ]);
    const refreshed = await previewMissionControlReply(api, slackBindings, slackId);
    expect(refreshed.revision).not.toBe(preview.revision);
    await expect(
      sendMissionControlReply(api, slackBindings, directory, {
        kind: "reply",
        itemId: slackId,
        revision: refreshed.revision,
        body: "Ok",
      }),
    ).rejects.toThrow(/Check the thread in Slack/);
    expect(postSlackReply).toHaveBeenCalledTimes(1);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("posts once when two replies to the same item race with different revisions", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "screddy-reply-"));
  try {
    const { api, proxy, postSlackReply, setThread } = slackFixture();
    const root = { ts: "1794952800.000100", user: "U0OTHER", text: "Launch plan is in the doc" };
    const mention = { ts: "1794952860.000200", user: "U0OTHER", text: "<@U0ME> can you sign off?" };
    const older = [root, mention];
    const newer = [...older, { ts: "1794952950.000700", user: "U0THIRD", text: "Bump" }];
    setThread(older);
    const first = await previewMissionControlReply(api, slackBindings, slackId);
    setThread(newer);
    const second = await previewMissionControlReply(api, slackBindings, slackId);

    // Hold both requests until both have passed their up-front checks, then let the first one
    // read the older thread and the second the newer one, so each validates its own revision.
    const read = proxy.getMockImplementation()!;
    const threads = [older, newer];
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    proxy.mockImplementation(async (toolkit, account, path, params) => {
      if (path === "/api/auth.test") {
        arrived += 1;
        if (arrived === 2) release();
        await gate;
      }
      if (path === "/api/conversations.replies") setThread(threads.shift() ?? newer);
      return read(toolkit, account, path, params);
    });
    const send = (revision: string) =>
      sendMissionControlReply(api, slackBindings, directory, {
        kind: "reply",
        itemId: slackId,
        revision,
        body: "Ok",
      })
        .then(
          () => "sent",
          (error: Error) => error.message,
        )
        // A request refused before the gate must not leave the other one waiting there.
        .finally(() => release());
    const results = await Promise.all([send(first.revision), send(second.revision)]);
    // Only one request gets past the item's hold; the other is turned away before it can send.
    expect(postSlackReply.mock.calls.length).toBeLessThanOrEqual(1);
    expect(results).toContain(
      "Slack did not confirm the reply. Check the thread in Slack before sending again.",
    );
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("turns away a reply while another to the same item is still being sent", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "screddy-reply-"));
  try {
    const { api, postSlackReply, setThread } = slackFixture();
    // The first post hangs, however long it takes; nothing else may post meanwhile.
    let finish!: () => void;
    const slow = new Promise<void>((resolve) => (finish = resolve));
    const post = postSlackReply.getMockImplementation()!;
    postSlackReply.mockImplementationOnce(async (...args) => {
      await slow;
      return post(...args);
    });
    const preview = await previewMissionControlReply(api, slackBindings, slackId);
    const first = sendMissionControlReply(api, slackBindings, directory, {
      kind: "reply",
      itemId: slackId,
      revision: preview.revision,
      body: "Ok",
    });
    await vi.waitFor(() => expect(postSlackReply).toHaveBeenCalledTimes(1));
    setThread([
      { ts: "1794952800.000100", user: "U0OTHER", text: "Launch plan is in the doc" },
      { ts: "1794952860.000200", user: "U0OTHER", text: "<@U0ME> can you sign off?" },
      { ts: "1794952950.000700", user: "U0THIRD", text: "Bump" },
    ]);
    const refreshed = await previewMissionControlReply(api, slackBindings, slackId);
    await expect(
      sendMissionControlReply(api, slackBindings, directory, {
        kind: "reply",
        itemId: slackId,
        revision: refreshed.revision,
        body: "Ok",
      }),
    ).rejects.toThrow(/Check the thread in Slack/);
    finish();
    await expect(first).resolves.toMatchObject({ message: "Reply posted in Slack." });
    expect(postSlackReply).toHaveBeenCalledTimes(1);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("honors an unconfirmed reply recorded by an earlier version of Screddy", async () => {
  const itemKey = NodeCrypto.createHash("sha256")
    .update(JSON.stringify([slackId]))
    .digest("hex");
  for (const legacy of [itemKey + ".pending", itemKey + ".hold.1"]) {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "screddy-reply-"));
    try {
      await NodeFSP.mkdir(NodePath.join(directory, "mission-control-replies"));
      await NodeFSP.writeFile(NodePath.join(directory, "mission-control-replies", legacy), "");
      const { api, postSlackReply } = slackFixture();
      const preview = await previewMissionControlReply(api, slackBindings, slackId);
      await expect(
        sendMissionControlReply(api, slackBindings, directory, {
          kind: "reply",
          itemId: slackId,
          revision: preview.revision,
          body: "Ok",
        }),
      ).rejects.toThrow(/Check the thread in Slack/);
      expect(postSlackReply).not.toHaveBeenCalled();
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  }
});

it("updates only the selected assigned issue to that team's completed status", async () => {
  const id = "ca751e05-66cd-4d10-8014-a173c8b7d11d";
  const status = "d9decd72-47d4-495d-9dbf-141ed7ed9de8";
  const state = { id: status, name: "Done", type: "completed" };
  const issue = {
    id,
    assignee: { id: "owner" },
    state: { type: "started" },
    team: {
      states: { nodes: [state], pageInfo: { hasNextPage: false } },
    },
  };
  const viewer = { id: "owner", email: "Owner@Example.Test" };
  const linearCompletionTarget = vi
    .fn<Connector["linearCompletionTarget"]>()
    .mockResolvedValue({ viewer, issue });
  const completeLinearIssue = vi.fn<Connector["completeLinearIssue"]>().mockResolvedValue({
    issueUpdate: { success: true, issue: { id, state } },
  });
  const api = { linearCompletionTarget, completeLinearIssue } as unknown as Connector;
  await expect(completeMissionControlIssue(api, bindings, "linear:" + id)).resolves.toMatchObject({
    ok: true,
  });
  expect(completeLinearIssue).toHaveBeenCalledExactlyOnceWith("team", id, status);
  await expect(
    completeMissionControlIssue(api, { ...bindings, linearEmail: undefined }, "linear:" + id),
  ).rejects.toThrow(/connected Linear email/);
  linearCompletionTarget.mockResolvedValue({
    viewer: { ...viewer, email: "someone@example.test" },
    issue,
  });
  await expect(completeMissionControlIssue(api, bindings, "linear:" + id)).rejects.toThrow(
    /assigned/,
  );
  linearCompletionTarget.mockResolvedValue({
    viewer,
    issue: { ...issue, assignee: { id: "other" } },
  });
  await expect(completeMissionControlIssue(api, bindings, "linear:" + id)).rejects.toThrow(
    /assigned/,
  );
  linearCompletionTarget.mockResolvedValue({ viewer, issue: { ...issue, state } });
  await expect(completeMissionControlIssue(api, bindings, "linear:" + id)).resolves.toMatchObject({
    ok: true,
  });
  expect(completeLinearIssue).toHaveBeenCalledTimes(1);
});

it("completes an open Google Task once and confirms the saved status", async () => {
  const list = "MTgxNjU4MDY0MTQ4NzUxNTk5NzM6MDow";
  const task = "dGFzay1pZC0xMjM0NQ";
  const googleTask = vi.fn<Connector["googleTask"]>(async () => ({
    id: task,
    status: "needsAction",
  }));
  const completeGoogleTask = vi.fn<Connector["completeGoogleTask"]>(async () => ({
    id: task,
    status: "completed",
  }));
  const api = { googleTask, completeGoogleTask } as unknown as Connector;
  const withTasks = { ...bindings, tasks: "tasks-account" };
  const itemId = `tasks:${list}:${task}`;

  await expect(completeMissionControlTask(api, withTasks, itemId)).resolves.toEqual({
    ok: true,
    message: "Marked complete in Google Tasks.",
  });
  expect(completeGoogleTask).toHaveBeenCalledExactlyOnceWith("tasks-account", list, task);

  googleTask.mockResolvedValue({ id: task, status: "completed" });
  await expect(completeMissionControlTask(api, withTasks, itemId)).resolves.toMatchObject({
    message: "Already complete in Google Tasks.",
  });
  expect(completeGoogleTask).toHaveBeenCalledTimes(1);

  googleTask.mockResolvedValue({ id: task, status: "needsAction" });
  completeGoogleTask.mockResolvedValue({ id: task, status: "needsAction" });
  await expect(completeMissionControlTask(api, withTasks, itemId)).rejects.toThrow(
    /did not confirm/,
  );
  googleTask.mockResolvedValue({ id: "another", status: "needsAction" });
  await expect(completeMissionControlTask(api, withTasks, itemId)).rejects.toThrow(/no longer/);
  await expect(completeMissionControlTask(api, bindings, itemId)).rejects.toThrow(/configured/);
  await expect(completeMissionControlTask(api, withTasks, "tasks:../x:" + task)).rejects.toThrow(
    /configured/,
  );
});

it("adds a Google Task to the default list and returns its Mission Control id", async () => {
  const list = "MTgxNjU4MDY0MTQ4NzUxNTk5NzM6MDow";
  const task = "bmV3LXRhc2stMQ";
  const insertGoogleTask = vi.fn<Connector["insertGoogleTask"]>(async (_account, _list, body) => ({
    ...body,
    id: task,
    status: "needsAction",
    selfLink: `https://www.googleapis.com/tasks/v1/lists/${list}/tasks/${task}`,
  }));
  const api = { insertGoogleTask } as unknown as Connector;
  const withTasks = { ...bindings, tasks: "tasks-account" };

  await expect(
    createMissionControlTask(api, withTasks, {
      title: "  Renew passport ",
      notes: "Bring the old one",
      due: "2026-12-01",
    }),
  ).resolves.toEqual({
    ok: true,
    message: "Added to Google Tasks.",
    itemId: `tasks:${list}:${task}`,
  });
  expect(insertGoogleTask).toHaveBeenCalledExactlyOnceWith("tasks-account", "@default", {
    title: "Renew passport",
    notes: "Bring the old one",
    due: "2026-12-01T00:00:00.000Z",
  });

  await createMissionControlTask(api, withTasks, { title: "Call the bank", notes: "" });
  expect(insertGoogleTask).toHaveBeenLastCalledWith("tasks-account", "@default", {
    title: "Call the bank",
  });

  await expect(createMissionControlTask(api, withTasks, { title: "   " })).rejects.toThrow(/title/);
  await expect(
    createMissionControlTask(api, withTasks, { title: "Pay rent", due: "2026-02-31" }),
  ).rejects.toThrow(/due date/);
  await expect(createMissionControlTask(api, bindings, { title: "Pay rent" })).rejects.toThrow(
    /configured/,
  );
  expect(insertGoogleTask).toHaveBeenCalledTimes(2);

  // Without a saved task in the reply, adding it again could make a duplicate.
  insertGoogleTask.mockResolvedValueOnce({ error: "timeout" });
  await expect(createMissionControlTask(api, withTasks, { title: "Pay rent" })).rejects.toThrow(
    /before adding it again/,
  );
});

it("edits only the fields asked for on the exact Google Task and confirms them", async () => {
  const list = "MTgxNjU4MDY0MTQ4NzUxNTk5NzM6MDow";
  const task = "dGFzay1pZC0xMjM0NQ";
  const saved = {
    id: task,
    title: "Renew passport",
    notes: "Bring the old one",
    due: "2026-12-01T00:00:00.000Z",
    status: "needsAction",
  };
  const googleTask = vi.fn<Connector["googleTask"]>(async () => saved);
  const updateGoogleTask = vi.fn<Connector["updateGoogleTask"]>(
    async (_account, _list, _task, body) => ({ ...saved, ...body }),
  );
  const api = { googleTask, updateGoogleTask } as unknown as Connector;
  const withTasks = { ...bindings, tasks: "tasks-account" };
  const itemId = `tasks:${list}:${task}`;

  await expect(
    updateMissionControlTask(api, withTasks, itemId, { title: "Renew passport by Friday" }),
  ).resolves.toEqual({ ok: true, message: "Updated in Google Tasks.", itemId });
  expect(updateGoogleTask).toHaveBeenCalledExactlyOnceWith("tasks-account", list, task, {
    title: "Renew passport by Friday",
  });

  updateGoogleTask.mockImplementationOnce(async (_account, _list, _task, body) => {
    const { due: _cleared, ...rest } = saved;
    return { ...rest, ...body, due: undefined };
  });
  await updateMissionControlTask(api, withTasks, itemId, { due: null, notes: "" });
  expect(updateGoogleTask).toHaveBeenLastCalledWith("tasks-account", list, task, {
    notes: "",
    due: null,
  });

  await expect(updateMissionControlTask(api, withTasks, itemId, {})).rejects.toThrow(
    /Nothing to change/,
  );
  await expect(
    updateMissionControlTask(api, withTasks, itemId, { due: "next friday" }),
  ).rejects.toThrow(/due date/);
  await expect(
    updateMissionControlTask(api, withTasks, "tasks:../x:" + task, { title: "x" }),
  ).rejects.toThrow(/configured/);
  expect(updateGoogleTask).toHaveBeenCalledTimes(2);

  // A lost reply still counts when Google Tasks already holds the new values.
  updateGoogleTask.mockResolvedValueOnce({ error: "timeout" });
  googleTask.mockResolvedValueOnce(saved).mockResolvedValueOnce({ ...saved, title: "Renamed" });
  await expect(
    updateMissionControlTask(api, withTasks, itemId, { title: "Renamed" }),
  ).resolves.toMatchObject({ ok: true });

  updateGoogleTask.mockResolvedValueOnce({ ...saved, title: "Something else" });
  await expect(
    updateMissionControlTask(api, withTasks, itemId, { title: "Renamed" }),
  ).rejects.toThrow(/did not confirm/);

  googleTask.mockResolvedValueOnce({ ...saved, deleted: true });
  await expect(
    updateMissionControlTask(api, withTasks, itemId, { title: "Renamed" }),
  ).rejects.toThrow(/no longer/);
});
