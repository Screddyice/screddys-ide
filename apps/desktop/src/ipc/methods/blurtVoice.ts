// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Communicates with the same user's native Blurt app over its Unix socket.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Electron from "electron";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopIpc from "../DesktopIpc.ts";
import * as IpcChannels from "../channels.ts";

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64));
const ErrorReply = Schema.Struct({ error: Schema.String });
const Ready = Schema.Struct({ ok: Schema.Literal(true) });
const Result = Schema.Union([ErrorReply, Ready, Schema.Struct({ text: Schema.String })]);
const decodeReply = Schema.decodeUnknownSync(Schema.fromJsonString(Result));
type Reply = typeof Result.Type;

type VoiceConnection = {
  id: string;
  senderId: number;
  controller: AbortController;
  socket?: NodeNet.Socket;
  busy: boolean;
};
let active: VoiceConnection | undefined;
let shortcutSender: { readonly id: number; readonly permittedUntil: number } | undefined;

/** A URL can reveal the app, but only a recent, unconsumed Blurt shortcut can start its mic. */
export function requestBlurtVoiceShortcut(contents: Electron.WebContents, now: number): boolean {
  const path = NodePath.join(
    NodeOS.homedir(),
    "Library",
    "Application Support",
    "blurt",
    "ide-voice-activation",
  );
  try {
    const stats = NodeFS.lstatSync(path);
    if (!stats.isFile() || !privateOwned(stats) || stats.size !== 0) return false;
    NodeFS.unlinkSync(path);
    if (Math.abs(now - stats.mtimeMs) > 10_000) return false;
  } catch {
    return false;
  }
  shortcutSender = { id: contents.id, permittedUntil: now + 2_000 };
  contents.send(IpcChannels.MENU_ACTION_CHANNEL, "blurt.toggleVoice");
  return true;
}

function privateOwned(stats: NodeFS.Stats) {
  return (
    !stats.isSymbolicLink() &&
    (Number(stats.mode) & 0o077) === 0 &&
    stats.uid === process.getuid?.()
  );
}

function readBlurtEndpoint() {
  const file = NodePath.join(
    NodeOS.homedir(),
    "Library",
    "Application Support",
    "blurt",
    "agent-bridge.json",
  );
  const fd = NodeFS.openSync(
    file,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
  );
  let json: unknown;
  try {
    const info = NodeFS.fstatSync(fd);
    if (!info.isFile() || !privateOwned(info) || info.size > 4_096)
      throw new Error("Invalid Blurt endpoint.");
    json = JSON.parse(NodeFS.readFileSync(fd, "utf8"));
  } finally {
    NodeFS.closeSync(fd);
  }
  if (
    typeof json !== "object" ||
    json === null ||
    !("version" in json) ||
    json.version !== 1 ||
    !("socketPath" in json) ||
    typeof json.socketPath !== "string" ||
    !json.socketPath.startsWith("/") ||
    json.socketPath.includes("\0")
  )
    throw new Error("Invalid Blurt endpoint.");
  if (
    !("ideVoiceToken" in json) ||
    typeof json.ideVoiceToken !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(json.ideVoiceToken)
  ) {
    throw new Error("Update Blurt to a version that supports IDE voice mode.");
  }
  const socket = NodeFS.lstatSync(json.socketPath);
  const directory = NodeFS.lstatSync(NodePath.dirname(json.socketPath));
  if (
    !socket.isSocket() ||
    !privateOwned(socket) ||
    !directory.isDirectory() ||
    !privateOwned(directory)
  ) {
    throw new Error("Invalid Blurt endpoint.");
  }
  return { path: json.socketPath, token: json.ideVoiceToken };
}

function exchange(socket: NodeNet.Socket, request: object, timeMs: number): Promise<Reply> {
  return new Promise((resolve) => {
    let buffer = Buffer.alloc(0);
    const disconnected = () => finish({ error: "The connection to Blurt closed." });
    const timeout = setTimeout(() => {
      finish({ error: "Blurt did not respond in time." });
      socket.destroy();
    }, timeMs);
    const finish = (result: Reply) => {
      clearTimeout(timeout);
      socket.off("data", receive);
      socket.off("close", disconnected);
      resolve(result);
    };
    const receive = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(0x0a);
      if (buffer.length > 50_000) {
        finish({ error: "Blurt returned an invalid reply." });
        socket.destroy();
      } else if (newline >= 0) {
        try {
          finish(decodeReply(buffer.subarray(0, newline).toString("utf8")));
        } catch {
          finish({ error: "Blurt returned an invalid reply." });
          socket.destroy();
        }
      }
    };
    socket.once("close", disconnected);
    socket.on("data", receive);
    socket.write(JSON.stringify(request) + "\n");
  });
}

function stop(session: VoiceConnection) {
  session.controller.abort();
  session.socket?.destroy();
  if (active === session) active = undefined;
}

async function launchBlurt(signal: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    NodeChildProcess.execFile(
      "/usr/bin/open",
      ["-g", "-b", "ai.teamnebula.blurt"],
      { signal, timeout: 5_000 },
      (error) =>
        error ? reject(new Error("Install the Blurt Mac app to use voice mode.")) : resolve(),
    );
  });
}

async function openConnection(signal: AbortSignal) {
  await launchBlurt(signal);
  for (let attempt = 0; attempt < 30; attempt++) {
    signal.throwIfAborted();
    try {
      return readBlurtEndpoint();
    } catch (error) {
      if (error instanceof Error && !("code" in error)) throw error;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Blurt did not open its local voice connection.");
}

export const openBlurtVoice = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPEN_BLURT_VOICE_CHANNEL,
  payload: Schema.Struct({ id: Id, fromShortcut: Schema.Boolean }),
  result: Schema.Union([Ready, ErrorReply]),
  handler: Effect.fn("desktop.ipc.blurtVoice.open")(function* ({ id, fromShortcut }, event) {
    const platform = yield* HostProcess.Platform;
    const now = yield* Clock.currentTimeMillis;
    return yield* Effect.promise(async () => {
      if (platform !== "darwin" || !event)
        return { error: "Blurt voice mode requires the Mac app." };
      if (fromShortcut) {
        const permitted =
          shortcutSender?.id === event.sender.id && shortcutSender.permittedUntil > now;
        shortcutSender = undefined;
        if (!permitted) return { error: "Press the Activate Jarvis shortcut again." };
      }
      if (active) return { error: "End the other Blurt voice conversation first." };
      const sender = Electron.webContents.fromId(event.sender.id);
      if (!sender) return { error: "The IDE window is no longer available." };
      const session: VoiceConnection = {
        id,
        senderId: event.sender.id,
        controller: new AbortController(),
        busy: false,
      };
      active = session;
      const onDestroyed = () => stop(session);
      sender.once("destroyed", onDestroyed);
      const signal = session.controller.signal;
      const onAbort = () => {
        sender.removeListener("destroyed", onDestroyed);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      let error = "Could not connect to Blurt.";
      try {
        const endpoint = await openConnection(signal);
        signal.throwIfAborted();
        const socket = NodeNet.connect(endpoint.path);
        session.socket = socket;
        socket.on("error", () => socket.destroy());
        socket.once("close", () => stop(session));
        const reply = await exchange(
          socket,
          { client: "screddy-ide-voice", token: endpoint.token },
          4_000,
        );
        if ("ok" in reply) return reply;
        if ("error" in reply) error = reply.error;
      } catch (cause) {
        if (!signal.aborted && cause instanceof Error && !("code" in cause)) error = cause.message;
      }
      stop(session);
      return { error };
    });
  }),
});

export const turnBlurtVoice = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.TURN_BLURT_VOICE_CHANNEL,
  payload: Schema.Struct({
    id: Id,
    request: Schema.Union([
      Schema.Struct({ action: Schema.Literal("listen") }),
      Schema.Struct({
        action: Schema.Literal("speak"),
        text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_000)),
      }),
    ]),
  }),
  result: Result,
  handler: ({ id, request }, event) =>
    Effect.promise(async () => {
      const session = active;
      if (
        !session?.socket ||
        session.id !== id ||
        session.senderId !== event?.sender.id ||
        session.busy
      ) {
        return { error: "The Blurt voice conversation is unavailable." };
      }
      session.busy = true;
      const result = await exchange(session.socket, request, 100_000);
      session.busy = false;
      return result;
    }),
});

export const closeBlurtVoice = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CLOSE_BLURT_VOICE_CHANNEL,
  payload: Id,
  result: Schema.Void,
  handler: (id, event) =>
    Effect.sync(() => {
      if (active?.id === id && active.senderId === event?.sender.id) stop(active);
    }),
});
