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

function codexHistory(home: string): Feed {
  const db = new NodeSqlite.DatabaseSync(NodePath.join(home, ".codex", "state_5.sqlite"), {
    readOnly: true,
  });
  try {
    const records = db
      .prepare(
        "SELECT id, title, updated_at FROM threads WHERE archived = 0 ORDER BY updated_at DESC LIMIT 20",
      )
      .all();
    return {
      rows: records.flatMap((r) => {
        const title = trim(r.title);
        if (!title || !r.id) return [];
        return [
          {
            id: `codex-local:${str(r.id)}`,
            provider: "openai",
            source: "Codex on this Mac",
            title,
            detail: "Session history",
            status: "recent",
            updatedAt: timestamp(r.updated_at),
            url: null,
          } satisfies MissionControlAgentRow,
        ];
      }),
      detail: "Recent local sessions. An update timestamp alone does not indicate a running task.",
    };
  } finally {
    db.close();
  }
}

function grokHistory(home: string): Feed {
  const db = new NodeSqlite.DatabaseSync(
    NodePath.join(home, ".grok", "sessions", "session_search.sqlite"),
    { readOnly: true },
  );
  try {
    const records = db
      .prepare(
        "SELECT session_id, title, updated_at FROM session_docs ORDER BY updated_at DESC LIMIT 20",
      )
      .all();
    return {
      rows: records.flatMap((entry) => {
        const title = trim(entry.title);
        if (!entry.session_id || !title) return [];
        return [
          {
            id: `grok-local:${str(entry.session_id)}`,
            provider: "grok",
            source: "Grok Build on this Mac",
            title,
            detail: "Session history",
            status: "recent",
            updatedAt: timestamp(entry.updated_at),
            url: null,
          } satisfies MissionControlAgentRow,
        ];
      }),
      detail: "Recent local Grok Build sessions from its search index.",
    };
  } finally {
    db.close();
  }
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
  return {
    rows: entries,
    partial,
    detail: "Recent local Cursor sessions. Their live state is available when run through Screddy.",
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
      read: Promise.resolve().then(() => codexHistory(home)),
    },
    {
      source: { provider: "cursor", label: "Cursor on this Mac", url: null },
      read: cursorHistory(home),
    },
    {
      source: { provider: "grok", label: "Grok Build on this Mac", url: null },
      read: Promise.resolve().then(() => grokHistory(home)),
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
  const cursorKey = process.env.CURSOR_API_KEY?.trim();
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
      detail: "Open the account’s cloud agents. An API key is needed for in-app coverage.",
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
