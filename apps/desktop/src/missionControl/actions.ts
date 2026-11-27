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
const taskItemId = /^tasks:([\w-]{1,64}):([\w-]{1,64})$/;
const linearStateId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const mailbox =
  /^[A-Za-z0-9.!#$%&'*+/=?^_{}|~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z0-9-]+$/;
const messageId = /^<[^\s<>@]{1,250}@[^\s<>@]{1,250}>$/;
const unconfirmed = "Gmail did not confirm the send. Check Sent in Gmail before sending again.";
const slackItemId = /^slack:([CDG][A-Z0-9]{1,30}):(\d{1,12}\.\d{1,8})$/;
const slackUser = /^[UW][A-Z0-9]{1,30}$/;
const slackUnconfirmed =
  "Slack did not confirm the reply. Check the thread in Slack before sending again.";

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

function slackLine(input: unknown, me: string, length: number) {
  return str(input)
    .replace(/\s+/g, " ")
    .trim()
    .replaceAll(`<@${me}>`, "@you")
    .replace(/<https?:[^>]+>/g, "[link]")
    .slice(0, length);
}

function slackPage(page: Record<string, unknown>) {
  // A thread longer than one page could hide a newer message, so it is never guessed at.
  if (page.has_more || obj(page.response_metadata).next_cursor) {
    throw actionError("This Slack conversation is too long to check here. Reply in Slack.");
  }
  return rows(page.messages);
}

/**
 * Applies the rule Mission Control used to list the item: a DM, or a message that mentions you,
 * with no later message of yours in the thread (or, for a DM with no thread, in the DM).
 */
async function readSlackReply(api: Connector, bindings: Bindings, itemId: string) {
  const [, channel, root] = slackItemId.exec(itemId) ?? [];
  const account = bindings.slack;
  if (!channel || !root || !account)
    throw actionError("This item is not a configured Slack thread.");
  const auth = await api.proxy("slack", account, "/api/auth.test");
  const me = str(auth.user_id);
  const team = str(auth.team_id);
  if (!slackUser.test(me) || !team || auth.bot_id) {
    throw actionError("Slack could not confirm that the reply would come from your own account.");
  }
  const info = obj(
    (await api.proxy("slack", account, "/api/conversations.info", { channel })).channel,
  );
  if (info.id !== channel || info.is_archived === true || info.is_ext_shared === true) {
    throw actionError("Screddy can't reply in this Slack conversation. Open it in Slack.");
  }
  const thread = slackPage(
    await api.proxy("slack", account, "/api/conversations.replies", {
      channel,
      ts: root,
      limit: 200,
    }),
  ).toSorted((a, b) => Number(a.ts) - Number(b.ts));
  const dm = info.is_im === true || info.is_mpim === true;
  const anchor = thread.findLast(
    (message) =>
      slackUser.test(str(message.user)) &&
      message.user !== me &&
      (dm || str(message.text).includes(`<@${me}>`)),
  );
  const first = thread.find((message) => message.ts === root);
  const newest = thread.at(-1);
  if (!first || !anchor || !newest) {
    throw actionError("This Slack thread no longer has a message waiting on you.");
  }
  const mine = (messages: Record<string, unknown>[]) =>
    messages.some((message) => message.user === me && Number(message.ts) > Number(anchor.ts));
  if (
    mine(thread) ||
    (dm &&
      thread.length === 1 &&
      mine(
        slackPage(
          await api.proxy("slack", account, "/api/conversations.history", {
            channel,
            oldest: root,
            limit: 50,
          }),
        ),
      ))
  ) {
    throw actionError("You already replied in this Slack thread.");
  }
  let to = info.name ? "#" + slackLine(info.name, me, 80) : "Slack channel";
  if (info.is_mpim === true) to = "Group direct message";
  if (info.is_im === true) {
    const person = slackUser.test(str(info.user))
      ? obj((await api.proxy("slack", account, "/api/users.info", { user: str(info.user) })).user)
      : {};
    const name = slackLine(
      obj(person.profile).real_name || person.real_name || person.name,
      me,
      80,
    );
    to = name ? "Direct message with " + name : "Direct message";
  }
  const user = slackLine(auth.user, me, 80);
  const from = (user ? "@" + user : me) + (auth.team ? ` (${slackLine(auth.team, me, 80)})` : "");
  return {
    account,
    channel,
    root,
    me,
    from,
    to,
    subject: slackLine(first.text, me, 170) || "Slack thread",
    snippet: slackLine(anchor.text, me, 320),
    revision: hash([account, team, me, channel, root, str(anchor.ts), str(newest.ts), to]),
  };
}

export async function previewMissionControlReply(
  api: Connector,
  bindings: Bindings,
  itemId: string,
) {
  if (itemId.startsWith("slack:")) {
    const { from, to, subject, snippet, revision } = await readSlackReply(api, bindings, itemId);
    return { ok: true as const, from, to, subject, snippet, revision };
  }
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

type ReplyRequest = Extract<MissionControlActionRequest, { kind: "reply" }>;

/** Rechecks the email and returns a send that reports whether Gmail confirmed it. */
async function gmailSend(api: Connector, bindings: Bindings, request: ReplyRequest) {
  const target = await readReply(api, bindings, request.itemId);
  if (target.revision !== request.revision) {
    throw actionError(
      "The email changed since you opened the reply. Review the current recipient and email before sending.",
    );
  }
  return async () => {
    const result = await api.sendGmailReply(
      target.account.selector,
      target.threadId,
      rawReply(target, request.body),
    );
    return Boolean(result?.id) && result.threadId === target.threadId;
  };
}

/** Rechecks the Slack thread and returns a post that reports whether Slack confirmed it. */
async function slackSend(api: Connector, bindings: Bindings, request: ReplyRequest) {
  const target = await readSlackReply(api, bindings, request.itemId);
  if (target.revision !== request.revision) {
    throw actionError(
      "The Slack thread changed since you opened the reply. Review the latest message before sending.",
    );
  }
  // Escaped so the text can't carry Slack mentions such as <!channel> or <@user>.
  const text = request.body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return async () => {
    const result = await api.postSlackReply(target.account, target.channel, target.root, text);
    const message = obj(result.message);
    return (
      result.ok === true &&
      result.channel === target.channel &&
      /^\d+\.\d+$/.test(str(result.ts)) &&
      message.thread_ts === target.root &&
      message.user === target.me
    );
  };
}

export async function sendMissionControlReply(
  api: Connector,
  bindings: Bindings,
  baseDir: string,
  request: ReplyRequest,
) {
  const body = request.body;
  if (!body.trim()) throw actionError("Enter a reply before sending.");
  const slack = request.itemId.startsWith("slack:");
  const unconfirmedReply = slack ? slackUnconfirmed : unconfirmed;
  const receiptDirectory = NodePath.join(baseDir, "mission-control-replies");
  const receipt = NodePath.join(receiptDirectory, hash([request.itemId, request.revision]));
  const sentReceipt = receipt + ".sent";
  const done = { ok: true as const, message: slack ? "Reply posted in Slack." : "Reply sent." };
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
    throw actionError(unconfirmedReply);

  const send = await (slack ? slackSend : gmailSend)(api, bindings, request);
  await NodeFSP.mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
  try {
    await NodeFSP.writeFile(receipt, "", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (obj(error).code === "EEXIST") throw actionError(unconfirmedReply);
    throw error;
  }

  // Reserve the exact incoming message before dispatch. A lost acknowledgement
  // cannot produce a second send, even after restarting the desktop.
  if (!(await send().catch(() => false))) throw actionError(unconfirmedReply);
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
  const expectedEmail = bindings.linearEmail;
  if (!expectedEmail) throw actionError("Configure the connected Linear email to complete issues.");
  const check = async () => {
    const read = await api.linearCompletionTarget(bindings.linear, id);
    const { id: viewer, email } = obj(read.viewer);
    const issue = obj(read.issue);
    if (
      typeof viewer !== "string" ||
      !viewer ||
      str(email).trim().toLowerCase() !== expectedEmail ||
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

export async function completeMissionControlTask(
  api: Connector,
  bindings: Bindings,
  itemId: string,
) {
  const [, list, task] = taskItemId.exec(itemId) ?? [];
  if (!list || !task || !bindings.tasks) {
    throw actionError("This item is not a configured Google Task.");
  }
  const current = await api.googleTask(bindings.tasks, list, task).catch(() => null);
  if (current?.id !== task) throw actionError("This task is no longer in Google Tasks.");
  if (current.status === "completed") {
    return { ok: true as const, message: "Already complete in Google Tasks." };
  }
  const updated = await api.completeGoogleTask(bindings.tasks, list, task).catch(() => null);
  if (updated?.id !== task || updated.status !== "completed") {
    // A lost response must not read as a failure when the task was in fact completed.
    const check = await api.googleTask(bindings.tasks, list, task).catch(() => null);
    if (check?.id !== task || check.status !== "completed") {
      throw actionError("Google Tasks did not confirm completion. Check the task in Google Tasks.");
    }
  }
  return { ok: true as const, message: "Marked complete in Google Tasks." };
}

export interface MissionControlTaskFields {
  readonly title?: string | undefined;
  readonly notes?: string | undefined;
  readonly due?: string | null | undefined;
}

const taskSelfLink = /\/lists\/([\w-]{1,64})\/tasks\/([\w-]{1,64})$/;

function validDay(day: string) {
  const [, year, month, date] = (/^(\d{4})-(\d{2})-(\d{2})$/.exec(day) ?? []).map(Number);
  if (!year || !month || !date || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return date <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
}

/** The Google Tasks body for the fields given; a field left out stays as it is. */
function taskBody(fields: MissionControlTaskFields) {
  const body: Record<string, string | null> = {};
  if (fields.title !== undefined) {
    const title = fields.title.trim();
    if (!title) throw actionError("Give the task a title.");
    if (title.length > 1024) throw actionError("Keep the task title under 1,024 characters.");
    body.title = title;
  }
  if (fields.notes !== undefined) {
    if (fields.notes.length > 8192) throw actionError("Keep the notes under 8,192 characters.");
    body.notes = fields.notes;
  }
  if (fields.due !== undefined) {
    if (fields.due !== null && !validDay(fields.due)) {
      throw actionError("Use a real due date written like 2026-12-01.");
    }
    body.due = fields.due === null ? null : fields.due + "T00:00:00.000Z";
  }
  return body;
}

/** Whether Google Tasks now holds every value in the body. */
function holds(task: Record<string, unknown>, body: Record<string, string | null>) {
  return Object.entries(body).every(([key, value]) =>
    key === "due"
      ? (str(task.due).slice(0, 10) || null) === (value?.slice(0, 10) ?? null)
      : str(task[key]) === value,
  );
}

function taskBinding(bindings: Bindings) {
  if (!bindings.tasks) throw actionError("Google Tasks is not configured for Mission Control.");
  return bindings.tasks;
}

export async function createMissionControlTask(
  api: Connector,
  bindings: Bindings,
  fields: MissionControlTaskFields & { readonly title: string; readonly due?: string | undefined },
) {
  const account = taskBinding(bindings);
  const body = taskBody(fields);
  if (body.notes === "") delete body.notes;
  const created = await api.insertGoogleTask(account, "@default", body).catch(() => null);
  const id = str(created?.id);
  if (!created || !id || !holds(created, body)) {
    throw actionError(
      "Google Tasks did not confirm the new task. Check Google Tasks before adding it again.",
    );
  }
  const [, list, task] = taskSelfLink.exec(str(created.selfLink)) ?? [];
  return {
    ok: true as const,
    message: "Added to Google Tasks.",
    ...(list && task === id && { itemId: `tasks:${list}:${task}` }),
  };
}

export async function updateMissionControlTask(
  api: Connector,
  bindings: Bindings,
  itemId: string,
  fields: MissionControlTaskFields,
) {
  const [, list, task] = taskItemId.exec(itemId) ?? [];
  if (!list || !task || !bindings.tasks) {
    throw actionError("This item is not a configured Google Task.");
  }
  const body = taskBody(fields);
  if (!Object.keys(body).length) throw actionError("Nothing to change on this task.");
  const current = await api.googleTask(bindings.tasks, list, task).catch(() => null);
  if (current?.id !== task || current.deleted === true) {
    throw actionError("This task is no longer in Google Tasks.");
  }
  const updated = await api.updateGoogleTask(bindings.tasks, list, task, body).catch(() => null);
  if (updated?.id !== task || !holds(updated, body)) {
    // A lost response must not read as a failure when the change was in fact saved.
    const check =
      updated?.id === task
        ? null
        : await api.googleTask(bindings.tasks, list, task).catch(() => null);
    if (check?.id !== task || !holds(check, body)) {
      throw actionError("Google Tasks did not confirm the change. Check the task in Google Tasks.");
    }
  }
  return { ok: true as const, message: "Updated in Google Tasks.", itemId };
}
