// @effect-diagnostics nodeBuiltinImport:off -- Local receipts retain no mail content.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import type { MissionControlActionRequest } from "@t3tools/contracts";

import {
  gmailMessages,
  obj,
  rows,
  str,
  verifyMailbox,
  type Bindings,
  type Connector,
} from "./sources.ts";
import { gmailHeader, gmailThread, orderedGmailMessages } from "./triage.ts";

export class MissionControlActionError extends Schema.TaggedError<MissionControlActionError>()(
  "MissionControlActionError",
  { message: Schema.String },
) {}

function actionError(message: string) {
  return new MissionControlActionError({ message });
}

const gmailItemId = /^gmail:([a-zA-Z][\w -]{0,31}):([a-f0-9]{8,32})$/i;
const linearItemId = /^linear:([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i;
const linearStateId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const mailbox =
  /^[A-Za-z0-9.!#$%&'*+/=?^_{}|~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z0-9-]+$/;
const messageId = /^<[^\s<>@]{1,250}@[^\s<>@]{1,250}>$/;
const unconfirmed = "Gmail did not confirm the send. Check Sent in Gmail before sending again.";

function hash(parts: readonly string[]) {
  return NodeCrypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function singleAddress(header: string) {
  if (/\r|\n/.test(header)) return "";
  const value = header.trim();
  const address =
    value.match(/^(?:"(?:[^"\\]|\\.)*"|[^<>,;:@"]*)\s*<([^<>]+)>$/)?.[1]?.trim() ?? value;
  return mailbox.test(address) ? address : "";
}

function replyMailbox(bindings: Bindings, itemId: string) {
  const parts = gmailItemId.exec(itemId);
  const accounts = bindings.mail.filter(({ label }) => label === parts?.[1]);
  if (!parts || accounts.length !== 1 || !mailbox.test(accounts[0]!.email)) {
    throw actionError("This email no longer matches a configured mailbox.");
  }
  return { account: accounts[0]!, threadId: parts[2]! };
}

async function readReply(api: Connector, bindings: Bindings, itemId: string) {
  const { account, threadId } = replyMailbox(bindings, itemId);
  await verifyMailbox(api, account);
  const result = await api.proxy(
    "gmail",
    account.selector,
    "/gmail/v1/users/me/threads/" + threadId,
    {
      format: "metadata",
      fields: "id,messages(id,internalDate,labelIds,snippet,payload(headers))",
    },
  );
  const messages = gmailMessages(result);
  const newest = orderedGmailMessages(messages)[0];
  if (result.id !== threadId || !newest?.id || !gmailThread(messages, account.email)?.canReply) {
    throw actionError("There is no current incoming message to reply to in this thread.");
  }
  const targetHeader = gmailHeader(newest, "reply-to") || gmailHeader(newest, "from");
  const recipient = singleAddress(targetHeader);
  const parent = gmailHeader(newest, "message-id").trim();
  const subject = gmailHeader(newest, "subject")
    .replace(/\r?\n[ \t]+/g, " ")
    .trim();
  if (
    !recipient ||
    recipient.toLowerCase() === account.email.toLowerCase() ||
    !messageId.test(parent) ||
    /[\r\n\0]/.test(subject) ||
    subject.length > 950
  ) {
    throw actionError(
      "Screddy couldn't verify one reply recipient and a valid message thread. Open the email in Gmail to reply.",
    );
  }
  const references = (gmailHeader(newest, "references").match(/<[^<>]+>/g) ?? [])
    .filter((id) => messageId.test(id) && id !== parent)
    .slice(-10);
  const revision = hash([
    account.selector,
    account.email,
    threadId,
    newest.id,
    recipient,
    parent,
    subject,
  ]);
  return {
    account,
    threadId,
    parent,
    references,
    recipient,
    subject,
    revision,
    snippet: newest.snippet?.slice(0, 320) ?? "",
  };
}

export async function previewMissionControlReply(
  api: Connector,
  bindings: Bindings,
  itemId: string,
) {
  const { account, recipient, subject, snippet, revision } = await readReply(api, bindings, itemId);
  return { ok: true as const, from: account.email, to: recipient, subject, snippet, revision };
}

function encodeSubject(subject: string) {
  if (/^[\x20-\x7e]*$/.test(subject)) return subject;
  const words: string[] = [];
  let bytes = 0;
  let chunk = "";
  for (const char of subject) {
    const size = Buffer.byteLength(char);
    if (bytes + size > 42) {
      words.push(chunk);
      bytes = 0;
      chunk = "";
    }
    chunk += char;
    bytes += size;
  }
  if (chunk) words.push(chunk);
  return words
    .map((word) => "=?UTF-8?B?" + Buffer.from(word).toString("base64") + "?=")
    .join("\r\n ");
}

function rawReply(target: Awaited<ReturnType<typeof readReply>>, body: string) {
  const references = [...target.references, target.parent].join("\r\n ");
  const encodedBody = Buffer.from(body.replace(/\r\n?|\n/g, "\r\n"), "utf8").toString("base64");
  const mime = [
    "From: " + target.account.email,
    "To: " + target.recipient,
    "Subject: " + encodeSubject(target.subject),
    "Message-ID: <screddy." + target.revision + "@screddy.local>",
    "In-Reply-To: " + target.parent,
    "References: " + references,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    ...(encodedBody.match(/.{1,76}/g) ?? []),
    "",
  ].join("\r\n");
  return Buffer.from(mime, "utf8").toString("base64url");
}

export async function sendMissionControlReply(
  api: Connector,
  bindings: Bindings,
  baseDir: string,
  request: Extract<MissionControlActionRequest, { kind: "reply" }>,
) {
  const body = request.body;
  if (!body.trim()) throw actionError("Enter a reply before sending.");
  const receiptDirectory = NodePath.join(baseDir, "mission-control-replies");
  const receipt = NodePath.join(receiptDirectory, hash([request.itemId, request.revision]));
  const sentReceipt = receipt + ".sent";
  const done = { ok: true as const, message: "Reply sent." };
  if (
    await NodeFSP.access(sentReceipt).then(
      () => true,
      () => false,
    )
  )
    return { ...done, message: "A reply to this message was already sent." };
  if (
    await NodeFSP.access(receipt).then(
      () => true,
      () => false,
    )
  )
    throw actionError(unconfirmed);

  const target = await readReply(api, bindings, request.itemId);
  if (target.revision !== request.revision) {
    throw actionError(
      "The email changed since you opened the reply. Review the current recipient and email before sending.",
    );
  }
  await NodeFSP.mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
  try {
    await NodeFSP.writeFile(receipt, "", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (obj(error).code === "EEXIST") throw actionError(unconfirmed);
    throw error;
  }

  // Reserve the exact incoming message before dispatch. A lost acknowledgement
  // cannot produce a second send, even after restarting the desktop.
  const result = await api
    .sendGmailReply(target.account.selector, target.threadId, rawReply(target, body))
    .catch(() => null);
  if (!result?.id || result.threadId !== target.threadId) throw actionError(unconfirmed);
  await NodeFSP.writeFile(sentReceipt, "", { flag: "wx", mode: 0o600 }).catch(() => {});
  return done;
}

function completionState(connection: Record<string, unknown>) {
  if (obj(connection.pageInfo).hasNextPage !== false) {
    throw actionError("Linear did not return the full list of completed statuses.");
  }
  const completed = rows(connection.nodes).filter(
    (state) => state.type === "completed" && linearStateId.test(str(state.id)),
  );
  const preferred = completed.filter((state) =>
    /^(done|complete|completed)$/i.test(str(state.name).trim()),
  );
  const chosen =
    completed.length === 1 ? completed[0] : preferred.length === 1 ? preferred[0] : undefined;
  if (!chosen)
    throw actionError("This team has no single completed status. Choose the status in Linear.");
  return str(chosen.id);
}

export async function completeMissionControlIssue(
  api: Connector,
  bindings: Bindings,
  itemId: string,
) {
  const id = itemId.match(linearItemId)?.[1];
  if (!id || !bindings.linear) throw actionError("This item is not a configured Linear issue.");
  const check = async () => {
    const read = await api.linearCompletionTarget(bindings.linear, id);
    const { id: viewer, email } = obj(read.viewer);
    const issue = obj(read.issue);
    if (
      typeof viewer !== "string" ||
      !viewer ||
      !str(email).toLowerCase().endsWith("@teamnebula.ai") ||
      issue.id !== id ||
      obj(issue.assignee).id !== viewer
    ) {
      throw actionError(
        "Linear could not verify that this issue is assigned to your connected account.",
      );
    }
    return issue;
  };
  const issue = await check();
  const state = obj(issue.state);
  if (state.type === "completed")
    return { ok: true as const, message: "Already complete in Linear." };
  if (state.type === "canceled" || !state.type) {
    throw actionError("This issue is no longer open in Linear.");
  }

  const target = completionState(obj(obj(issue.team).states));
  const update = await api.completeLinearIssue(bindings.linear, id, target).catch(() => null);
  const mutation = obj(update?.issueUpdate);
  const updated = obj(mutation.issue);
  const completed = obj(updated.state);
  if (
    mutation.success !== true ||
    updated.id !== id ||
    completed.type !== "completed" ||
    completed.id !== target
  ) {
    const current = await check().catch(() => null);
    if (obj(current?.state).type !== "completed") {
      throw actionError("Linear did not confirm completion. Check the issue in Linear.");
    }
  }
  return { ok: true as const, message: "Marked complete in Linear." };
}
