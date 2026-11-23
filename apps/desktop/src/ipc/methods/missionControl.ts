import * as Schema from "effect/Schema";
import {
  MissionControlRequestSchema,
  MissionControlHandoffBatchSchema,
  MissionControlHandoffSchema,
  MissionControlResponseSchema,
  MissionControlActionItemIdSchema,
  MissionControlActionRequestSchema,
  MissionControlActionResultSchema,
  MissionControlReplyPreviewSchema,
  missionControlPrioritySources,
  type MissionControlRequest,
  type MissionControlItem,
  type MissionControlResponse,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import {
  completeMissionControlIssue,
  MissionControlActionError,
  previewMissionControlReply,
  sendMissionControlReply,
} from "../../missionControl/actions.ts";
import {
  bindingsAt,
  connector,
  readLinear,
  readMail,
  readNebos,
  readNebosWorkstreams,
  readSlack,
  readTasks,
  sharedContext,
  sourceStatus,
} from "../../missionControl/sources.ts";
import { routeItems } from "../../missionControl/handoff.ts";
import { contextualizePriority, isRestrictedText } from "../../missionControl/context.ts";
import { scoreMissionControlPriorities } from "../../missionControl/priority.ts";
import { readSrcos } from "../../missionControl/srcos.ts";
import { prioritize } from "../../missionControl/triage.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

const empty: MissionControlResponse = {
  configured: false,
  fetchedAt: null,
  mailboxes: [],
  items: [],
  sources: [],
  context: null,
  nextCursor: null,
};

type SourceRead = {
  items: MissionControlItem[];
  partial?: boolean;
  note?: string;
  context?: string | null;
  lanes?: readonly string[];
  workstreams?: readonly string[];
  personalFocus?: readonly string[];
};
type Source = MissionControlItem["source"];
type CachedRead = { time: number; pending: boolean; result: Promise<SourceRead> };

let sourceCache: { key: string; reads: Map<string, CachedRead> } | undefined;
const prioritySourceKey = (source: Source, account: string) => JSON.stringify([source, account]);

function readPrioritySource(
  reads: Map<string, CachedRead>,
  key: string,
  read: () => Promise<SourceRead>,
  now: number,
  refresh: boolean,
) {
  const existing = reads.get(key);
  if (existing && (existing.pending || now - existing.time < (refresh ? 15_000 : 120_000))) {
    return existing;
  }
  const entry = {
    time: now,
    pending: true,
    result: Promise.resolve()
      .then(read)
      .finally(() => {
        entry.pending = false;
      }),
  };
  reads.set(key, entry);
  return entry;
}

async function readPriorities(
  home: string,
  baseDir: string,
  request: Extract<MissionControlRequest, { view: "priorities" }>,
  now: number,
): Promise<MissionControlResponse> {
  const bindings = await bindingsAt(baseDir);
  if (!bindings) return empty;
  const cacheKey = JSON.stringify([home, baseDir, bindings]);
  if (sourceCache?.key !== cacheKey) sourceCache = { key: cacheKey, reads: new Map() };
  const { reads } = sourceCache;
  const api = connector(home);
  const today = DateTime.formatIsoDate(
    DateTime.setZone(DateTime.makeUnsafe(now), DateTime.zoneMakeLocal()),
  );
  const readContext = async (file: string) => {
    const lanes = await sharedContext(file);
    return {
      items: [],
      note: lanes.length ? "Shared lane order loaded." : "No explicit lane priority was found.",
      lanes,
      context: lanes.length ? `Workspace lane order · ${lanes.join(" → ")}` : null,
    };
  };
  const getSource = (source: Source, account: string, read: () => Promise<SourceRead>) =>
    readPrioritySource(reads, prioritySourceKey(source, account), read, now, request.refresh);
  const operations: {
    source: Source;
    account: string;
    enabled: boolean;
    read: () => Promise<SourceRead>;
  }[] = [
    ...bindings.mail.map((account) => ({
      source: "email" as const,
      account: account.label,
      enabled: true,
      read: () => readMail(api, account, null, "recent-replies"),
    })),
    {
      source: "slack" as const,
      account: "Slack",
      enabled: Boolean(bindings.slack),
      read: () => readSlack(api, bindings.slack, today),
    },
    {
      source: "linear" as const,
      account: "Linear",
      enabled: Boolean(bindings.linear),
      read: () => readLinear(api, bindings),
    },
    {
      source: "nebos",
      account: "NEBOS",
      enabled: Boolean(bindings.nebos),
      read: () => readNebos(api, bindings),
    },
    {
      source: "srcos",
      account: "Personal",
      enabled: Boolean(bindings.srcosTenant && bindings.srcosCredentialFile),
      read: () => readSrcos(bindings.srcosCredentialFile!, bindings.srcosTenant),
    },
    {
      source: "tasks",
      account: "Personal",
      enabled: Boolean(bindings.tasks),
      read: () => readTasks(api, bindings.tasks),
    },
    {
      source: "context" as const,
      account: "Workspace",
      enabled: Boolean(bindings.contextFile),
      read: () => readContext(bindings.contextFile!),
    },
    {
      source: "context",
      account: "NEBOS workstreams",
      enabled: Boolean(bindings.nebos),
      read: async () => ({
        items: [],
        note: "Enabled NEBOS workstreams checked.",
        workstreams: await readNebosWorkstreams(api, bindings.nebos),
      }),
    },
  ];
  if (!operations.some(({ enabled }) => enabled)) return empty;
  const scope = missionControlPrioritySources[request.filter ?? "all"];
  const selected = operations.filter(({ source, enabled }) => enabled && scope.includes(source));
  const entries = selected.map(({ source, account, read }) => getSource(source, account, read));
  const outcomes = await Promise.allSettled(entries.map(({ result }) => result));
  const all = outcomes.flatMap((outcome) =>
    outcome.status === "fulfilled" ? outcome.value.items : [],
  );
  const resultFor = (source: Source, account: string) => {
    const outcome =
      outcomes[
        selected.findIndex(
          (operation) => operation.source === source && operation.account === account,
        )
      ];
    return outcome?.status === "fulfilled" ? outcome.value : undefined;
  };
  const shared = resultFor("context", "Workspace");
  const personal = resultFor("srcos", "Personal");
  const team = {
    lanes: shared?.lanes ?? [],
    workstreams: resultFor("context", "NEBOS workstreams")?.workstreams ?? [],
  };
  const items = prioritize(
    [...new Map(all.map((item) => [item.id, item])).values()].map((item) => {
      if (isRestrictedText(item.title, bindings.restrictedTerms)) {
        return { ...item, taskContext: { ...item.taskContext, restricted: true } };
      }
      const contextualized = contextualizePriority(item, team, personal?.personalFocus ?? []);
      const product = contextualized.taskContext?.product;
      const repository = product && bindings.projectRepositories?.[product];
      return repository && !contextualized.taskContext?.restricted
        ? { ...contextualized, taskContext: { ...contextualized.taskContext, repository } }
        : contextualized;
    }),
    today,
    team.lanes,
  );
  const scores = await scoreMissionControlPriorities(home, items, today, now, bindings.jevCommand);
  return {
    configured: true,
    fetchedAt: DateTime.formatIso(
      DateTime.makeUnsafe(Math.min(now, ...entries.map(({ time }) => time))),
    ),
    mailboxes: bindings.mail.map(({ label }) => label),
    items: scores.size ? prioritize(items, today, team.lanes, scores) : items,
    priorityScoredCount: scores.size,
    sources: outcomes.map((outcome, i) =>
      sourceStatus(selected[i]!.source, selected[i]!.account, outcome),
    ),
    context: shared?.context ?? null,
    srcosContext: personal?.context ?? null,
    nextCursor: null,
  };
}

export async function readMissionControl(
  home: string,
  baseDir: string,
  request: MissionControlRequest,
  now: number,
) {
  if (request.view === "priorities") {
    return readPriorities(home, baseDir, request, now);
  }

  const bindings = await bindingsAt(baseDir);
  if (!bindings) return empty;
  const account = bindings.mail.find((entry) => entry.label === request.account);
  if (!account) return empty;
  const [outcome] = await Promise.allSettled([
    readMail(connector(home), account, request.cursor, request.replies ? "inbox-replies" : "all"),
  ]);
  return {
    ...empty,
    configured: true,
    fetchedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
    items: outcome.status === "fulfilled" ? outcome.value.items : [],
    nextCursor: outcome.status === "fulfilled" ? outcome.value.nextCursor : null,
    sources: [sourceStatus("email", account.label, outcome)],
  };
}

export const getMissionControl = makeIpcMethod({
  channel: IpcChannels.GET_MISSION_CONTROL_CHANNEL,
  payload: MissionControlRequestSchema,
  result: MissionControlResponseSchema,
  handler: Effect.fn("desktop.ipc.missionControl.read")(function* (request) {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    // The trusted main-frame guard also applies. Personal data is never available to remote clients.
    if (!environment.isPackaged || environment.platform !== "darwin") return empty;
    const now = yield* Clock.currentTimeMillis;
    return yield* Effect.promise(() =>
      readMissionControl(environment.homeDirectory, environment.baseDir, request, now),
    );
  }),
});

const actionsUnavailable = {
  ok: false as const,
  error: "This action is unavailable in this Screddy window.",
};
const isMissionControlActionError = Schema.is(MissionControlActionError);

export const getMissionControlReply = makeIpcMethod({
  channel: IpcChannels.GET_MISSION_CONTROL_REPLY_CHANNEL,
  payload: MissionControlActionItemIdSchema,
  result: MissionControlReplyPreviewSchema,
  handler: Effect.fn("desktop.ipc.missionControl.previewReply")(function* (itemId) {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    if (!environment.isPackaged || environment.platform !== "darwin") return actionsUnavailable;
    return yield* Effect.promise(async () => {
      const bindings = await bindingsAt(environment.baseDir);
      if (!bindings) return actionsUnavailable;
      try {
        return await previewMissionControlReply(
          connector(environment.homeDirectory),
          bindings,
          itemId,
        );
      } catch (error) {
        return {
          ok: false as const,
          error: isMissionControlActionError(error)
            ? error.message
            : "Gmail couldn't verify this message or mailbox.",
        };
      }
    });
  }),
});

export const runMissionControlAction = makeIpcMethod({
  channel: IpcChannels.RUN_MISSION_CONTROL_ACTION_CHANNEL,
  payload: MissionControlActionRequestSchema,
  result: MissionControlActionResultSchema,
  handler: Effect.fn("desktop.ipc.missionControl.action")(function* (request) {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    if (!environment.isPackaged || environment.platform !== "darwin") return actionsUnavailable;
    return yield* Effect.promise(async () => {
      const bindings = await bindingsAt(environment.baseDir);
      if (!bindings) return actionsUnavailable;
      const api = connector(environment.homeDirectory);
      try {
        const outcome =
          request.kind === "reply"
            ? await sendMissionControlReply(api, bindings, environment.baseDir, request)
            : await completeMissionControlIssue(api, bindings, request.itemId);
        const source =
          request.kind === "reply"
            ? prioritySourceKey("email", request.itemId.split(":")[1]!)
            : prioritySourceKey("linear", "Linear");
        sourceCache?.reads.delete(source);
        return outcome;
      } catch (error) {
        return {
          ok: false as const,
          error: isMissionControlActionError(error)
            ? error.message
            : "The connected account could not perform this action.",
        };
      }
    });
  }),
});

export const routeMissionControlItems = makeIpcMethod({
  channel: IpcChannels.ROUTE_MISSION_CONTROL_ITEMS_CHANNEL,
  payload: MissionControlHandoffBatchSchema,
  result: Schema.Array(MissionControlHandoffSchema),
  handler: Effect.fn("desktop.ipc.missionControl.route")(function* (requests) {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    if (!environment.isPackaged || environment.platform !== "darwin") {
      return requests.map(() => ({ kind: "unavailable" as const }));
    }
    return yield* Effect.promise(() =>
      routeItems(environment.homeDirectory, environment.baseDir, requests),
    );
  }),
});
