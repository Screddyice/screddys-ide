// @effect-diagnostics nodeBuiltinImport:off -- Reads the existing owner-only SRCOS credential for the desktop feed.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttps from "node:https";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import type { MissionControlItem } from "@t3tools/contracts";
import { obj, str } from "./sources.ts";
import { personalFocusTerms } from "./context.ts";

const origin = "https://os.shawn-reddy.com";
const tokenKey = "NEBOS_OS_BEARER_TOKEN";
const taskLimit = 200;
const openStatuses = ["todo", "in_progress", "review", "blocked"] as const;

function plain(value: unknown, limit: number) {
  return str(value).replace(/\s+/g, " ").trim().slice(0, limit);
}

async function srcosToken(home: string): Promise<string> {
  // This is the same private credential file used by the installed SRCOS gateway adapter.
  const file = NodePath.join(home, "projects", ".env");
  const info = await NodeFSP.lstat(file);
  if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) {
    throw new Error("SRCOS credential file unavailable");
  }
  const entry = (await NodeFSP.readFile(file, "utf8"))
    .split(/\r?\n/)
    .filter((line) => /^\s*(?:export\s+)?NEBOS_OS_BEARER_TOKEN\s*=/.test(line));
  const token = entry.length === 1 ? NodeUtil.parseEnv(entry[0]!)[tokenKey] : undefined;
  if (!token || token.startsWith("${") || /\s/.test(token))
    throw new Error("SRCOS credential missing");
  return token;
}

async function readTool(
  token: string,
  name: "task_list" | "knowledge_search",
  args: { status: (typeof openStatuses)[number]; limit: number } | { query: "Mission Control" },
): Promise<unknown> {
  const payload = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const { body, contentType } = await new Promise<{ body: string; contentType: string }>(
    (resolve, reject) => {
      const request = NodeHttps.request(
        origin + "/api/mcp",
        {
          method: "POST",
          signal: AbortSignal.timeout(12_000),
          headers: {
            Authorization: "Bearer " + token,
            Accept: "application/json, text/event-stream",
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
          },
        },
        (response) => {
          if (response.statusCode !== 200) {
            response.resume();
            reject(new Error("SRCOS request failed"));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("error", reject);
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 4 * 1024 * 1024) {
              response.destroy(new Error("SRCOS response exceeded the limit"));
              return;
            }
            chunks.push(chunk);
          });
          response.once("end", () =>
            resolve({
              body: Buffer.concat(chunks).toString("utf8"),
              contentType: response.headers["content-type"] ?? "",
            }),
          );
        },
      );
      request.on("error", reject);
      request.end(payload);
    },
  );
  const envelope = obj(
    contentType.includes("text/event-stream")
      ? body
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => obj(JSON.parse(line.slice(5))))
          .find(({ id }) => id === 1)
      : JSON.parse(body),
  );
  const result = obj(envelope.result);
  if (envelope.error || result.isError || !Array.isArray(result.content)) {
    throw new Error("SRCOS returned an invalid response");
  }
  const inner = obj(JSON.parse(str(obj(result.content[0]).text)));
  if (inner.status !== "ok") throw new Error("SRCOS read unavailable");
  return inner.result;
}

export function srcosItems(rows: unknown[], tenantId: string): MissionControlItem[] {
  if (rows.some((row) => obj(row).tenantId !== tenantId)) {
    throw new Error("SRCOS tenant does not match the local binding");
  }
  return rows.flatMap((value) => {
    const task = obj(value);
    const status = openStatuses.find((candidate) => candidate === task.status);
    const id = str(task.id);
    const title = plain(task.title, 220);
    if (!status || !id || !title || task.clientId || task.clientVisible !== false) return [];
    const due = str(task.dueDate).slice(0, 10);
    const priority = str(task.priority).toLowerCase();
    return [
      {
        id: `srcos:${id}`,
        source: "srcos",
        account: "Personal",
        title,
        detail: status.replaceAll("_", " "),
        url: origin + "/tasks",
        activity: str(task.updatedAt) || str(task.createdAt),
        due: /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : null,
        urgency:
          priority === "urgent" || priority === "critical"
            ? "urgent"
            : priority === "high" || status === "blocked"
              ? "high"
              : "normal",
      },
    ];
  });
}

export async function readSrcos(home: string, tenantId: string) {
  if (!tenantId) throw new Error("SRCOS tenant is not configured");
  const token = await srcosToken(home);
  const [taskReads, documents] = await Promise.all([
    Promise.allSettled(
      openStatuses.map(async (status) => {
        const rows = obj(await readTool(token, "task_list", { status, limit: taskLimit })).tasks;
        if (!Array.isArray(rows)) throw new Error("SRCOS returned no task list");
        return rows as unknown[];
      }),
    ),
    readTool(token, "knowledge_search", { query: "Mission Control" }).then(
      (value) => (Array.isArray(value) ? value.map(obj) : null),
      () => null,
    ),
  ]);
  const records = taskReads.flatMap((read) => (read.status === "fulfilled" ? read.value : []));
  const taskAvailable = taskReads.some((read) => read.status === "fulfilled");
  if (!taskAvailable) throw new Error("SRCOS tasks unavailable");
  const items = srcosItems(records, tenantId);
  const doc = documents?.find(({ title }) =>
    ["srcos mission control", "mission control"].includes(str(title).trim().toLowerCase()),
  );
  const context = plain(doc?.content, 500) || null;
  const personalFocus = personalFocusTerms(str(doc?.content).slice(0, 8192));
  const partial =
    !documents ||
    taskReads.some((read) => read.status === "rejected" || read.value.length >= taskLimit);
  const taskNote = items.length
    ? "Open personal SRCOS work."
    : "No open personal SRCOS work found.";
  return {
    items,
    context,
    personalFocus,
    partial,
    note: [
      taskNote,
      ...(taskReads.some((read) => read.status === "fulfilled" && read.value.length >= taskLimit)
        ? [`At least one status reached the SRCOS API limit of ${taskLimit} tasks.`]
        : []),
      documents
        ? context
          ? "Knowledge note loaded."
          : "No Mission Control knowledge note found."
        : "Knowledge unavailable.",
    ].join(" "),
  };
}
