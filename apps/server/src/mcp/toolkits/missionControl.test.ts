// @effect-diagnostics nodeBuiltinImport:off -- A fake desktop app answers on a real Unix socket.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  missionControlSocketPath,
  type AuthMcpClientAccess,
  type MissionControlItem,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";

import { ServerConfig } from "../../config.ts";
import { layerInProcessMcpServer, toolkitRegistration } from "../McpHttpServer.ts";
import * as McpInvocationContext from "../McpInvocationContext.ts";
import * as McpToolAccess from "../McpToolAccess.ts";
import { liveThreadsLayer } from "../McpToolAccess.testkit.ts";
import * as MissionControl from "./missionControl.ts";

const environmentId = EnvironmentId.make("environment:mission-control");

const item = (id: string, title: string, restricted = false): MissionControlItem => ({
  id,
  source: "tasks",
  account: "Personal",
  title,
  detail: "My Tasks",
  url: null,
  activity: "2026-11-26T00:00:00Z",
  due: null,
  urgency: "normal",
  ...(restricted && { taskContext: { restricted: true } }),
});

/** Starts a fake desktop app on the socket path under a fresh base directory. */
const fakeDesktop = (answer: (request: { op: string; payload: unknown }) => unknown) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      // Short paths: macOS caps a Unix socket path at 104 bytes.
      const baseDir = await NodeFSP.mkdtemp(NodePath.join("/tmp", "mct-"));
      const path = missionControlSocketPath(baseDir);
      await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
      const requests: Array<{ op: string; payload: unknown }> = [];
      const server = NodeNet.createServer({ allowHalfOpen: true }, (socket) => {
        let raw = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => (raw += chunk));
        socket.on("end", () => {
          const request = JSON.parse(raw);
          requests.push(request);
          socket.end(JSON.stringify(answer(request)));
        });
      });
      await new Promise<void>((resolve) => server.listen(path, resolve));
      return { baseDir, requests, server };
    }),
    ({ baseDir, server }) =>
      Effect.promise(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await NodeFSP.rm(baseDir, { recursive: true, force: true });
      }),
  );

const appClient = (access: AuthMcpClientAccess = "full-access", linked = false) => ({
  environmentId,
  requestNamespace: "client:dot",
  thread: undefined,
  client: { sessionId: "session:dot", label: "Dot", access, ...(linked && { linked }) },
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
});

const agentThread = {
  ...appClient(),
  client: undefined,
  thread: {
    threadId: ThreadId.make("thread:agent"),
    providerSessionId: "provider:agent",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
};

const call = (
  baseDir: string,
  scope: McpInvocationContext.McpInvocationScope,
  name: keyof typeof MissionControl.toolkit.tools,
  params: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const toolkit = yield* MissionControl.toolkit;
    const results = yield* toolkit
      .handle(name, params as never)
      .pipe(Stream.unwrap, Stream.runCollect);
    return results.at(-1)?.result as Record<string, unknown>;
  }).pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(MissionControl.layer).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
            ServerConfig.layerTest(process.cwd(), baseDir),
            liveThreadsLayer,
          ),
        ),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "mission-control-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    clientInfo: { name: "mission-control-test", version: "1.0.0" },
    capabilities: {},
  },
  getClient: Effect.die("not used"),
});

it("shows Mission Control only to apps connected through Use in another app", () => {
  expect(McpInvocationContext.isAppClient(appClient())).toBe(true);
  expect(McpInvocationContext.isAppClient(appClient("read-only"))).toBe(true);
  expect(McpInvocationContext.isAppClient(agentThread)).toBe(false);
  expect(McpInvocationContext.isAppClient(appClient("full-access", true))).toBe(false);
  expect(McpInvocationContext.isAppClient(undefined)).toBe(false);
});

it.effect("reads priorities, withholding restricted items and capping the count", () =>
  Effect.gen(function* () {
    const desktop = yield* fakeDesktop(() => ({
      ok: true,
      result: {
        configured: true,
        fetchedAt: "2026-11-26T18:00:00.000Z",
        mailboxes: [],
        items: [
          item("tasks:l:1", "Renew passport"),
          item("tasks:l:2", "Confidential board memo", true),
          item("tasks:l:3", "Book flights"),
        ],
        sources: [
          { source: "slack", account: "Team", state: "unavailable", detail: "Slack timed out" },
          { source: "tasks", account: "Personal", state: "ready", detail: "" },
        ],
        context: null,
        nextCursor: null,
      },
    }));
    const result = yield* call(
      desktop.baseDir,
      appClient("read-only"),
      "mission_control_priorities",
      {
        filter: "tasks",
        limit: 1,
      },
    );
    expect(desktop.requests).toEqual([
      { op: "priorities", payload: { view: "priorities", refresh: false, filter: "tasks" } },
    ]);
    expect(result).toMatchObject({
      fetchedAt: "2026-11-26T18:00:00.000Z",
      withheld: 1,
      unavailableSources: [{ source: "slack", account: "Team", detail: "Slack timed out" }],
    });
    expect((result.items as MissionControlItem[]).map(({ title }) => title)).toEqual([
      "Renew passport",
    ]);
  }).pipe(Effect.scoped),
);

it.effect("refuses agent threads and linked environments before reaching the desktop app", () =>
  Effect.gen(function* () {
    const desktop = yield* fakeDesktop(() => ({ ok: true, result: {} }));
    for (const scope of [agentThread, appClient("full-access", true)]) {
      const result = yield* call(desktop.baseDir, scope, "mission_control_priorities", {});
      expect(result).toMatchObject({ code: "capability_denied" });
    }
    expect(desktop.requests).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect("sends a checked action and refuses mismatched fields and read-only apps", () =>
  Effect.gen(function* () {
    const desktop = yield* fakeDesktop(({ payload }) =>
      (payload as { kind: string }).kind === "complete-task"
        ? { ok: true, result: { ok: false, error: "This task is no longer in Google Tasks." } }
        : {
            ok: true,
            result: { ok: true, message: "Added to Google Tasks.", itemId: "tasks:l:9" },
          },
    );
    const added = yield* call(desktop.baseDir, appClient(), "mission_control_act", {
      kind: "create-task",
      title: "Book flights",
      due: "2026-12-05",
    });
    expect(added).toEqual({ message: "Added to Google Tasks.", itemId: "tasks:l:9" });
    expect(desktop.requests.at(-1)).toEqual({
      op: "action",
      payload: { kind: "create-task", title: "Book flights", due: "2026-12-05" },
    });

    const failed = yield* call(desktop.baseDir, appClient(), "mission_control_act", {
      kind: "complete-task",
      itemId: "tasks:l:1",
    });
    expect(failed).toMatchObject({
      code: "orchestration_error",
      message: "This task is no longer in Google Tasks.",
    });

    const mismatched = yield* call(desktop.baseDir, appClient(), "mission_control_act", {
      kind: "reply",
      itemId: "gmail:Personal:12345678",
    });
    expect(mismatched).toMatchObject({ code: "invalid_request" });
    const readOnly = yield* call(desktop.baseDir, appClient("read-only"), "mission_control_act", {
      kind: "create-task",
      title: "Book flights",
    });
    expect(readOnly).toMatchObject({ code: "capability_denied" });
    expect(desktop.requests).toHaveLength(2);
  }).pipe(Effect.scoped),
);

it.effect("says to open Screddy when the desktop app is not serving Mission Control", () =>
  Effect.gen(function* () {
    const baseDir = yield* Effect.promise(() => NodeFSP.mkdtemp(NodePath.join("/tmp", "mct-")));
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => NodeFSP.rm(baseDir, { recursive: true, force: true })),
    );
    const result = yield* call(baseDir, appClient(), "mission_control_reply_preview", {
      itemId: "gmail:Personal:12345678",
    });
    expect(result).toMatchObject({ code: "provider_unavailable" });
    expect(String(result.message)).toContain("open Screddy");
  }).pipe(Effect.scoped),
);

it.effect("the registered tools answer an app but not an agent thread", () =>
  Effect.gen(function* () {
    const desktop = yield* fakeDesktop(() => ({
      ok: true,
      result: {
        configured: true,
        fetchedAt: null,
        mailboxes: [],
        items: [],
        sources: [],
        context: null,
        nextCursor: null,
      },
    }));
    yield* Effect.gen(function* () {
      const mcp = yield* McpServer.McpServer;
      const call = (scope: McpInvocationContext.McpInvocationScope) =>
        mcp
          .callTool({ name: "mission_control_priorities", arguments: {} })
          .pipe(
            Effect.provideService(McpSchema.McpServerClient, client),
            Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
            Effect.exit,
          );
      const app = yield* call(appClient());
      expect(app._tag === "Success" && app.value.isError).toBe(false);
      const agent = yield* call(agentThread);
      expect(agent._tag === "Failure" || agent.value.isError === true).toBe(true);
      expect(desktop.requests).toHaveLength(1);
    }).pipe(
      Effect.provide(
        toolkitRegistration(MissionControl.toolkit, MissionControl.layer).pipe(
          Layer.provideMerge(layerInProcessMcpServer),
          Layer.provide(
            Layer.mergeAll(
              ServerConfig.layerTest(process.cwd(), desktop.baseDir),
              liveThreadsLayer,
            ),
          ),
          Layer.provide(NodeServices.layer),
        ),
      ),
    );
  }).pipe(Effect.scoped),
);
