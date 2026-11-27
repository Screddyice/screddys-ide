import { HostAutomationsSchema } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import { readHostAutomations } from "../../hostAutomations/hostAutomations.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const getHostAutomations = makeIpcMethod({
  channel: IpcChannels.GET_HOST_AUTOMATIONS_CHANNEL,
  payload: Schema.Void,
  result: HostAutomationsSchema,
  handler: Effect.fn("desktop.ipc.hostAutomations.read")(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    if (environment.platform !== "darwin") return { available: false, checkedAt: null, items: [] };
    const now = yield* Clock.currentTimeMillis;
    const items = yield* Effect.promise(() => readHostAutomations(environment.homeDirectory));
    return { available: true, checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now)), items };
  }),
});
