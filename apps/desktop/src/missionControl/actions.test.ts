// @effect-diagnostics nodeBuiltinImport:off -- Temporary local reply receipts are part of the behavior under test.
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

function slackFixture() {
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
      expect(params).toEqual({ channel: "C0LAUNCH" });
      return { channel: { id: "C0LAUNCH", name: "launch" } };
    }
    expect(path).toBe("/api/conversations.replies");
    expect(params).toMatchObject({ channel: "C0LAUNCH", ts: "1794952800.000100" });
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
    postSlackReply,
    setThread(messages: Record<string, unknown>[]) {
      thread = messages;
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
