import {
  MissionControlAgentActivitySchema,
  type MissionControlAgentActivity,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import { loadAgentActivity } from "../../missionControl/agentActivity.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

let cache: { at: number; activity: MissionControlAgentActivity } | undefined;
let pending: Promise<MissionControlAgentActivity> | undefined;

export const getMissionControlAgentActivity = makeIpcMethod({
  channel: IpcChannels.GET_MISSION_CONTROL_AGENT_ACTIVITY_CHANNEL,
  payload: Schema.Boolean,
  result: MissionControlAgentActivitySchema,
  handler: Effect.fn("desktop.ipc.missionControlAgentActivity.read")(function* (force) {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    if (!environment.isPackaged || environment.platform !== "darwin") {
      return { checkedAt: null, rows: [], sources: [] };
    }
    const now = yield* Clock.currentTimeMillis;
    if (cache && now - cache.at < (force ? 10_000 : 60_000)) return cache.activity;
    return yield* Effect.promise(() => {
      pending ??= loadAgentActivity(environment.homeDirectory, environment.baseDir, now)
        .then((activity) => {
          cache = { at: now, activity };
          return activity;
        })
        .finally(() => {
          pending = undefined;
        });
      return pending;
    });
  }),
});
