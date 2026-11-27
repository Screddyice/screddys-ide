// @effect-diagnostics nodeBuiltinImport:off -- Exercises a real Unix socket in a temporary directory.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import { missionControlSocketPath } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { serveMissionControlSocket } from "./missionControlSocket.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tempBase() {
  // Short paths: macOS caps a Unix socket path at 104 bytes.
  const base = await NodeFSP.mkdtemp(NodePath.join("/tmp", "mcs-"));
  cleanups.push(() => NodeFSP.rm(base, { recursive: true, force: true }));
  return base;
}

function send(path: string, raw: string) {
  return new Promise<string>((resolve, reject) => {
    const client = NodeNet.connect(path);
    let reply = "";
    client.setEncoding("utf8");
    client.on("data", (chunk: string) => (reply += chunk));
    client.on("end", () => resolve(reply));
    client.on("error", reject);
    client.end(raw);
  });
}

async function serve(base: string, dispatch: Parameters<typeof serveMissionControlSocket>[1]) {
  const server = await serveMissionControlSocket(missionControlSocketPath(base), dispatch);
  cleanups.push(() => server.close());
  return server;
}

it("answers one request per connection through a private socket", async () => {
  const base = await tempBase();
  const dispatch = vi.fn(async (op: string, payload: unknown) => ({ op, payload }));
  const server = await serve(base, dispatch);
  expect(server.listening).toBe(true);

  const path = missionControlSocketPath(base);
  expect((await NodeFSP.stat(NodePath.dirname(path))).mode & 0o777).toBe(0o700);
  expect((await NodeFSP.stat(path)).mode & 0o777).toBe(0o600);

  const reply = JSON.parse(
    await send(path, JSON.stringify({ op: "priorities", payload: { a: 1 } })),
  );
  expect(reply).toEqual({ ok: true, result: { op: "priorities", payload: { a: 1 } } });
  expect(dispatch).toHaveBeenCalledExactlyOnceWith("priorities", { a: 1 });
});

it("refuses unknown operations, malformed and oversized requests without calling Mission Control", async () => {
  const base = await tempBase();
  const dispatch = vi.fn(async () => "never");
  await serve(base, dispatch);
  const path = missionControlSocketPath(base);

  expect(JSON.parse(await send(path, JSON.stringify({ op: "delete-all", payload: {} })))).toEqual({
    ok: false,
    error: "Mission Control does not support this request.",
  });
  expect(JSON.parse(await send(path, "{not json"))).toMatchObject({ ok: false });
  const oversized = JSON.stringify({ op: "action", payload: "x".repeat(70 * 1024) });
  expect(JSON.parse(await send(path, oversized))).toEqual({
    ok: false,
    error: "This Mission Control request is too large.",
  });
  expect(dispatch).not.toHaveBeenCalled();
});

it("reports a failed operation as an error reply", async () => {
  const base = await tempBase();
  await serve(base, async () => {
    throw new Error("Composio is down");
  });
  expect(
    JSON.parse(
      await send(missionControlSocketPath(base), JSON.stringify({ op: "action", payload: {} })),
    ),
  ).toEqual({ ok: false, error: "Mission Control could not complete this request." });
});

it("replaces a stale socket file but leaves a live one to the app that owns it", async () => {
  const base = await tempBase();
  const path = missionControlSocketPath(base);
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
  await NodeFSP.writeFile(path, "");
  const first = await serve(base, async () => "first");
  expect(first.listening).toBe(true);

  const second = await serve(base, async () => "second");
  expect(second.listening).toBe(false);
  await second.close();
  expect(JSON.parse(await send(path, JSON.stringify({ op: "action", payload: {} })))).toEqual({
    ok: true,
    result: "first",
  });

  await first.close();
  await expect(NodeFSP.stat(path)).rejects.toThrow();
});
