// @effect-diagnostics nodeBuiltinImport:off -- Calls the desktop app's Mission Control Unix socket.
import * as NodeNet from "node:net";
import {
  MissionControlActionItemIdSchema,
  MissionControlActionRequestSchema,
  MissionControlActionResultSchema,
  MissionControlItemSchema,
  MissionControlPriorityFilterSchema,
  MissionControlReplyPreviewSchema,
  MissionControlResponseSchema,
  missionControlSocketPath,
  OrchestratorMcpFailure,
  type MissionControlSocketOperation,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import { ServerConfig } from "../../config.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../McpInvocationContext.ts";
import * as McpToolAccess from "../McpToolAccess.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ServerConfig,
    ThreadManagement.ThreadManagementService,
  ],
};

const MissionControlPriorities = Tool.make("mission_control_priorities", {
  ...shared,
  description:
    "Read the user's Mission Control: ranked email replies, Slack replies, Linear and NEBOS work, SRCOS items and Google Tasks. Restricted items are withheld. Act on an item with mission_control_act.",
  parameters: Schema.Struct({
    filter: Schema.optional(MissionControlPriorityFilterSchema),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
  }),
  success: Schema.Struct({
    fetchedAt: Schema.NullOr(Schema.String),
    items: Schema.Array(MissionControlItemSchema),
    withheld: Schema.Int,
    unavailableSources: Schema.Array(
      Schema.Struct({ source: Schema.String, account: Schema.String, detail: Schema.String }),
    ),
  }),
})
  .annotate(Tool.Title, "Read Mission Control")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.appClientsOnly);

const MissionControlReplyPreview = Tool.make("mission_control_reply_preview", {
  ...shared,
  description:
    "Check an email or Slack item (canReply true) before replying. Returns who the reply comes from, where it goes (the email recipient, or the Slack channel or DM), the subject or first message of the thread, the latest message waiting on the user, and the revision mission_control_act needs to send it.",
  parameters: Schema.Struct({ itemId: MissionControlActionItemIdSchema }),
  success: Schema.Struct({
    from: Schema.String,
    to: Schema.String,
    subject: Schema.String,
    snippet: Schema.String,
    revision: Schema.String,
  }),
})
  .annotate(Tool.Title, "Preview a reply")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.appClientsOnly);

const MissionControlAct = Tool.make("mission_control_act", {
  ...shared,
  description:
    "Act on an item from mission_control_priorities (or a task you just added). kind: reply (itemId, revision from mission_control_reply_preview, body; sends the email, or posts in the item's Slack thread as the user), complete-linear or complete-task (itemId), create-task (title, optional notes and due YYYY-MM-DD), update-task (itemId plus only the fields to change; due null clears it). Confirm a reply with the user before sending.",
  parameters: Schema.Struct({
    kind: Schema.Literals([
      "reply",
      "complete-linear",
      "complete-task",
      "create-task",
      "update-task",
    ]),
    itemId: Schema.optional(Schema.String),
    revision: Schema.optional(Schema.String),
    body: Schema.optional(Schema.String),
    title: Schema.optional(Schema.String),
    notes: Schema.optional(Schema.String),
    due: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  success: Schema.Struct({ message: Schema.String, itemId: Schema.optional(Schema.String) }),
})
  .annotate(Tool.Title, "Act on Mission Control")
  .annotate(Tool.Destructive, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.appClientsOnly);

export const toolkit = Toolkit.make(
  MissionControlPriorities,
  MissionControlReplyPreview,
  MissionControlAct,
);

/** Generous for a full refresh with JEV ranking; an action's own provider checks finish sooner. */
const TIMEOUT_MS: Record<MissionControlSocketOperation, number> = {
  priorities: 150_000,
  "reply-preview": 60_000,
  action: 120_000,
};
const MAX_REPLY_BYTES = 8 * 1024 * 1024;

type SocketFailure = "closed" | "timeout" | "malformed";

/** Sends one request to the desktop app's socket and reads its single JSON reply. */
function requestMissionControlSocket(
  path: string,
  op: MissionControlSocketOperation,
  payload: unknown,
  timeoutMs = TIMEOUT_MS[op],
) {
  return new Promise<unknown>((resolve, reject: (reason: SocketFailure) => void) => {
    const socket = NodeNet.connect(path);
    let raw = "";
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject("timeout");
    });
    socket.on("connect", () => socket.end(JSON.stringify({ op, payload }) + "\n"));
    socket.on("data", (chunk: string) => {
      raw += chunk;
      if (raw.length > MAX_REPLY_BYTES) {
        socket.destroy();
        reject("malformed");
      }
    });
    socket.on("end", () => {
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject("malformed");
      }
    });
    socket.on("error", () => reject("closed"));
  });
}

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

const socketMessages: Record<SocketFailure, string> = {
  closed: "Mission Control runs in the Screddy app on the user's Mac. Ask them to open Screddy.",
  timeout:
    "Mission Control did not answer in time. For an action, read Mission Control again before retrying.",
  malformed: "Mission Control sent a reply this server could not read.",
};

const appClientOnly = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (!McpInvocationContext.isAppClient(scope)) {
    return yield* failure(
      "capability_denied",
      "Mission Control is only for apps connected through Use in another app.",
    );
  }
});

const SocketReply = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), result: Schema.Unknown }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
]);
const decodeSocketReply = Schema.decodeUnknownEffect(SocketReply);
const decodeResponse = Schema.decodeUnknownEffect(MissionControlResponseSchema);
const decodePreview = Schema.decodeUnknownEffect(MissionControlReplyPreviewSchema);
const decodeOutcome = Schema.decodeUnknownEffect(MissionControlActionResultSchema);
const decodeActionRequest = Schema.decodeUnknownEffect(MissionControlActionRequestSchema);

/** Asks the desktop app, then decodes its answer with the same schema the window uses. */
const callDesktop = Effect.fn("missionControl.callDesktop")(function* <A, E>(
  op: MissionControlSocketOperation,
  payload: unknown,
  decode: (input: unknown) => Effect.Effect<A, E>,
) {
  yield* appClientOnly;
  const config = yield* ServerConfig;
  const raw = yield* Effect.tryPromise({
    try: () => requestMissionControlSocket(missionControlSocketPath(config.baseDir), op, payload),
    catch: (reason) =>
      failure(
        "provider_unavailable",
        socketMessages[reason as SocketFailure] ?? socketMessages.closed,
      ),
  });
  const reply = yield* decodeSocketReply(raw).pipe(
    Effect.mapError(() => failure("orchestration_error", socketMessages.malformed)),
  );
  if (!reply.ok) return yield* failure("orchestration_error", reply.error);
  return yield* decode(reply.result).pipe(
    Effect.mapError(() => failure("orchestration_error", socketMessages.malformed)),
  );
});

export const layer = McpToolAccess.toLayer(toolkit, {
  mission_control_priorities: McpToolAccess.reads(({ filter, limit }) =>
    Effect.gen(function* () {
      const response = yield* callDesktop(
        "priorities",
        { view: "priorities", refresh: false, ...(filter && { filter }) },
        decodeResponse,
      );
      if (!response.configured) {
        return yield* failure("provider_unavailable", "Mission Control is not set up in Screddy.");
      }
      // Restricted items (confidential, regulated or configured terms) never leave the Mac.
      const open = response.items.filter((item) => item.taskContext?.restricted !== true);
      return {
        fetchedAt: response.fetchedAt,
        items: open.slice(0, limit ?? 20),
        withheld: response.items.length - open.length,
        unavailableSources: response.sources
          .filter((source) => source.state === "unavailable")
          .map(({ source, account, detail }) => ({ source, account, detail })),
      };
    }),
  ),
  mission_control_reply_preview: McpToolAccess.reads(({ itemId }) =>
    Effect.gen(function* () {
      const preview = yield* callDesktop("reply-preview", itemId, decodePreview);
      if (!preview.ok) return yield* failure("orchestration_error", preview.error);
      const { ok: _ok, ...fields } = preview;
      return fields;
    }),
  ),
  mission_control_act: McpToolAccess.writes((params) =>
    Effect.gen(function* () {
      const request = yield* decodeActionRequest(
        Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined)),
      ).pipe(
        Effect.mapError(() =>
          failure("invalid_request", "These fields do not match the chosen kind of action."),
        ),
      );
      const outcome = yield* callDesktop("action", request, decodeOutcome);
      if (!outcome.ok) return yield* failure("orchestration_error", outcome.error);
      return {
        message: outcome.message,
        ...(outcome.itemId !== undefined && { itemId: outcome.itemId }),
      };
    }),
  ),
});
