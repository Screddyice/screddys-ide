// @effect-diagnostics nodeBuiltinImport:off -- Reads same-user CLI status and the local Codex metadata index.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttps from "node:https";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";
import type {
  MissionControlAgentActivity,
  MissionControlAgentRow,
  MissionControlAgentStatus,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { bindingsAt, connector, obj, rows, str, type Bindings } from "./sources.ts";
import { safeProviderUrl } from "./triage.ts";

type Source = MissionControlAgentActivity["sources"][number];
type Feed = { rows: MissionControlAgentRow[]; partial?: boolean; detail?: string };
const execute = NodeUtil.promisify(NodeChildProcess.execFile);
const codexUrl = "https://chatgpt.com/codex";
const cursorUrl = "https://cursor.com/agents";
const claudeUrl = "https://claude.ai/code";
const grokUrl = "https://grok.com/";

function trim(value: unknown, maxLength = 180) {
  return str(value).replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function timestamp(value: unknown): string | null {
  const ms =
    typeof value === "number" ? (value > 1e12 ? value : value * 1_000) : Date.parse(str(value));
  return Number.isFinite(ms) && ms > 0 ? DateTime.formatIso(DateTime.makeUnsafe(ms)) : null;
}

export function providerStatus(value: unknown): MissionControlAgentStatus {
  switch (str(value).toLowerCase().replaceAll("-", "_")) {
    case "running":
    case "busy":
    case "working":
    case "in_progress":
    case "active":
      return "running";
    case "creating":
    case "starting":
    case "queued":
    case "pending":
    case "enqueued":
    case "waiting_for_background_work":
      return "queued";
    case "waiting_for_input":
    case "waiting_for_user":
    case "blocked":
    case "permission":
      return "needs-input";
    case "completed":
    case "complete":
    case "finished":
    case "succeeded":
    case "success":
    case "ok":
    case "ready":
      return "completed";
    case "errored":
    case "error":
    case "failed":
    case "expired":
      return "failed";
    case "stopped":
    case "cancelled":
    case "canceled":
    case "interrupted":
    case "archived":
      return "stopped";
    default:
      return "recent";
  }
}

export function workstreamStatus(
  status: unknown,
  claimedAt: unknown,
  now: number,
): MissionControlAgentStatus {
  if (status !== "pending") return providerStatus(status);
  const claim = Date.parse(str(claimedAt));
  return Number.isFinite(claim) && claim <= now && now - claim < 30 * 60_000 ? "running" : "queued";
}

async function cliJson(
  path: string,
  args: string[],
  home: string,
  env?: NodeJS.ProcessEnv,
): Promise<unknown> {
  const command = execute(path, args, {
    cwd: home,
    timeout: 12_000,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, ...env, NO_COLOR: "1" },
  });
  command.child.stdin?.end();
  const { stdout } = await command;
  return JSON.parse(stdout);
}

async function codexCloud(home: string): Promise<Feed> {
  const data = obj(
    await cliJson("/opt/homebrew/bin/codex", ["cloud", "list", "--json", "--limit", "20"], home),
  );
  if (!Array.isArray(data.tasks)) throw new Error("Codex Cloud returned no task list");
  return {
    rows: rows(data.tasks).flatMap((task) => {
      const id = str(task.id) || str(task.task_id);
      if (!id) return [];
      const reported = safeProviderUrl(task.url, "chatgpt.com");
      const url =
        reported?.replace(
          /^https:\/\/chatgpt\.com\/codex\/tasks\//,
          "https://chatgpt.com/codex/cloud/tasks/",
        ) ?? codexUrl;
      return [
        {
          id: `codex-cloud:${id}`,
          provider: "openai",
          source: "Codex Cloud",
          title: trim(task.title) || "Codex Cloud task",
          detail: trim(task.environment_label ?? task.environmentLabel ?? task.environment, 80),
          status: providerStatus(task.status ?? task.task_status),
          updatedAt: timestamp(
            task.updated_at ?? task.updatedAt ?? task.created_at ?? task.createdAt,
          ),
          url,
        } satisfies MissionControlAgentRow,
      ];
    }),
    partial: Boolean(data.cursor),
    detail: data.tasks.length
      ? "Latest tasks from the signed-in Codex account."
      : "Connected. Codex Cloud returned no tasks.",
  };
}

const LIVE_WINDOW_MS = 10 * 60_000;
const PROMPT_WINDOW_MS = 60 * 60_000;
const TURN_MARKERS = {
  codex: { open: ["task_started"], closed: ["task_complete", "turn_aborted"] },
  grok: { open: ["turn_started"], closed: ["turn_ended"] },
} as const;

type TurnLogKind = keyof typeof TURN_MARKERS;

function turnLogEvent(kind: TurnLogKind, line: string): { type: string; phase: string } | null {
  if (!line.includes('"type"')) return null;
  try {
    const entry = obj(JSON.parse(line));
    if (kind === "grok") return { type: str(entry.type), phase: str(entry.phase) };
    // A marker quoted inside a message is a string, not the event payload.
    return entry.type === "event_msg" ? { type: str(obj(entry.payload).type), phase: "" } : null;
  } catch {
    return null;
  }
}

/** Whether the newest turn in a CLI session log is still open, and waiting on the user or working. */
export function turnLogStatus(input: {
  readonly kind: TurnLogKind;
  readonly log: string;
  readonly lastWriteMs: number;
  readonly now: number;
}): MissionControlAgentStatus | null {
  const markers = TURN_MARKERS[input.kind];
  const lines = input.log.split("\n");
  let phase = "";
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const event = turnLogEvent(input.kind, lines[index]!);
    if (!event) continue;
    if (!phase && event.type === "phase_changed") phase = event.phase;
    if ((markers.closed as readonly string[]).includes(event.type)) return "recent";
    if (!(markers.open as readonly string[]).includes(event.type)) continue;
    const quietMs = input.now - input.lastWriteMs;
    if (phase === "permission_prompt") {
      return quietMs <= PROMPT_WINDOW_MS ? "needs-input" : "recent";
    }
    // A killed CLI leaves its turn open, so a quiet log stops counting as running.
    return quietMs <= LIVE_WINDOW_MS ? "running" : "recent";
  }
  return null;
}

/** A turn marker can sit megabytes back in a long turn, so widen the tail until one is found. */
async function liveTurnStatus(
  kind: TurnLogKind,
  path: string,
  now: number,
): Promise<MissionControlAgentStatus> {
  try {
    const file = await NodeFSP.open(path, "r");
    try {
      const { size, mtimeMs } = await file.stat();
      if (now - mtimeMs > PROMPT_WINDOW_MS) return "recent";
      for (let bytes = 256 * 1024; ; bytes *= 8) {
        const length = Math.min(bytes, size);
        const buffer = Buffer.alloc(length);
        await file.read(buffer, 0, length, size - length);
        const status = turnLogStatus({
          kind,
          log: buffer.toString("utf8"),
          lastWriteMs: mtimeMs,
          now,
        });
        if (status !== null || length === size || bytes >= 16 * 1024 * 1024) {
          return status ?? "recent";
        }
      }
    } finally {
      await file.close();
    }
  } catch {
    return "recent";
  }
}

/** The newest chat in each folder that has a live cursor-agent process. */
export function cursorLiveChats(
  chats: readonly { readonly id: string; readonly cwd: string; readonly updated: number }[],
  liveCwds: readonly string[],
): ReadonlySet<string> {
  const newest = new Map<string, { id: string; updated: number }>();
  for (const chat of chats) {
    if (!liveCwds.includes(chat.cwd)) continue;
    const current = newest.get(chat.cwd);
    if (!current || chat.updated > current.updated) newest.set(chat.cwd, chat);
  }
  return new Set([...newest.values()].map(({ id }) => id));
}

/** Working folders of running cursor-agent processes; empty when none or when ps/lsof fail. */
async function cursorAgentCwds(): Promise<string[]> {
  try {
    const { stdout } = await execute("/bin/ps", ["-axo", "pid=,command="], { timeout: 5_000 });
    const pids = stdout
      .split("\n")
      .filter((line) => /[/\s]cursor-agent(\s|$|\/)/.test(line))
      .flatMap((line) => line.trim().match(/^\d+/) ?? []);
    if (!pids.length) return [];
    const listed = await execute(
      "/usr/sbin/lsof",
      ["-a", "-p", pids.join(","), "-d", "cwd", "-Fn"],
      { timeout: 5_000 },
    );
    return listed.stdout
      .split("\n")
      .flatMap((line) => (line.startsWith("n") ? [line.slice(1)] : []));
  } catch {
    return [];
  }
}

async function codexHistory(home: string, now: number): Promise<Feed> {
  const db = new NodeSqlite.DatabaseSync(NodePath.join(home, ".codex", "state_5.sqlite"), {
    readOnly: true,
  });
  let records: Record<string, unknown>[];
  try {
    records = db
      .prepare(
        "SELECT id, title, updated_at, rollout_path FROM threads WHERE archived = 0 ORDER BY updated_at DESC LIMIT 20",
      )
      .all();
  } finally {
    db.close();
  }
  const sessions = records.flatMap((r) => {
    const title = trim(r.title);
    return title && r.id ? [{ id: str(r.id), title, record: r }] : [];
  });
  const statuses = await Promise.all(
    sessions.map(({ record }) => liveTurnStatus("codex", str(record.rollout_path), now)),
  );
  return {
    rows: sessions.map(
      ({ id, title, record }, index) =>
        ({
          id: `codex-local:${id}`,
          provider: "openai",
          source: "Codex on this Mac",
          title,
          detail: statuses[index] === "running" ? "Turn in progress" : "Session history",
          status: statuses[index]!,
          updatedAt: timestamp(record.updated_at),
          url: null,
        }) satisfies MissionControlAgentRow,
    ),
    detail: "Local sessions. A session is running while its newest turn is open and still writing.",
  };
}

async function grokHistory(home: string, now: number): Promise<Feed> {
  const sessionsDir = NodePath.join(home, ".grok", "sessions");
  const db = new NodeSqlite.DatabaseSync(NodePath.join(sessionsDir, "session_search.sqlite"), {
    readOnly: true,
  });
  let records: Record<string, unknown>[];
  try {
    records = db
      .prepare(
        "SELECT session_id, title, updated_at, cwd FROM session_docs ORDER BY updated_at DESC LIMIT 20",
      )
      .all();
  } finally {
    db.close();
  }
  const sessions = records.flatMap((entry) => {
    const title = trim(entry.title);
    return entry.session_id && title ? [{ id: str(entry.session_id), title, entry }] : [];
  });
  const statuses = await Promise.all(
    sessions.map(({ id, entry }) =>
      liveTurnStatus(
        "grok",
        NodePath.join(sessionsDir, encodeURIComponent(str(entry.cwd)), id, "events.jsonl"),
        now,
      ),
    ),
  );
  return {
    rows: sessions.map(
      ({ id, title, entry }, index) =>
        ({
          id: `grok-local:${id}`,
          provider: "grok",
          source: "Grok Build on this Mac",
          title,
          detail:
            statuses[index] === "running"
              ? "Turn in progress"
              : statuses[index] === "needs-input"
                ? "Waiting on a permission prompt"
                : "Session history",
          status: statuses[index]!,
          updatedAt: timestamp(entry.updated_at),
          url: null,
        }) satisfies MissionControlAgentRow,
    ),
    detail: "Local Grok Build sessions. A session is running while its newest turn is open.",
  };
}

async function cursorHistory(home: string): Promise<Feed> {
  const folder = NodePath.join(home, ".cursor", "chats");
  await NodeFSP.access(folder);
  const stores: { path: string; updated: number }[] = [];
  for await (const path of NodeFSP.glob("*/*/store.db", { cwd: folder })) {
    const absolute = NodePath.join(folder, path);
    const stats = await NodeFSP.lstat(absolute).catch(() => undefined);
    if (stats?.isFile()) stores.push({ path: absolute, updated: stats.mtimeMs });
    if (stores.length === 200) break;
  }
  let partial = stores.length === 200;
  const entries: MissionControlAgentRow[] = [];
  const chats: { id: string; cwd: string; updated: number }[] = [];
  for (const store of stores.toSorted((a, b) => b.updated - a.updated).slice(0, 20)) {
    try {
      const db = new NodeSqlite.DatabaseSync(store.path, { readOnly: true });
      try {
        // Select only session identity and title. The raw metadata also contains a key.
        const metadata = db
          .prepare(`
          SELECT json_extract(CAST(unhex(value) AS TEXT), '$.agentId') AS id,
                 json_extract(CAST(unhex(value) AS TEXT), '$.name') AS title
          FROM meta WHERE key = '0' AND json_valid(CAST(unhex(value) AS TEXT))
        `)
          .get();
        if (!metadata?.id || !metadata.title) continue;
        const meta = await NodeFSP.readFile(
          NodePath.join(NodePath.dirname(store.path), "meta.json"),
          "utf8",
        ).then(
          (text) => obj(JSON.parse(text)),
          () => obj(undefined),
        );
        chats.push({
          id: `cursor-local:${str(metadata.id)}`,
          cwd: str(meta.cwd),
          updated: store.updated,
        });
        entries.push({
          id: `cursor-local:${str(metadata.id)}`,
          provider: "cursor",
          source: "Cursor on this Mac",
          title: trim(metadata.title),
          detail: "Session history",
          status: "recent",
          updatedAt: timestamp(store.updated),
          url: null,
        });
      } finally {
        db.close();
      }
    } catch {
      partial = true;
    }
  }
  const live = cursorLiveChats(chats, await cursorAgentCwds());
  return {
    rows: entries.map((entry) =>
      live.has(entry.id)
        ? { ...entry, status: "running", detail: "cursor-agent is running" }
        : entry,
    ),
    partial,
    detail:
      "Local Cursor sessions. A chat is running while a cursor-agent process is working in its folder.",
  };
}

async function claudeLocal(home: string, workspaceDir?: string): Promise<Feed> {
  const result = await cliJson(
    NodePath.join(home, ".local", "bin", "claude"),
    ["agents", "--json", "--all"],
    home,
    {
      CLAUDE_CONFIG_DIR: workspaceDir ?? NodePath.join(home, ".claude"),
    },
  );
  if (!Array.isArray(result)) throw new Error("Claude Code returned no session list");
  const source = workspaceDir ? "Claude Code · workspace" : "Claude Code · personal";
  return {
    rows: rows(result).flatMap((session) => {
      const sessionId = str(session.sessionId ?? session.session_id ?? session.id);
      if (!sessionId) return [];
      return [
        {
          id: `claude:${workspaceDir ? "workspace" : "personal"}:${sessionId}`,
          provider: "claude",
          source,
          title: trim(session.title ?? session.name) || "Claude Code session",
          detail: trim(session.kind, 50),
          status: providerStatus(session.status ?? session.state),
          updatedAt: timestamp(session.updatedAt ?? session.lastActivityAt ?? session.startedAt),
          url: null,
        } satisfies MissionControlAgentRow,
      ];
    }),
    detail: result.length
      ? "Local running sessions and completed background sessions."
      : "Connected. The CLI returned no background or interactive sessions.",
  };
}

function cursorRead(key: string, path: string) {
  return new Promise<unknown>((resolve, reject) => {
    const request = NodeHttps.get(
      `https://api.cursor.com${path}`,
      {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(10_000),
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error("Cursor Cloud request failed"));
          return;
        }
        response.setEncoding("utf8");
        let body = "";
        response.on("data", (chunk: string) => {
          body += chunk;
          if (body.length > 2 * 1024 * 1024)
            request.destroy(new Error("Cursor response too large"));
        });
        response.on("error", reject);
        response.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on("error", reject);
  });
}

async function cursorCloud(key: string): Promise<Feed> {
  const data = obj(await cursorRead(key, "/v1/agents?limit=30&includeArchived=false"));
  if (!Array.isArray(data.items)) throw new Error("Cursor Cloud returned no agent list");
  const agents = rows(data.items).filter((agent) => /^[\w-]{1,160}$/.test(str(agent.id)));
  const active = agents.filter((agent) => agent.status === "ACTIVE");
  const runs = new Map<string, unknown>();
  await Promise.all(
    active.slice(0, 10).map(async (agent) => {
      if (!/^[\w-]{1,160}$/.test(str(agent.latestRunId))) return;
      const latest = await cursorRead(
        key,
        `/v1/agents/${str(agent.id)}/runs/${str(agent.latestRunId)}`,
      ).catch(() => null);
      if (latest) runs.set(str(agent.id), obj(latest).status);
    }),
  );
  return {
    rows: agents.map((agent): MissionControlAgentRow => {
      const runStatus = runs.get(str(agent.id));
      return {
        id: `cursor-cloud:${str(agent.id)}`,
        provider: "cursor",
        source: "Cursor Cloud",
        title: trim(agent.name) || "Cursor Cloud agent",
        detail:
          agent.status === "ACTIVE" && !runStatus
            ? "Active agent · run state unavailable"
            : "Cloud agent",
        status: providerStatus(runStatus),
        updatedAt: timestamp(agent.updatedAt ?? agent.createdAt),
        url: safeProviderUrl(agent.url, "cursor.com", true) ?? cursorUrl,
      };
    }),
    partial: Boolean(data.nextCursor) || runs.size < active.length,
    detail: "Latest cloud agents available to the configured Cursor account.",
  };
}

async function nebosRuns(home: string, config: Bindings, now: number): Promise<Feed> {
  const api = connector(home);
  const workstreams = (await api.action("CUSTOM_NEBOS_LIST_WORKSTREAMS", config.nebos)).result;
  if (!Array.isArray(workstreams)) throw new Error("NEBOS returned no workstream list");
  const work = rows(workstreams).filter((entry) => /^[0-9a-f-]{36}$/i.test(str(entry.id)));
  const runs: PromiseSettledResult<MissionControlAgentRow[]>[] = [];
  for (let start = 0; start < Math.min(30, work.length); start += 6) {
    runs.push(
      ...(await Promise.allSettled(
        work.slice(start, start + 6).map(async (stream) => {
          const entries = (
            await api.action("CUSTOM_NEBOS_LIST_WORKSTREAM_RUNS", config.nebos, {
              id: str(stream.id),
              limit: 6,
            })
          ).result;
          if (!Array.isArray(entries)) throw new Error("NEBOS returned no run list");
          return rows(entries).flatMap((run) => {
            if (!run.id || run.workstreamId !== stream.id) return [];
            const claim = str(run.claimedBy).toLowerCase();
            const provider = /^(?:grok|xai)(?:$|[:/])/.test(claim)
              ? "grok"
              : /^cursor(?:$|[:/])/.test(claim)
                ? "cursor"
                : "nebos";
            return [
              {
                id: `nebos:${str(run.id)}`,
                provider,
                source: "NEBOS workstreams",
                title: trim(stream.title ?? run.taskName) || "NEBOS workstream",
                detail: [trim(stream.agent, 70), trim(run.triggeredBy, 30)]
                  .filter(Boolean)
                  .join(" · "),
                status: workstreamStatus(run.status, run.claimedAt, now),
                updatedAt: timestamp(run.createdAt),
                url: config.nebosUrl ?? null,
              } satisfies MissionControlAgentRow,
            ];
          });
        }),
      )),
    );
  }
  if (runs.length && runs.every((outcome) => outcome.status === "rejected"))
    throw new Error("NEBOS runs unavailable");
  return {
    rows: runs.flatMap((outcome) => (outcome.status === "fulfilled" ? outcome.value : [])),
    partial: work.length > 30 || runs.some((outcome) => outcome.status === "rejected"),
    detail:
      "Recent NEBOS run records. Provider attribution is shown when NEBOS identifies the executor.",
  };
}

export async function loadAgentActivity(
  home: string,
  baseDir: string,
  now: number,
): Promise<MissionControlAgentActivity> {
  const config = await bindingsAt(baseDir);
  const operations: { source: Omit<Source, "coverage" | "detail">; read: Promise<Feed> }[] = [
    { source: { provider: "openai", label: "Codex Cloud", url: codexUrl }, read: codexCloud(home) },
    {
      source: { provider: "openai", label: "Codex on this Mac", url: null },
      read: Promise.resolve().then(() => codexHistory(home, now)),
    },
    {
      source: { provider: "cursor", label: "Cursor on this Mac", url: null },
      read: cursorHistory(home),
    },
    {
      source: { provider: "grok", label: "Grok Build on this Mac", url: null },
      read: Promise.resolve().then(() => grokHistory(home, now)),
    },
    {
      source: { provider: "claude", label: "Claude Code · personal", url: null },
      read: claudeLocal(home),
    },
  ];
  if (config?.claudeWorkspaceDir) {
    operations.push({
      source: { provider: "claude", label: "Claude Code · workspace", url: null },
      read: claudeLocal(home, config.claudeWorkspaceDir),
    });
  }
  if (config?.nebos) {
    operations.push({
      source: { provider: "nebos", label: "NEBOS workstreams", url: config.nebosUrl ?? null },
      read: nebosRuns(home, config, now),
    });
  }
  const dashboardSources: Source[] = [
    {
      provider: "claude",
      label: "Claude cloud sessions",
      coverage: "dashboard",
      detail: "Open the account’s hosted session list.",
      url: claudeUrl,
    },
    {
      provider: "grok",
      label: "Hosted Grok Bots",
      coverage: "dashboard",
      detail: "Direct hosted bot activity is available through the Grok account.",
      url: grokUrl,
    },
  ];
  const cursorKey = config?.cursorCloud ? process.env.CURSOR_API_KEY?.trim() : undefined;
  if (cursorKey) {
    operations.push({
      source: { provider: "cursor", label: "Cursor Cloud", url: cursorUrl },
      read: cursorCloud(cursorKey),
    });
  } else {
    dashboardSources.push({
      provider: "cursor",
      label: "Cursor Cloud",
      coverage: "dashboard",
      detail:
        "Open the account’s cloud agents. Enable Cursor Cloud and configure an API key for in-app coverage.",
      url: cursorUrl,
    });
  }
  const outcomes = await Promise.allSettled(operations.map(({ read }) => read));
  return {
    checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
    rows: outcomes.flatMap((outcome) => (outcome.status === "fulfilled" ? outcome.value.rows : [])),
    sources: [
      ...outcomes.map((outcome, index): Source =>
        outcome.status === "fulfilled"
          ? {
              ...operations[index]!.source,
              coverage: outcome.value.partial ? "partial" : "connected",
              detail: outcome.value.detail ?? "",
            }
          : {
              ...operations[index]!.source,
              coverage: "unavailable",
              detail: "The local or account feed could not be read.",
            },
      ),
      ...dashboardSources,
    ],
  };
}
