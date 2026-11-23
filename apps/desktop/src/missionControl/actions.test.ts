// @effect-diagnostics nodeBuiltinImport:off -- Temporary local reply receipts are part of the behavior under test.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it, vi } from "vite-plus/test";

import {
  completeMissionControlIssue,
  previewMissionControlReply,
  sendMissionControlReply,
} from "./actions.ts";
import type { Bindings, Connector } from "./sources.ts";

const bindings: Bindings = {
  mail: [{ label: "Personal", selector: "owner", email: "owner@example.test" }],
  slack: "",
  linear: "team",
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
  const viewer = { id: "owner", email: "owner@teamnebula.ai" };
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
