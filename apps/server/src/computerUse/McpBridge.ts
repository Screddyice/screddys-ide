// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off -- This stdio bridge starts before the CLI runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";

import { DIRECTORY_NAME, HEARTBEAT_MS } from "@t3tools/shared/ComputerUseActivity";

import { makeMcpActivity } from "./McpActivity.ts";

// The byte stream always passes through. Cap the observer's memory for frames with large images.
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

// CuaDriver emits the JSON-RPC header before the potentially large result.
const RESPONSE_HEADER =
  /^\s*\{\s*"jsonrpc"\s*:\s*"2\.0"\s*,\s*"id"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\s*,/u;

function observeFrames(observe: (message: unknown) => void, responseStream = false) {
  let parts: Buffer[] = [];
  let size = 0;
  return new NodeStream.Transform({
    transform(chunk: Buffer, _encoding, done) {
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start);
        const end = newline === -1 ? chunk.length : newline;
        size += end - start;
        if (size <= MAX_FRAME_BYTES) parts.push(chunk.subarray(start, end));
        if (newline === -1) break;
        try {
          if (size > 0 && size <= MAX_FRAME_BYTES) {
            observe(JSON.parse(Buffer.concat(parts, size).toString("utf8")));
          } else if (responseStream && size > MAX_FRAME_BYTES) {
            const prefix = Buffer.concat(parts, 512).toString("utf8");
            const id = RESPONSE_HEADER.exec(prefix)?.[1];
            if (id !== undefined) observe({ id: JSON.parse(id) });
          }
        } catch {
          // Unrecognized frames have no effect on activity or the MCP transport.
        }
        parts = [];
        size = 0;
        start = end + 1;
      }
      done(null, chunk);
    },
  });
}

export async function runComputerUseMcpBridge(driver: string, baseDir: string): Promise<number> {
  const child = NodeChildProcess.spawn(driver, ["mcp"], { stdio: ["pipe", "pipe", "inherit"] });
  const activity = makeMcpActivity();
  const directory = NodePath.join(baseDir, DIRECTORY_NAME);
  const marker = NodePath.join(directory, `activity-${NodeCrypto.randomUUID()}.json`);
  const draft = `${marker}.tmp`;
  let published = false;
  let stopping = false;

  function clear() {
    if (!published) return;
    try {
      NodeFS.rmSync(marker, { force: true });
      published = false;
    } catch {
      // Desktop discards expired heartbeats if cleanup is unavailable.
    }
  }

  function publish() {
    if (stopping) return;
    const heartbeatAt = Date.now();
    const current = activity.current(heartbeatAt);
    if (current === undefined) {
      clear();
      return;
    }
    try {
      NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const { application, startedAt } = current;
      NodeFS.writeFileSync(draft, JSON.stringify({ application, startedAt, heartbeatAt }), {
        mode: 0o600,
      });
      NodeFS.renameSync(draft, marker);
      published = true;
    } catch {
      // Activity is best effort. CuaDriver stays available if the status file cannot be written.
    }
  }

  const requests = observeFrames((message) => {
    activity.request(message, Date.now());
    publish();
  });
  const responses = observeFrames((message) => {
    activity.response(message, Date.now());
    publish();
  }, true);

  const heartbeat = setInterval(publish, HEARTBEAT_MS).unref();

  return new Promise((resolve) => {
    let killTimer: NodeJS.Timeout | undefined;
    function stop() {
      if (stopping) return;
      stopping = true;
      clearInterval(heartbeat);
      clear();
      child.kill();
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }

    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    process.stdout.on("error", stop);
    process.stdin.on("error", stop);
    child.stdin.on("error", stop);
    child.stdout.on("error", stop);
    child.once("error", (error) => process.stderr.write(`CuaDriver: ${error.message}\n`));
    child.once("close", (code) => {
      clearInterval(heartbeat);
      clearTimeout(killTimer);
      clear();
      try {
        NodeFS.rmSync(draft, { force: true });
      } catch {
        // A partial status file is never read by the desktop.
      }
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      process.stdout.off("error", stop);
      process.stdin.off("error", stop);
      process.stdin.unpipe(requests);
      process.stdin.pause();
      resolve(code ?? 1);
    });

    process.stdin.pipe(requests);
    requests.pipe(child.stdin);
    child.stdout.pipe(responses);
    responses.pipe(process.stdout, { end: false });
  });
}
