// @effect-diagnostics nodeBuiltinImport:off -- Uses the existing same-user Composio CLI.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import type { MissionControlItem, MissionControlResponse } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { gmailThread, safeProviderUrl } from "./triage.ts";
import { teamLaneOrder, teamTaskContext } from "./context.ts";

type Obj = Record<string, unknown>;
type Source = MissionControlResponse["sources"][number];
type Account = { readonly label: string; readonly selector: string; readonly email: string };
type Arg = string | number | boolean;
type Params = Record<string, Arg>;
type Items = { items: MissionControlItem[]; partial?: boolean; note?: string };
export type Bindings = {
  mail: Account[];
  slack: string;
  linear: string;
  tasks: string;
  nebos: string;
  srcosTenant: string;
};
export type Connector = ReturnType<typeof connector>;

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const providerResponseLimit = 4 * 1024 * 1024;
const readActions = new Set([
  "SLACK_SEARCH_MESSAGES",
  "GOOGLETASKS_LIST_TASK_LISTS",
  "GOOGLETASKS_LIST_TASKS",
  "CUSTOM_NEBOS_TASK_LIST",
  "CUSTOM_NEBOS_LIST_WORKSTREAMS",
  "CUSTOM_NEBOS_LIST_WORKSTREAM_RUNS",
]);
const assignedIssuesQuery = `query ScreddyMissionControl($after: String) {
  viewer { email }
  issues(first: 50, after: $after, filter: {
    assignee: {isMe: {eq: true}},
    state: {type: {nin: ["completed", "canceled"]}}
  }) {
    nodes {
      id identifier title priority dueDate updatedAt url
      state { name type }
      project { name }
      labels { nodes { name } }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;
const completionTargetQuery = `query ScreddyLinearCompletionTarget($id: String!) {
  viewer { id email }
  issue(id: $id) {
    id
    assignee { id }
    state { id name type }
    team {
      states(first: 50, filter: { type: { eq: "completed" } }) {
        nodes { id name type }
        pageInfo { hasNextPage }
      }
    }
  }
}`;
const completeIssueMutation = `mutation ScreddyCompleteIssue($id: String!, $state: String!) {
  issueUpdate(id: $id, input: {stateId: $state}) { success issue { id state { id name type } } }
}`;

const proxyOrigins = { gmail: "https://gmail.googleapis.com", slack: "https://slack.com" };

export function obj(input: unknown): Obj {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Obj) : {};
}

export function rows(input: unknown): Obj[] {
  return Array.isArray(input) ? input.map(obj) : [];
}

export function str(input: unknown) {
  return typeof input === "string" ? input : "";
}

function text(input: unknown, length = 240) {
  return str(input).replace(/\s+/g, " ").trim().slice(0, length);
}

const dueDate = (value: unknown) => {
  const date = str(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
};

export async function bindingsAt(baseDir: string): Promise<Bindings | undefined> {
  try {
    const raw = obj(
      JSON.parse(await NodeFSP.readFile(NodePath.join(baseDir, "mission-control.json"), "utf8")),
    );
    const selector = (value: unknown) =>
      /^[\w.@-]{1,128}$/.test(str(value)) && !str(value).startsWith("-");
    const mail = rows(raw.mail).flatMap((entry) => {
      const { label, email } = entry;
      return typeof label === "string" &&
        /^[a-zA-Z][\w -]{0,31}$/.test(label) &&
        typeof email === "string" &&
        /^[\w.+-]+@[\w.-]+$/.test(email) &&
        selector(entry.selector)
        ? [{ label, email, selector: str(entry.selector) }]
        : [];
    });
    return {
      mail,
      slack: selector(raw.slack) ? str(raw.slack) : "",
      linear: selector(raw.linear) ? str(raw.linear) : "",
      tasks: selector(raw.tasks) ? str(raw.tasks) : "",
      nebos: selector(raw.nebos) ? str(raw.nebos) : "",
      srcosTenant: /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(str(raw.srcosTenant))
        ? str(raw.srcosTenant)
        : "",
    };
  } catch {
    return undefined;
  }
}

async function readComposioArtifact(data: Obj, directory: string) {
  const path = str(data.outputFilePath);
  const logId = str(data.logId);
  if (data.successful !== true || !logId || !NodePath.isAbsolute(path)) {
    throw new Error("Invalid provider result file");
  }
  const [root, file] = await Promise.all([NodeFSP.realpath(directory), NodeFSP.realpath(path)]);
  const relative = NodePath.relative(root, file);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith("../") ||
    NodePath.isAbsolute(relative)
  ) {
    throw new Error("Provider result file is outside its temporary directory");
  }
  const info = await NodeFSP.stat(file);
  if (!info.isFile() || info.uid !== process.getuid?.() || info.size > providerResponseLimit) {
    throw new Error("Invalid provider result file");
  }
  const result = obj(JSON.parse(await NodeFSP.readFile(file, "utf8")));
  if (result.logId !== logId) throw new Error("Provider result does not match the request");
  return result;
}

export function connector(home: string) {
  async function run(args: string[], stdin?: string, artifactDirectory?: string) {
    const command = exec(NodePath.join(home, ".composio", "composio"), args, {
      cwd: home,
      timeout: 18_000,
      maxBuffer: providerResponseLimit,
      ...(artifactDirectory && { env: { ...process.env, TMPDIR: artifactDirectory } }),
    });
    command.child.stdin?.on("error", () => {});
    command.child.stdin?.end(stdin);
    const { stdout, stderr } = await command;
    const inline = obj(JSON.parse(stdout.trim() || stderr.trim()));
    const data =
      inline.storedInFile === true && artifactDirectory
        ? await readComposioArtifact(inline, artifactDirectory)
        : inline;
    if (data.successful === false || data.ok === false || data.error)
      throw new Error("Provider unavailable");
    return data;
  }

  function post(toolkit: "gmail" | "linear", account: string, url: string, data: Obj) {
    if (!account) throw new Error("Account required");
    return run(
      [
        "proxy",
        url,
        "--toolkit",
        toolkit,
        "--account",
        account,
        "-X",
        "POST",
        "-H",
        "Content-Type: application/json",
        "-d",
        "-",
      ],
      JSON.stringify(data),
    );
  }

  async function linearGraphql(account: string, query: string, variables: Obj) {
    const result = await post("linear", account, "https://api.linear.app/graphql", {
      query,
      variables,
    });
    if (Array.isArray(result.errors) || !result.data) throw new Error("Linear request failed");
    return obj(result.data);
  }

  return {
    async proxy(
      toolkit: keyof typeof proxyOrigins,
      account: string,
      path: string,
      params: Params = {},
    ) {
      if (!account) throw new Error("Account required");
      const url = new URL(proxyOrigins[toolkit] + path);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
      const result = await run(["proxy", url.href, "--toolkit", toolkit, "--account", account]);
      if (result.ok === false) throw new Error("Provider rejected request");
      return result;
    },
    async linearIssues(account: string, after: string | null) {
      const data = await linearGraphql(account, assignedIssuesQuery, { after });
      if (!str(obj(data.viewer).email).endsWith("@teamnebula.ai"))
        throw new Error("Linear identity unavailable");
      return obj(data.issues);
    },
    linearCompletionTarget(account: string, id: string) {
      return linearGraphql(account, completionTargetQuery, { id });
    },
    completeLinearIssue(account: string, id: string, state: string) {
      return linearGraphql(account, completeIssueMutation, { id, state });
    },
    sendGmailReply(account: string, threadId: string, raw: string) {
      return post("gmail", account, proxyOrigins.gmail + "/gmail/v1/users/me/messages/send", {
        threadId,
        raw,
      });
    },
    async action(tool: string, account: string, params: Params = {}) {
      if (!account || !readActions.has(tool)) throw new Error("Read operation unavailable");
      const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "screddy-composio-"));
      const result = await run(
        ["execute", tool, "--account", account, "-d", JSON.stringify(params)],
        undefined,
        directory,
      ).finally(() => NodeFSP.rm(directory, { recursive: true, force: true }).catch(() => {}));
      if (result.successful !== true || !result.data) throw new Error("Provider rejected request");
      const data = obj(result.data);
      if (data.ok === false || data.error || (data.status && data.status !== "ok")) {
        throw new Error("Provider rejected request");
      }
      return data;
    },
  };
}

export async function verifyMailbox(api: Connector, account: Account) {
  const profile = await api.proxy("gmail", account.selector, "/gmail/v1/users/me/profile");
  if (str(profile.emailAddress).toLowerCase() !== account.email.toLowerCase()) {
    throw new Error("Mailbox identity does not match");
  }
}

export function gmailMessages(list: Obj) {
  return rows(list.messages).map((item) => ({
    id: str(item.id),
    internalDate: str(item.internalDate),
    labelIds: Array.isArray(item.labelIds) ? item.labelIds.map(str) : [],
    snippet: str(item.snippet),
    payload: {
      headers: rows(obj(item.payload).headers).map((h) => ({
        name: str(h.name),
        value: str(h.value),
      })),
    },
  }));
}

async function batch<T, U>(items: readonly T[], read: (entry: T) => Promise<U>) {
  const result: PromiseSettledResult<U>[] = [];
  for (let i = 0; i < items.length; i += 6) {
    result.push(...(await Promise.allSettled(items.slice(i, i + 6).map(read))));
  }
  return result;
}

export async function readMail(
  api: Connector,
  account: Account,
  cursor: string | null,
  scope: "all" | "recent-replies" | "inbox-replies",
) {
  const inbox = scope !== "all";
  const recent = scope === "recent-replies";
  await verifyMailbox(api, account);
  const result = await api.proxy("gmail", account.selector, "/gmail/v1/users/me/threads", {
    ...(inbox
      ? { q: `in:inbox -category:social -category:promotions${recent ? " newer_than:45d" : ""}` }
      : {}),
    maxResults: recent ? 24 : 15,
    ...(cursor ? { pageToken: cursor } : {}),
  });
  const candidates = rows(result.threads).filter((thread) =>
    /^[a-f0-9]{8,32}$/i.test(str(thread.id)),
  );
  const details = await batch(candidates, async (thread) => {
    const id = str(thread.id);
    const list = await api.proxy("gmail", account.selector, `/gmail/v1/users/me/threads/${id}`, {
      format: "metadata",
      fields: "messages(internalDate,labelIds,snippet,payload(headers))",
    });
    const message = gmailThread(gmailMessages(list), account.email);
    if (!message || (inbox && !message.needsReply)) return undefined;
    return {
      id: `gmail:${account.label}:${id}`,
      source: "email",
      account: account.label,
      title: message.title,
      detail: message.sender,
      activity: message.activity,
      url: `https://mail.google.com/mail/u/${encodeURIComponent(account.email)}/#all/${id}`,
      due: null,
      urgency: message.important ? "high" : "normal",
      canReply: message.canReply,
      ...(message.needsReply && { taskContext: { workflow: "productivity" as const } }),
    } satisfies MissionControlItem;
  });
  const failed = details.some((item) => item.status === "rejected");
  const nextCursor = str(result.nextPageToken) || null;
  return {
    items: details.flatMap((entry) =>
      entry.status === "fulfilled" && entry.value ? [entry.value] : [],
    ),
    partial: failed || (recent && Boolean(nextCursor)),
    note: failed
      ? "Some Gmail thread histories could not be checked."
      : recent
        ? "Reply candidates from up to 24 recent inbox threads in the last 45 days."
        : inbox
          ? "Potential replies from the inbox threads on this page."
          : "",
    nextCursor,
  };
}

function slackRoot(message: Obj) {
  const thread = str(message.thread_ts) || str(obj(message.db_message).thread_ts);
  return thread || str(message.ts);
}

export async function readSlack(api: Connector, account: string, today: string): Promise<Items> {
  const auth = await api.proxy("slack", account, "/api/auth.test");
  const me = str(auth.user_id);
  const team = str(auth.team_id);
  if (!me || !team) throw new Error("Slack identity unavailable");
  const from = DateTime.formatIsoDateUtc(DateTime.makeUnsafe(Date.parse(today) - 30 * 86_400_000));
  const searches = await Promise.allSettled(
    ["is:dm", `<@${me}>`].map((query) =>
      api.action("SLACK_SEARCH_MESSAGES", account, {
        query: `${query} after:${from}`,
        count: 14,
        sort: "timestamp",
        sort_dir: "desc",
      }),
    ),
  );
  if (searches.every((outcome) => outcome.status === "rejected"))
    throw new Error("Slack search unavailable");
  const found = new Map<string, { hit: Obj; dm: boolean }>();
  let partial = false;
  for (const [index, outcome] of searches.entries()) {
    if (outcome.status === "rejected") {
      partial = true;
      continue;
    }
    const results = obj(outcome.value.messages);
    const matches = rows(results.matches);
    partial ||= Number(results.total) > matches.length;
    for (const hit of matches) {
      const channel = obj(hit.channel);
      if (hit.team !== team || channel.is_ext_shared === true || !hit.user) continue;
      if (index === 1 && !str(hit.text).includes(`<@${me}>`)) continue;
      const key = `${str(channel.id)}:${index === 0 ? "dm" : slackRoot(hit)}`;
      if (!found.has(key)) found.set(key, { hit, dm: index === 0 });
    }
  }
  const queue = [...found.values()]
    .filter(({ hit }) => hit.user !== me)
    .toSorted((a, b) => Number(b.hit.ts) - Number(a.hit.ts));
  partial ||= queue.length > 12;
  const checked = await batch(queue.slice(0, 12), async ({ hit, dm }) => {
    const channel = obj(hit.channel);
    const channelId = str(channel.id);
    const ts = str(hit.ts);
    const root = slackRoot(hit);
    if (!/^[CDG][A-Z0-9]+$/.test(channelId) || !/^\d+\.\d+$/.test(ts) || !/^\d+\.\d+$/.test(root)) {
      return undefined;
    }
    const method = dm && root === ts ? "history" : "replies";
    const history = await api.proxy("slack", account, `/api/conversations.${method}`, {
      channel: channelId,
      ...(method === "replies" ? { ts: root } : {}),
      oldest: ts,
      limit: 50,
    });
    if (history.has_more || obj(history.response_metadata).next_cursor)
      throw new Error("Partial Slack history");
    const later = rows(history.messages).filter((reply) => Number(reply.ts) > Number(ts));
    if (later.some((reply) => reply.user === me) || (method === "history" && later.length > 0))
      return undefined;
    if (method === "history") {
      const thread = await api.proxy("slack", account, "/api/conversations.replies", {
        channel: channelId,
        ts,
        limit: 50,
      });
      if (thread.has_more || obj(thread.response_metadata).next_cursor)
        throw new Error("Partial Slack thread");
      if (rows(thread.messages).some((reply) => reply.user === me)) return undefined;
    }
    const title = text(hit.text)
      .replaceAll(`<@${me}>`, "@you")
      .replace(/<https?:[^>]+>/g, "[link]")
      .slice(0, 170);
    const activity = Number(ts) * 1_000;
    if (!title || !Number.isFinite(activity)) return undefined;
    return {
      id: `slack:${channelId}:${root}`,
      source: "slack",
      account: "Team Nebula",
      title,
      detail: dm ? "Direct message" : "Mention",
      url: safeProviderUrl(hit.permalink, "slack.com", true),
      activity: DateTime.formatIso(DateTime.makeUnsafe(activity)),
      due: null,
      urgency: "normal",
    } satisfies MissionControlItem;
  });
  return {
    items: checked.flatMap((entry) =>
      entry.status === "fulfilled" && entry.value ? [entry.value] : [],
    ),
    partial: partial || checked.some((entry) => entry.status === "rejected"),
    note: "Recent DMs and mentions, checked for a later reply in Slack history.",
  };
}

export async function readLinear(api: Connector, account: string): Promise<Items> {
  const items: MissionControlItem[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const result: Obj = await api.linearIssues(account, cursor).catch((error: unknown) => {
      if (page === 0) throw error;
      return {};
    });
    if (!Array.isArray(result.nodes)) break;
    for (const issue of rows(result.nodes)) {
      const state = obj(issue.state);
      if (
        ["completed", "canceled"].includes(str(state.type)) ||
        /^(done|completed|cancelled|canceled|duplicate|closed|won't do)$/i.test(str(state.name))
      )
        continue;
      const url = safeProviderUrl(issue.url, "linear.app");
      if (!url || !issue.id || !issue.title) continue;
      const priority = Number(issue.priority);
      const issueTitle = text(issue.title);
      items.push({
        id: `linear:${str(issue.id)}`,
        source: "linear",
        account: "Team Nebula",
        title: issueTitle,
        detail: [text(issue.identifier, 30), text(state.name, 40)].filter(Boolean).join(" · "),
        url,
        activity: str(issue.updatedAt),
        due: dueDate(issue.dueDate),
        urgency: priority === 1 ? "urgent" : priority === 2 ? "high" : "normal",
        taskContext: teamTaskContext(
          issueTitle,
          text(obj(issue.project).name),
          rows(obj(issue.labels).nodes).map((label) => text(label.name)),
        ),
      });
    }
    const pageInfo = obj(result.pageInfo);
    if (pageInfo.hasNextPage !== true) return { items };
    const next = str(pageInfo.endCursor);
    if (!next || cursor === next) break;
    cursor = next;
  }
  return {
    items,
    partial: true,
    note: "Some assigned Linear issues fall outside the fetched pages.",
  };
}

export async function readTasks(api: Connector, account: string): Promise<Items> {
  const items: MissionControlItem[] = [];
  const lists: Obj[] = [];
  let cursor = "";
  for (let page = 0; page < 10; page++) {
    const result = await api.action("GOOGLETASKS_LIST_TASK_LISTS", account, {
      maxResults: 100,
      ...(cursor ? { pageToken: cursor } : {}),
    });
    lists.push(...rows(result.items));
    cursor = str(result.nextPageToken);
    if (!cursor) break;
  }
  let partial = Boolean(cursor);
  for (const entry of await batch(lists, async (list) => {
    const listItems: MissionControlItem[] = [];
    let next = "";
    for (let page = 0; page < 10; page++) {
      const result = await api.action("GOOGLETASKS_LIST_TASKS", account, {
        tasklist_id: str(list.id),
        maxResults: 20,
        showCompleted: false,
        showHidden: false,
        ...(next ? { pageToken: next } : {}),
      });
      const tasks = result.tasks ?? result.items;
      if (!Array.isArray(tasks)) throw new Error("Google Tasks returned no task page");
      for (const task of rows(tasks)) {
        if (task.status !== "needsAction" || !task.title || !task.id) continue;
        listItems.push({
          id: `tasks:${str(list.id)}:${str(task.id)}`,
          source: "tasks",
          account: "Personal",
          title: text(task.title),
          detail: text(list.title, 70),
          url:
            safeProviderUrl(task.webViewLink, "tasks.google.com") ??
            safeProviderUrl(task.webViewLink, "assistant.google.com") ??
            "https://tasks.google.com/",
          activity: str(task.updated),
          due: dueDate(task.due),
          urgency: "normal",
        });
      }
      next = str(result.nextPageToken);
      if (!next) break;
    }
    return { items: listItems, partial: Boolean(next) };
  })) {
    if (entry.status === "rejected") partial = true;
    else {
      items.push(...entry.value.items);
      partial ||= entry.value.partial;
    }
  }
  return {
    items,
    partial,
    note: partial ? "Some Google Tasks lists or pages could not be checked." : "",
  };
}

export async function sharedContext(home: string) {
  const path = NodePath.join(
    home,
    "TeamNebula",
    "team-context",
    "projects-context",
    "tmn",
    "CONTEXT.md",
  );
  const contents = await NodeFSP.readFile(path, "utf8");
  return teamLaneOrder(contents);
}

export async function readNebosWorkstreams(api: Connector, account: string) {
  const data = await api.action("CUSTOM_NEBOS_LIST_WORKSTREAMS", account);
  if (!Array.isArray(data.result)) throw new Error("NEBOS workstream index unavailable");
  return rows(data.result)
    .filter((row) => row.enabled === true)
    .flatMap((row) => [text(row.key, 80), text(row.title, 100)].filter(Boolean));
}

export async function readNebos(api: Connector, account: string): Promise<Items> {
  const limit = 200;
  const reads = await Promise.allSettled(
    ["todo", "in_progress", "blocked", "review"].map((status) =>
      api.action("CUSTOM_NEBOS_TASK_LIST", account, { status, limit }).then((data) => {
        const tasks = obj(data.result).tasks;
        if (!Array.isArray(tasks)) throw new Error("NEBOS returned no task list");
        return rows(tasks);
      }),
    ),
  );
  if (reads.every((read) => read.status === "rejected")) throw new Error("NEBOS unavailable");
  const tasks = reads.flatMap((read) => (read.status === "fulfilled" ? read.value : []));
  const globalTasks = tasks.filter(
    (task) =>
      !task.clientId &&
      task.clientVisible === false &&
      ["todo", "in_progress", "review", "blocked"].includes(str(task.status)) &&
      task.id &&
      task.title,
  );
  const items = globalTasks.map((task): MissionControlItem => ({
    id: `nebos:${str(task.id)}`,
    source: "nebos",
    account: "Team Nebula",
    title: text(task.title),
    detail: ["Internal task", str(task.status).replaceAll("_", " ")].join(" · "),
    url: "https://os.teamnebula.ai/",
    activity: str(task.updatedAt),
    due: dueDate(task.dueDate),
    urgency: ["urgent", "critical"].includes(str(task.priority).toLowerCase())
      ? "urgent"
      : task.priority === "high" || task.status === "blocked"
        ? "high"
        : "normal",
    taskContext: teamTaskContext(
      text(task.title),
      text(obj(task.project).name),
      Array.isArray(task.tags) ? task.tags.map((tag) => text(tag, 80)) : [],
    ),
  }));
  return {
    items,
    partial: reads.some((read) => read.status === "rejected" || read.value.length >= limit),
    note: items.length
      ? "Internal NEBOS tasks."
      : "No internal NEBOS tasks were found in the checked batches.",
  };
}

export function sourceStatus(
  source: Source["source"],
  account: string,
  outcome: PromiseSettledResult<Items>,
): Source {
  return outcome.status === "fulfilled"
    ? {
        source,
        account,
        state: outcome.value.partial ? "partial" : "ready",
        detail: outcome.value.note || "",
      }
    : {
        source,
        account,
        state: "unavailable",
        detail: "The existing connection did not return usable data.",
      };
}
