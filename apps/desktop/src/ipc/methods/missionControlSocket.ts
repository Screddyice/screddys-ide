// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- A private Unix socket lets the local Screddy server reach Mission Control.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import {
  MISSION_CONTROL_SOCKET_MAX_REQUEST_BYTES,
  MISSION_CONTROL_SOCKET_OPERATIONS,
  missionControlSocketPath,
  type MissionControlSocketOperation,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import {
  getMissionControl,
  getMissionControlReply,
  runMissionControlAction,
} from "./missionControl.ts";

class MissionControlSocketError extends Schema.TaggedError<MissionControlSocketError>()(
  "MissionControlSocketError",
  { cause: Schema.Defect() },
) {}

/** A slow Composio call still finishes well inside this; a stuck client does not hold a socket. */
const CONNECTION_TIMEOUT_MS = 180_000;

type Dispatch = (op: MissionControlSocketOperation, payload: unknown) => Promise<unknown>;

function isOperation(value: unknown): value is MissionControlSocketOperation {
  return MISSION_CONTROL_SOCKET_OPERATIONS.some((op) => op === value);
}

function reply(socket: NodeNet.Socket, body: unknown) {
  if (!socket.destroyed) socket.end(JSON.stringify(body) + "\n");
}

async function answer(raw: string, dispatch: Dispatch) {
  let request: unknown;
  try {
    request = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Mission Control could not read this request." };
  }
  const { op, payload } = (request && typeof request === "object" ? request : {}) as {
    op?: unknown;
    payload?: unknown;
  };
  if (!isOperation(op))
    return { ok: false, error: "Mission Control does not support this request." };
  try {
    return { ok: true, result: await dispatch(op, payload) };
  } catch {
    return { ok: false, error: "Mission Control could not complete this request." };
  }
}

/** How many item ids from recent answers an app may still act on. */
const SHOWN_LIMIT = 2_000;
const unshown = { ok: false, error: "Read Mission Control again, then act on an item it shows." };

function fields(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/**
 * Connected apps act only on items Mission Control showed them: the unrestricted items of a recent
 * priorities answer, or a task they just added. A restricted item's id never qualifies, even if the
 * app learned it some other way.
 */
export function guardShownItems(dispatch: Dispatch): Dispatch {
  const shown = new Set<string>();
  const remember = (id: unknown) => {
    if (typeof id !== "string") return;
    shown.delete(id);
    shown.add(id);
    const oldest = shown.values().next().value;
    if (shown.size > SHOWN_LIMIT && oldest !== undefined) shown.delete(oldest);
  };
  return async (op, payload) => {
    const action = op === "action" ? fields(payload) : undefined;
    const target = op === "reply-preview" ? payload : action?.itemId;
    if (
      (op === "reply-preview" || (action && action.kind !== "create-task")) &&
      !(typeof target === "string" && shown.has(target))
    ) {
      return unshown;
    }
    const result = await dispatch(op, payload);
    if (op === "priorities") {
      for (const item of Array.isArray(fields(result).items)
        ? (fields(result).items as unknown[])
        : []) {
        const id = fields(item).id;
        // An item that has become restricted loses any permission it had before.
        if (fields(fields(item).taskContext).restricted === true) {
          if (typeof id === "string") shown.delete(id);
        } else remember(id);
      }
    } else if (action?.kind === "create-task" && fields(result).ok === true) {
      remember(fields(result).itemId);
    }
    return result;
  };
}

/**
 * Where the socket binds before it is renamed into place. Electron's Node caps a Unix socket path
 * at 104 bytes, so this is never longer than the final path: if that one fits, this one does too.
 */
export function socketStagingPath(path: string) {
  return NodePath.join(NodePath.dirname(path), `.${process.pid}`);
}

/** Whether another running app already answers on this socket. */
function answering(path: string) {
  return new Promise<boolean>((resolve) => {
    const probe = NodeNet.connect(path);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

/**
 * Serves one JSON request per connection, `{op, payload}` in and `{ok, result | error}` out.
 * The directory is owner-only (0700) and the socket 0600, so only this user's processes connect.
 * A socket another live app answers on is left alone; a stale file from a crash is replaced.
 * Electron's single-instance lock keeps two Screddy apps from starting this at the same time.
 */
export async function serveMissionControlSocket(path: string, dispatch: Dispatch) {
  const directory = NodePath.dirname(path);
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  await NodeFSP.chmod(directory, 0o700);
  if (await answering(path)) {
    return { listening: false, close: async () => {} };
  }

  // A client may close its side once it has sent the request; the reply still goes out.
  const server = NodeNet.createServer({ allowHalfOpen: true }, (socket) => {
    socket.setEncoding("utf8");
    socket.setTimeout(CONNECTION_TIMEOUT_MS, () => socket.destroy());
    let raw = "";
    let handled = false;
    const handle = () => {
      if (handled) return;
      handled = true;
      void answer(raw, dispatch).then((body) => reply(socket, body));
    };
    socket.on("data", (chunk: string) => {
      if (handled) return;
      raw += chunk;
      if (Buffer.byteLength(raw) > MISSION_CONTROL_SOCKET_MAX_REQUEST_BYTES) {
        handled = true;
        reply(socket, { ok: false, error: "This Mission Control request is too large." });
      } else if (raw.includes("\n")) {
        raw = raw.slice(0, raw.indexOf("\n"));
        handle();
      }
    });
    socket.on("end", handle);
    socket.on("error", () => socket.destroy());
  });
  const stop = () => new Promise<void>((resolve) => server.close(() => resolve()));
  // Bind beside the final path, restrict it, then rename it into place in one step, so the socket
  // is never reachable before it is 0600 and a stale file is replaced atomically.
  const staging = socketStagingPath(path);
  await NodeFSP.rm(staging, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(staging, () => {
      server.off("error", reject);
      resolve();
    });
  });
  let inode: number;
  try {
    await NodeFSP.chmod(staging, 0o600);
    await NodeFSP.rename(staging, path);
    inode = (await NodeFSP.stat(path)).ino;
  } catch (error) {
    await stop();
    await NodeFSP.rm(staging, { force: true });
    throw error;
  }

  return {
    listening: true,
    close: async () => {
      // Remove the path only while it is still this socket, never a newer app's.
      const current = await NodeFSP.stat(path).catch(() => null);
      if (current?.ino === inode) await NodeFSP.rm(path, { force: true });
      await stop();
    },
  };
}

const operations = {
  priorities: getMissionControl,
  "reply-preview": getMissionControlReply,
  action: runMissionControlAction,
} satisfies Record<MissionControlSocketOperation, unknown>;

/**
 * Lets the Screddy server on this Mac, started with this app's base directory, reach Mission
 * Control through the same handlers the window uses. Packaged macOS builds only, like those handlers.
 */
export const installMissionControlSocket = Effect.fn("desktop.ipc.installMissionControlSocket")(
  function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    if (!environment.isPackaged || environment.platform !== "darwin") return;
    const runPromise = Effect.runPromiseWith(
      yield* Effect.context<
        Effect.Services<ReturnType<(typeof operations)[MissionControlSocketOperation]["handler"]>>
      >(),
    );
    const server = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          serveMissionControlSocket(
            missionControlSocketPath(environment.baseDir),
            guardShownItems((op, payload) => runPromise(operations[op].handler(payload))),
          ),
        catch: (cause) => new MissionControlSocketError({ cause }),
      }),
      (running) => Effect.promise(running.close),
    ).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Mission Control socket unavailable", error).pipe(Effect.as(undefined)),
      ),
    );
    if (server && !server.listening) {
      yield* Effect.logWarning("Another Screddy app already serves the Mission Control socket");
    }
  },
);
