import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";
import { McpSchema, McpServer } from "effect/ai";

import { ServerConfig } from "../config.ts";
import { ProcessRunner } from "../processRunner.ts";
import { layerInProcessMcpServer, toolkitRegistration } from "./McpHttpServer.ts";
import { McpInvocationContext, type McpCapability } from "./McpInvocationContext.ts";
import * as PhoneControl from "./toolkits/phoneControl.ts";

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "phone-route-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    clientInfo: { name: "phone-route-test", version: "1.0.0" },
    capabilities: {},
  },
  getClient: Effect.die("not used"),
});

const macWithoutUsb = Layer.succeed(ProcessRunner, {
  run: ({ command }) =>
    Effect.succeed({
      stdout: command === "/usr/bin/xcrun" ? '{"result":{"devices":[]}}' : "",
      stderr: "",
      code: ChildProcessSpawner.ExitCode(0),
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutInvalidUtf8: false,
      stderrInvalidUtf8: false,
    }),
});

const testLayer = toolkitRegistration(PhoneControl.toolkit, PhoneControl.layer).pipe(
  Layer.provideMerge(layerInProcessMcpServer),
  Layer.provide(
    Layer.mergeAll(
      macWithoutUsb,
      ServerConfig.layerTest(process.cwd(), { prefix: "phone-control-test-" }),
    ),
  ),
  Layer.provide(NodeServices.layer),
);

it.effect("only returns the local Mirroring route to a thread with Computer Use", () =>
  Effect.gen(function* () {
    const mcp = yield* McpServer.McpServer;
    const call = (capabilities: ReadonlyArray<McpCapability>) =>
      mcp.callTool({ name: "phone_control_route", arguments: {} }).pipe(
        Effect.provideService(McpSchema.McpServerClient, client),
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provideService(McpInvocationContext, {
          environmentId: EnvironmentId.make("phone-test"),
          requestNamespace: "phone-session",
          thread: {
            threadId: ThreadId.make("phone-thread"),
            providerSessionId: "phone-session",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          capabilities: new Set(capabilities),
          issuedAt: 1,
        }),
      );

    const route = yield* call(["computer-use"]);
    expect(route.isError).toBe(false);
    expect(route.structuredContent).toMatchObject({
      route: "mirroring",
      bundleId: "com.apple.ScreenContinuity",
    });
    const refused = yield* call(["preview"]).pipe(Effect.exit);
    if (refused._tag === "Success") expect(refused.value.isError).toBe(true);
  }).pipe(Effect.provide(testLayer)),
);
