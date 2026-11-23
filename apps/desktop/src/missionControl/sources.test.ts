// @effect-diagnostics nodeBuiltinImport:off -- Run the connector against an isolated executable and its output files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import { connector } from "./sources.ts";

it("reads a Composio result file only from that execution's temporary directory", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "screddy-composio-test-"));
  try {
    const outside = NodePath.join(directory, "outside.json");
    await NodeFSP.writeFile(
      outside,
      JSON.stringify({ successful: true, logId: "fixture", data: { result: [] } }),
    );
    const bin = NodePath.join(directory, ".composio");
    await NodeFSP.mkdir(bin);
    await NodeFSP.writeFile(
      NodePath.join(bin, "composio"),
      [
        "#!/bin/sh",
        'p="$TMPDIR/result.json"',
        'if [ "$4" = outside ]; then p="$PWD/outside.json"; fi',
        'if [ "$4" = link ]; then ln -s "$PWD/outside.json" "$p"; fi',
        'if [ "$4" = inside ]; then printf \'%s\' \'{"successful":true,"logId":"fixture","data":{"result":[1,2]}}\' > "$p"; fi',
        'printf \'{"successful":true,"storedInFile":true,"logId":"fixture","outputFilePath":"%s"}\\n\' "$p"',
      ].join("\n"),
      { mode: 0o700 },
    );
    const api = connector(directory);
    await expect(api.action("CUSTOM_NEBOS_LIST_WORKSTREAMS", "inside")).resolves.toEqual({
      result: [1, 2],
    });
    await expect(api.action("CUSTOM_NEBOS_LIST_WORKSTREAMS", "outside")).rejects.toThrow(/outside/);
    await expect(api.action("CUSTOM_NEBOS_LIST_WORKSTREAMS", "link")).rejects.toThrow(/outside/);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
