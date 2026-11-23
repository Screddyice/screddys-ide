import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type DesktopBridge,
  type MissionControlHandoff,
  type MissionControlItem,
  type ServerProvider,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { expect, it, vi } from "vite-plus/test";
import * as Option from "effect/Option";
import { page } from "vite-plus/test/browser";
import "~/index.css";

import { render } from "../../test/render";
import { appAtomRegistry } from "../rpc/atomRegistry";
import type { EnvironmentPresentation } from "../state/environments";
import { environmentServerConfigsAtom } from "../state/server";
import {
  MissionControlHandoffButton,
  useMissionControlHandoffs,
} from "./MissionControlHandoffButton";

const calls = vi.hoisted(() => ({
  start: vi.fn(),
  scratch: vi.fn(),
  refreshProviders: vi.fn(),
  projects: [] as EnvironmentProject[],
  configs: new Map(),
  providers: new Map(),
  primaryEnvironment: null as EnvironmentId | null,
  environments: [] as EnvironmentPresentation[],
}));
vi.mock(import("../state/use-orchestration-command"), async (original) => ({
  ...(await original()),
  useOrchestrationCommand: (() => calls.start) as never,
}));
vi.mock(import("../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => calls.refreshProviders) as never,
}));
vi.mock(import("../hooks/useScratchProject"), async (original) => ({
  ...(await original()),
  useScratchProject: (() => ({ openScratchProject: calls.scratch })) as never,
}));
vi.mock(import("../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: () => calls.primaryEnvironment,
  useEnvironments: (() => ({ environments: calls.environments })) as never,
  useEnvironmentProviders: () => calls.providers,
}));
vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: () => calls.projects,
  useServerConfigs: () => calls.configs,
}));

const item: MissionControlItem = {
  id: "linear:fixture",
  source: "linear",
  account: "Team",
  title: "Fix a failing checkout test",
  detail: "This detail is private",
  url: "https://linear.app/example/issue/ENG-1",
  activity: "2026-11-17T00:00:00Z",
  due: null,
  urgency: "high",
  taskContext: { product: "hypercrawl", workflow: "implementation" },
};
function installBridge(handoff: MissionControlHandoff) {
  calls.start.mockReset();
  calls.scratch.mockReset();
  calls.refreshProviders.mockReset();
  calls.projects = [];
  calls.configs.clear();
  calls.providers.clear();
  calls.primaryEnvironment = EnvironmentId.make("handoff-fixture");
  calls.environments = [];
  const originalBridge = Object.getOwnPropertyDescriptor(window, "desktopBridge");
  const route = vi.fn<DesktopBridge["routeMissionControlItems"]>().mockResolvedValue([handoff]);
  const openExternal = vi.fn<DesktopBridge["openExternal"]>().mockResolvedValue(true);
  Object.defineProperty(window, "desktopBridge", {
    value: {
      routeMissionControlItems: route,
      openExternal,
      getLocalEnvironmentEnabled: () => false,
      getLocalEnvironmentBootstraps: () => [],
    },
    configurable: true,
  });
  return {
    route,
    openExternal,
    [Symbol.dispose]() {
      if (originalBridge) Object.defineProperty(window, "desktopBridge", originalBridge);
      else Reflect.deleteProperty(window, "desktopBridge");
    },
  };
}

function Harness({ task = item }: { task?: MissionControlItem }) {
  const [handoff] = useMissionControlHandoffs(window.desktopBridge, [task]);
  return <MissionControlHandoffButton item={task} handoff={handoff} />;
}

it.each([
  { kind: "cursor", grokReady: true, cursorReady: true, coldStart: false, expected: "cursor" },
  { kind: "claude", grokReady: true, cursorReady: true, coldStart: false, expected: "claudeAgent" },
  { kind: "grok_build", grokReady: true, cursorReady: true, coldStart: false, expected: "grok" },
  { kind: "grok_build", grokReady: false, cursorReady: true, coldStart: false, expected: "cursor" },
  { kind: "cursor", grokReady: true, cursorReady: false, coldStart: false, expected: "grok" },
  { kind: "grok_build", grokReady: true, cursorReady: true, coldStart: true, expected: "grok" },
] as const)(
  "launches $kind in one click through $expected (Grok: $grokReady, Cursor: $cursorReady, cold start: $coldStart)",
  async ({ kind, grokReady, cursorReady, coldStart, expected }) => {
    using bridge = installBridge({ kind });
    const projectId = ProjectId.make("scratch-project");
    const instanceId = ProviderInstanceId.make(expected);
    const agents = {
      grok: { name: "Grok", model: "grok-build", label: "Grok Build" },
      cursor: { name: "Cursor", model: "cursor-model", label: "Cursor Default" },
      claudeAgent: { name: "Claude", model: "claude-haiku-4-5", label: "Claude Haiku" },
    };
    const { model, label } = agents[expected];
    const { name } = agents[coldStart ? "grok" : expected];
    const environmentId = EnvironmentId.make("handoff-fixture");
    if (kind === "claude") {
      calls.primaryEnvironment = null;
      calls.environments = [
        { id: EnvironmentId.make("remote"), url: "https://remote.example.test" },
        { id: environmentId, url: "http://127.0.0.1:3774/" },
      ].map(
        ({ id, url }) =>
          ({
            environmentId: id,
            connection: { phase: "connected" },
            entry: {
              target: { _tag: "BearerConnectionTarget" },
              profile: Option.some({ _tag: "BearerConnectionProfile", httpBaseUrl: url }),
            },
          }) as EnvironmentPresentation,
      );
    }
    const matchingProject = {
      id: ProjectId.make("team-hypercrawl"),
      environmentId,
      title: "HyperCrawl",
      workspaceRoot: "/fixture/hypercrawl",
      repositoryIdentity: { provider: "github", owner: "teamnebula-ai", name: "hypercrawl" },
      defaultThreadEnvMode: "worktree",
    } as EnvironmentProject;
    if (kind === "grok_build") {
      calls.projects = [
        {
          ...matchingProject,
          id: ProjectId.make("personal-fork"),
          repositoryIdentity: { ...matchingProject.repositoryIdentity!, owner: "personal" },
        },
        matchingProject,
      ];
    }
    const providers = [
      {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        driver: "claudeAgent",
        displayName: "Claude",
        enabled: true,
        status: "ready",
        models: [{ slug: "claude-haiku-4-5", name: "Claude Haiku", isDefault: true }],
      },
      {
        instanceId: ProviderInstanceId.make("grok"),
        driver: "grok",
        displayName: "Grok",
        enabled: grokReady,
        installed: true,
        status: "ready",
        auth: { status: "authenticated" },
        models: [{ slug: "grok-build", name: "Grok Build", isDefault: true }],
      },
      {
        instanceId: ProviderInstanceId.make("cursor"),
        driver: "cursor",
        displayName: "Cursor",
        enabled: cursorReady,
        installed: true,
        status: "ready",
        auth: { status: "authenticated" },
        models: [{ slug: "cursor-model", name: "Cursor Default", isDefault: true }],
      },
    ];
    calls.refreshProviders.mockResolvedValue({ _tag: "Success", value: { providers } });
    const snapshot = new Map([
      [
        environmentId,
        {
          providers: coldStart ? providers.filter(({ driver }) => driver !== "grok") : providers,
          settings: {
            ...DEFAULT_SERVER_SETTINGS,
            providerInstances: {
              claudeAgent: { driver: "claudeAgent", enabled: true, config: {} },
              grok: { driver: "grok", enabled: grokReady, config: {} },
              cursor: { driver: "cursor", enabled: cursorReady, config: {} },
            },
            projectSettingsOverrides: {},
          },
        },
      ],
    ]);
    const get = appAtomRegistry.get.bind(appAtomRegistry);
    using _read = vi
      .spyOn(appAtomRegistry, "get")
      .mockImplementation(
        (atom) => (atom === environmentServerConfigsAtom ? snapshot : get(atom)) as never,
      );
    calls.configs.set(environmentId, snapshot.get(environmentId));
    calls.providers.set(environmentId, snapshot.get(environmentId)!.providers);
    await using screen = await render(<Harness />);
    calls.scratch.mockResolvedValue({ id: projectId });
    calls.start.mockResolvedValue({ _tag: "Success", value: {} });
    const action = screen.getByRole("button", {
      name: "Start with " + name + " for " + item.title,
    });
    const modelLabel = coldStart ? "Checking model…" : label;
    await expect.element(action.getByText(modelLabel)).toBeVisible();
    await action.click();
    await expect.poll(() => calls.start.mock.calls.length).toBe(1);
    if (kind !== "claude") {
      expect(calls.refreshProviders).toHaveBeenCalledExactlyOnceWith({
        environmentId,
        input: { instanceId },
      });
    } else {
      expect(calls.refreshProviders).not.toHaveBeenCalled();
    }
    expect(calls.start).toHaveBeenCalledWith({
      environmentId,
      input: expect.objectContaining({
        runtimeMode: "approval-required",
        modelSelection: { instanceId, model },
        message: expect.objectContaining({
          role: "user",
          text: expect.stringContaining(item.title),
        }),
        bootstrap: expect.objectContaining({
          createThread: expect.objectContaining({
            projectId: kind === "grok_build" ? matchingProject.id : projectId,
            title: item.title,
            modelSelection: { instanceId, model },
          }),
          ...(kind === "grok_build" && {
            prepareWorktree: {
              projectCwd: matchingProject.workspaceRoot,
              baseBranch: "HEAD",
              requireWorktree: true,
            },
          }),
        }),
      }),
    });
    await vi.waitFor(() =>
      expect(screen.router?.state.location.pathname).toBe(
        `/${environmentId}/${calls.start.mock.calls[0]![0].input.threadId}`,
      ),
    );
    expect(bridge.route).toHaveBeenCalledWith([
      { source: item.source, title: item.title, taskContext: item.taskContext },
    ]);
  },
);

it.each([
  { source: "linear", blocked: ["grok"], expected: "cursor" },
  { source: "linear", blocked: ["grok", "cursor"], expected: "cursor_review_secondary" },
  { source: "linear", blocked: ["grok", "cursor", "cursor_review_secondary"], expected: null },
  { source: "tasks", blocked: ["grok", "cursor", "cursor_review_secondary"], expected: null },
  { source: "tasks", blocked: ["grok"], expected: "cursor", cursorAutoLimitOnly: true },
] as const)(
  "uses $expected for $source with signed-in accounts at their limits ($blocked)",
  async ({ source, blocked, expected, ...options }) => {
    using _bridge = installBridge({ kind: "grok_build" });
    const task: MissionControlItem = { ...item, source, taskContext: undefined };
    const environmentId = calls.primaryEnvironment!;
    const checkedAt = "2026-11-22T00:00:00Z";
    const accounts = [
      ["grok", "grok", "Grok", "grok-4.7", ["subscription"]],
      ["cursor", "cursor", "Cursor", "default", ["autoPercentUsed", "apiPercentUsed"]],
      [
        "cursor_review_secondary",
        "cursor",
        "Cursor Alternate",
        "default",
        ["autoPercentUsed", "totalPercentUsed"],
      ],
    ] as const;
    const healthy: ServerProvider[] = accounts.map(([instanceId, driver, displayName, slug]) => ({
      instanceId: ProviderInstanceId.make(instanceId),
      driver: ProviderDriverKind.make(driver),
      displayName,
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt,
      models: [{ slug, name: displayName, isCustom: false, isDefault: true, capabilities: null }],
      slashCommands: [],
      skills: [],
    }));
    const fresh = healthy.map((provider, index): ServerProvider => ({
      ...provider,
      usageLimits: {
        checkedAt,
        windows: accounts[index]![4].map((id) => ({
          id,
          label: id,
          kind: "monthly",
          usedPercent:
            blocked.some((instanceId) => instanceId === provider.instanceId) ||
            ("cursorAutoLimitOnly" in options &&
              provider.instanceId === "cursor" &&
              id === "autoPercentUsed")
              ? 100
              : 20,
        })),
      },
    }));
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: Object.fromEntries(
        healthy.map(({ instanceId, driver }) => [
          instanceId,
          { driver, enabled: true, config: {} },
        ]),
      ),
    };
    const snapshot = new Map([[environmentId, { providers: healthy, settings }]]);
    const get = appAtomRegistry.get.bind(appAtomRegistry);
    using _read = vi
      .spyOn(appAtomRegistry, "get")
      .mockImplementation(
        (atom) => (atom === environmentServerConfigsAtom ? snapshot : get(atom)) as never,
      );
    calls.configs.set(environmentId, snapshot.get(environmentId));
    calls.providers.set(environmentId, healthy);
    calls.refreshProviders.mockResolvedValue({ _tag: "Success", value: { providers: fresh } });
    calls.scratch.mockResolvedValue({ id: ProjectId.make("scratch-project") });
    calls.start.mockResolvedValue({ _tag: "Success", value: {} });

    await using screen = await render(<Harness task={task} />);
    await screen.getByRole("button", { name: "Start with Grok for " + task.title }).click();
    if (expected) {
      await expect
        .poll(() => calls.start.mock.calls[0]?.[0].input.modelSelection)
        .toEqual({
          instanceId: expected,
          model: "default",
        });
      expect(calls.start).toHaveBeenCalledTimes(1);
    } else {
      await expect.element(screen.getByText(/Chat skipped/)).toBeVisible();
      expect(calls.scratch).not.toHaveBeenCalled();
      expect(calls.start).not.toHaveBeenCalled();
    }
    const probed = expected === "cursor" ? accounts.slice(0, 2) : accounts;
    expect(calls.refreshProviders.mock.calls.map(([call]) => call.input.instanceId)).toEqual(
      probed.map(([instanceId]) => instanceId),
    );
  },
);

it("launches Grok Bot when a main assistant is not configured", async () => {
  using bridge = installBridge({ kind: "grok", url: null });
  const { openExternal } = bridge;
  await using screen = await render(<Harness />);
  using clip = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const action = screen.getByRole("button", {
    name: "Go to Grok for " + item.title,
  });
  await expect.element(action).toBeVisible();
  await expect.element(action.getByText("Go to Grok")).toBeVisible();
  expect(openExternal).not.toHaveBeenCalled();
  await action.click();
  await expect.poll(() => openExternal.mock.calls.length).toBe(1);
  expect(openExternal).toHaveBeenCalledExactlyOnceWith("grokbot://app");
  expect(clip).not.toHaveBeenCalled();
});

it("opens the named assistant with a conversation link and leaves its draft alone", async () => {
  const url = "grokbot://app/v1/agent?id=fixture";
  using bridge = installBridge({
    kind: "grok",
    botName: "Test Assistant",
    url,
  });
  await using screen = await render(<Harness />);
  using clip = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const action = screen.getByRole("button", { name: "Go to Grok for " + item.title });
  await expect.element(action.getByText("Test Assistant")).toBeVisible();
  await action.click();
  await expect.poll(() => bridge.openExternal.mock.calls.length).toBe(1);
  expect(bridge.openExternal).toHaveBeenCalledExactlyOnceWith(url);
  expect(clip).not.toHaveBeenCalled();
  expect(calls.start).not.toHaveBeenCalled();
});

it.each(["needs_review", "unavailable"] as const)(
  "shows the task status and its source without pickers when routing is %s",
  async (kind) => {
    using bridge = installBridge({ kind });
    await using screen = await render(<Harness />);
    const action = screen.getByRole("button", { name: "Review handoff for " + item.title });
    await action.click();
    const dialog = page.getByRole("dialog", { name: "Task handoff" });
    await expect.element(dialog.getByText(item.title)).toBeVisible();
    await expect
      .element(
        dialog.getByText(
          kind === "unavailable"
            ? "Agent routing is unavailable right now."
            : "Screddy couldn’t confidently match this task to an agent.",
        ),
      )
      .toBeVisible();
    await expect.element(dialog.getByRole("combobox")).not.toBeInTheDocument();
    await expect
      .element(dialog.getByRole("button", { name: /^Start with/ }))
      .not.toBeInTheDocument();
    await dialog.getByRole("button", { name: "Open source" }).click();
    expect(bridge.openExternal).toHaveBeenCalledExactlyOnceWith(item.url);
    expect(calls.start).not.toHaveBeenCalled();
    await expect.element(action).toHaveFocus();
  },
);
