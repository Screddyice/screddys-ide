// @effect-diagnostics nodeBuiltinImport:off -- Uses a temporary native config file like the desktop router.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { routeItems } from "./handoff.ts";
import { srcosItems } from "./srcos.ts";

const task = {
  id: "task-1",
  tenantId: "personal",
  title: "Personal follow-up",
  description: "Private text",
  clientId: null,
  clientVisible: false,
  status: "blocked",
  priority: "normal",
  dueDate: "2026-11-19T12:00:00Z",
};

describe("SRCOS Mission Control boundaries", () => {
  it("only maps open internal work in the configured personal tenant", () => {
    const items = srcosItems(
      [
        task,
        { ...task, id: "closed", status: "done" },
        { ...task, id: "client", clientId: "client-id" },
        { ...task, id: "visible", clientVisible: true },
      ],
      "personal",
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      source: "srcos",
      id: "srcos:task-1",
      due: "2026-11-19",
      urgency: "high",
    });
    expect(JSON.stringify(items)).not.toContain(task.description);
    expect(() => srcosItems([{ ...task, tenantId: "team" }], "personal")).toThrow(/tenant/);
  });

  it("offers the Grok launcher without routing personal work to a team bot", async () => {
    await expect(
      routeItems("/unconfigured", "/unconfigured", [
        {
          source: "srcos",
          title: "HyperScale campaign operations",
        },
      ]),
    ).resolves.toEqual([{ kind: "grok", url: null }]);
  });

  it("opens the configured main assistant across tasks and ignores legacy ticket routes", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "screddy-srcos-route-"));
    const url = "grokbot://app/v1/agent?id=fixture-assistant";
    const botName = "Test Assistant";
    try {
      await NodeFSP.writeFile(
        NodePath.join(directory, "mission-control.json"),
        JSON.stringify({
          grokBot: { url, botName },
          srcosGrokHandoffs: {
            "EX-31": { url: "grokbot://app/v1/agent?id=old-specialist", botName: "Old bot" },
          },
        }),
      );
      await expect(
        routeItems("/unconfigured", directory, [
          { source: "srcos", title: "[EX-31] Follow up on the presentation" },
          { source: "srcos", title: "[EX-310] Follow up on the presentation" },
          { source: "tasks", title: "[EX-31] Follow up on the presentation" },
          { source: "srcos", title: "Status?" },
          { source: "srcos", title: "[EX-31] Follow up", taskContext: { restricted: true } },
        ]),
      ).resolves.toEqual([
        { kind: "grok", url, botName },
        { kind: "grok", url, botName },
        { kind: "grok", url, botName },
        { kind: "claude" },
        { kind: "needs_review" },
      ]);
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});
