import { McpCapabilityUnavailableError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveNodeExecutable } from "@t3tools/shared/nodeRuntime";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import { readCoreDevices, selectPhoneRoute } from "../../computerUse/PhoneRoute.ts";
import { ServerConfig } from "../../config.ts";
import { AGENT_DEVICE_VERSION, installedAgentDeviceEntry } from "../../device/DeviceToolchain.ts";
import { ProcessRunner } from "../../processRunner.ts";
import * as McpInvocationContext from "../McpInvocationContext.ts";
import * as McpToolAccess from "../McpToolAccess.ts";

const PhoneControlRoute = Tool.make("phone_control_route", {
  description:
    "For an authorized task on a physical iPhone, determine whether to use the local USB device or iPhone Mirroring. Does not open apps or send input.",
  parameters: Schema.Struct({
    deviceId: Schema.optional(
      Schema.String.annotate({ description: "The requested wired target ID, if already known." }),
    ),
  }),
  success: Schema.Struct({
    route: Schema.Literals(["usb", "mirroring", "blocked", "select"]),
    message: Schema.String,
    bundleId: Schema.optional(Schema.String),
    targets: Schema.optional(
      Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
    ),
    command: Schema.optional(
      Schema.Struct({
        executable: Schema.String,
        leadingArgs: Schema.Array(Schema.String),
        targetArgs: Schema.Array(Schema.String),
      }),
    ),
  }),
  failure: Schema.Union([McpCapabilityUnavailableError, OrchestratorMcpFailure]),
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ProcessRunner,
    ServerConfig,
    FileSystem.FileSystem,
    Path.Path,
  ],
})
  .annotate(Tool.Title, "Find the iPhone control route")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hasComputerUseThread);

export const toolkit = Toolkit.make(PhoneControlRoute);

const blocked = (message: string) => ({ route: "blocked", message }) as const;

const usbExecutable = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fs
    .readDirectory(path.join(config.baseDir, "tools", "agent-device"))
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  const versions = entries
    .filter((entry) => /^\d+\.\d+\.\d+$/u.test(entry) && entry !== AGENT_DEVICE_VERSION)
    .toSorted((a, b) => b.localeCompare(a, "en", { numeric: true }));
  const entry = yield* installedAgentDeviceEntry(config.baseDir, [
    AGENT_DEVICE_VERSION,
    ...versions,
  ]);
  if (entry === null) {
    const executable = yield* resolveCommandPath("agent-device");
    return executable === null ? null : { executable, leadingArgs: [] };
  }
  const executable = yield* resolveNodeExecutable("Local device support").pipe(
    Effect.orElseSucceed(() => null),
  );
  if (executable === null) return null;
  const environment = yield* HostProcess.Environment;
  return environment.ELECTRON_RUN_AS_NODE === "1"
    ? { executable: "/usr/bin/env", leadingArgs: ["ELECTRON_RUN_AS_NODE=1", executable, entry] }
    : { executable, leadingArgs: [entry] };
});

export const layer = McpToolAccess.toLayer(toolkit, {
  phone_control_route: McpToolAccess.readsAsCaller(({ deviceId }) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("computer-use");
      if (scope.thread.subagent === true) return blocked("Phone control requires the main thread.");
      if ((yield* HostProcess.Platform) !== "darwin")
        return blocked("Phone control needs the local Mac.");
      const { run } = yield* ProcessRunner;
      const probe = (command: string, args: ReadonlyArray<string>) =>
        run({ command, args, timeout: "7 seconds", maxOutputBytes: 1024 * 1024 }).pipe(
          Effect.map((result) => (result.code === 0 ? result.stdout : undefined)),
          Effect.orElseSucceed(() => undefined),
        );
      const [usb, coreDevices] = yield* Effect.all(
        [
          probe("/usr/sbin/ioreg", ["-r", "-c", "IOUSBHostDevice", "-d", "1", "-l", "-w0"]),
          probe("/usr/bin/xcrun", [
            "devicectl",
            "list",
            "devices",
            "--quiet",
            "--timeout",
            "5",
            "--json-output",
            "-",
          ]),
        ],
        { concurrency: 2 },
      );
      const route = selectPhoneRoute(
        coreDevices === undefined ? undefined : readCoreDevices(coreDevices),
        usb === undefined ? undefined : /"USB Product Name"\s*=\s*"iPhone"/u.test(usb),
      );
      if (route.route === "blocked") return route;
      if (route.route === "mirroring") {
        if (deviceId !== undefined) {
          return blocked(
            "The selected wired iPhone is no longer attached. Confirm the intended iPhone before using Mirroring.",
          );
        }
        return {
          route: "mirroring" as const,
          bundleId: "com.apple.ScreenContinuity",
          message:
            "Use CuaDriver launch_app with bundleId, then target the iPhone Mirroring window. The phone must be locked and nearby. Let the user handle authentication. If Mirroring timed out, press Connect once the phone is locked. Once the phone is visible, use CuaDriver invoke_menu for native commands such as View > Home Screen. For taps use foreground delivery and window-local coordinates. Verify each action with a fresh window observation. Confirm the selected iPhone if the user named one.",
        };
      }
      if (!scope.capabilities.has("device")) {
        return blocked(
          "A wired iPhone is available. Enable Agent device access for this project to use it.",
        );
      }
      const target =
        deviceId === undefined && route.targets.length === 1
          ? route.targets[0]
          : route.targets.find((candidate) => candidate.id === deviceId);
      if (target === undefined) {
        return {
          route: "select" as const,
          message: "Select the intended wired iPhone and call this tool with its deviceId.",
          targets: route.targets,
        };
      }
      const command = yield* usbExecutable;
      if (command === null) {
        return blocked(
          "Wired control requires Node.js and the IDE's agent-device tools. Enable Device support or install agent-device on this Mac.",
        );
      }
      return {
        route: "usb" as const,
        message:
          "Run the executable on this Mac with leadingArgs, then the action and targetArgs. Start with open <bundle-id>, then snapshot before input. Close this session when finished. Xcode must be able to sign the XCTest runner.",
        targets: [target],
        command: {
          ...command,
          targetArgs: [
            "--platform",
            "ios",
            "--udid",
            target.id,
            "--session",
            `screddy-phone-${scope.thread.threadId}`,
          ],
        },
      };
    }),
  ),
});
