import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";
import { ChildProcessSpawner } from "effect/process";

import { ProcessRunner } from "../processRunner.ts";
import { layerInProcessMcpServer, toolkitRegistration } from "./McpHttpServer.ts";
import { McpInvocationContext, type McpCapability } from "./McpInvocationContext.ts";
import * as ComputerUseDecision from "./toolkits/computerUseDecision.ts";

const clientInfo = { name: "computer-use-decision-test", version: "1.0.0" };
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo,
  protocolVersion: "2025-06-18",
  initializePayload: { protocolVersion: "2025-06-18", clientInfo, capabilities: {} },
  getClient: Effect.die("not used"),
});

it.effect(
  "routes eligible thread decisions to the host JEV and requires review on close calls",
  () => {
    let confidence = 0.94;
    let calls = 0;
    const runner = Layer.succeed(ProcessRunner, {
      run: ({ command, stdin }) =>
        Effect.sync(() => {
          calls++;
          expect(command).toBe("/local-owner/.local/bin/jev-mcp");
          const messages = stdin!
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          expect(messages[2]?.params).toMatchObject({
            name: "jev_decide",
            arguments: {
              state: { context: "Inspect history", text: "Show Sidebar; Delete Digit" },
              questions: {
                control: {
                  criteria: {
                    show_sidebar: "Reveal history",
                    delete_digit: "Change calculation",
                    needs_review: expect.any(String),
                  },
                },
              },
            },
          });
          const probabilities =
            confidence === 0.94
              ? { show_sidebar: 0.94, delete_digit: 0.04, needs_review: 0.02 }
              : { show_sidebar: 0.55, delete_digit: 0.42, needs_review: 0.03 };
          return {
            stdout: JSON.stringify({
              id: 2,
              result: {
                structuredContent: {
                  id: "decision",
                  model: "typesafe/jev",
                  answers: { control: { choice: "show_sidebar", confidence, probabilities } },
                },
              },
            }),
            stderr: "",
            code: ChildProcessSpawner.ExitCode(0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }),
    });
    const registered = toolkitRegistration(
      ComputerUseDecision.toolkit,
      ComputerUseDecision.layer,
    ).pipe(
      Layer.provideMerge(layerInProcessMcpServer),
      Layer.provide(runner),
      Layer.provide(NodeServices.layer),
    );
    return Effect.gen(function* () {
      const mcp = yield* McpServer.McpServer;
      const call = (capabilities: ReadonlyArray<McpCapability>, command?: string) =>
        mcp
          .callTool({
            name: "t3_computer_use_decide",
            arguments: {
              goal: "Inspect history",
              observation: "Show Sidebar; Delete Digit",
              choices: [
                { id: "show_sidebar", meaning: "Reveal history" },
                { id: "delete_digit", meaning: "Change calculation" },
              ],
            },
          })
          .pipe(
            Effect.provideService(McpSchema.McpServerClient, client),
            Effect.provideService(HostProcess.HomeDirectory, "/local-owner"),
            Effect.provideService(HostProcess.Environment, {
              SCREDDY_COMPUTER_USE_JEV_COMMAND: command,
            }),
            Effect.provideService(McpInvocationContext, {
              environmentId: EnvironmentId.make("computer-use"),
              requestNamespace: "provider",
              thread: {
                threadId: ThreadId.make("computer-use"),
                providerSessionId: "provider",
                providerInstanceId: ProviderInstanceId.make("acpRegistry_devin"),
              },
              client: undefined,
              capabilities: new Set(capabilities),
              issuedAt: 1,
            }),
          );

      const configuredLauncher = "/local-owner/.local/bin/jev-mcp";
      const refused = yield* call(["orchestration"], configuredLauncher).pipe(Effect.exit);
      if (refused._tag === "Success") expect(refused.value.isError).toBe(true);
      const unconfigured = yield* call(["computer-use"]);
      expect(unconfigured.isError).toBe(true);
      expect(calls).toBe(0);
      expect((yield* call(["computer-use"], configuredLauncher)).structuredContent).toMatchObject({
        decisionId: "decision",
        choice: "show_sidebar",
      });
      confidence = 0.85;
      expect((yield* call(["computer-use"], configuredLauncher)).structuredContent).toMatchObject({
        choice: "needs_review",
      });
      expect(calls).toBe(2);
    }).pipe(Effect.provide(registered));
  },
);
