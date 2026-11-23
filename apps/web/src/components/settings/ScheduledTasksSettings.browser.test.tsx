import { RegistryContext } from "@effect/atom-react";
import { Atom, AtomRegistry } from "effect/reactivity";
import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  ScheduledTaskId,
  ThreadId,
  type ScheduledTask,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";
import { ScheduledTasksSettings } from "./ScheduledTasksSettings";

const environmentId = EnvironmentId.make("laptop");
const projectId = ProjectId.make("project");
const task: ScheduledTask = {
  id: ScheduledTaskId.make("nightly"),
  title: "Review issues",
  prompt: "Review open issues",
  enabled: true,
  schedule: { type: "interval", everyMs: 60_000 },
  projectId,
  threadId: ThreadId.make("older-thread"),
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "user",
  creationSource: "web",
  createdAt: "2026-09-17T00:00:00.000Z",
  updatedAt: "2026-09-17T00:00:00.000Z",
  nextRunAt: null,
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
  runCount: 0,
};

// Stands in for the thread family read the editor makes when the shell lacks the bound thread.
const threadFamilyRead = {
  snapshotSequence: 1,
  threads: [{ id: task.threadId, title: "Fix login bug" }],
};

const state = vi.hoisted(() => ({ connected: true, tasksLoaded: true, secondary: false }));
const saveAutomation = vi.hoisted(() => vi.fn());
const secondaryId = EnvironmentId.make("secondary");
const permissions = new Map<string, Atom.Writable<boolean>>();

function setup() {
  state.connected = true;
  state.tasksLoaded = true;
  state.secondary = false;
  saveAutomation.mockReset().mockResolvedValue({ _tag: "Success", value: { task } });
  permissions.clear();
  permissions.set(environmentId, Atom.make(true));
  permissions.set(secondaryId, Atom.make(true));
  permissions.set("", Atom.make(false));
}

function provider(models: ReadonlyArray<{ slug: string; name: string }>): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    installed: true,
    enabled: true,
    version: "test-version",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-17T00:00:00.000Z",
    models: models.map((model) => ({ ...model, isCustom: false, capabilities: null })),
    skills: [],
    slashCommands: [],
    setup: { canAuthenticate: true, canInstall: false },
  };
}

const macProviders = Atom.make([provider([{ slug: "mac-model", name: "Mac model" }])]);
const srcProviders = Atom.make([
  provider([
    { slug: "src-standard", name: "SRC Standard" },
    { slug: "src-review", name: "SRC Review" },
  ]),
]);

function secondaryEnvironment() {
  const entry = environment();
  return {
    ...entry,
    environmentId: secondaryId,
    label: "SRC server",
    serverConfig:
      entry.serverConfig === null
        ? null
        : {
            environment: { ...entry.serverConfig.environment, platform: { os: "linux" } },
          },
  };
}

function environment() {
  return {
    environmentId,
    label: "Laptop",
    connection: { phase: state.connected ? "connected" : "disconnected" },
    serverConfig: state.connected
      ? {
          environment: {
            platform: { os: "darwin" },
            capabilities: { oneTimeSchedules: true, cronSchedules: true },
          },
        }
      : null,
  };
}

vi.mock(import("./SettingsScopeContext"), async (original) => {
  const scope = () => {
    const entry = environment();
    return {
      scope: {
        kind: "all",
        label: "All",
        members: [],
        environmentIds: state.secondary ? [environmentId, secondaryId] : [environmentId],
      },
      environments: state.secondary ? [entry, secondaryEnvironment()] : [entry],
      connectedEnvironments: state.connected
        ? state.secondary
          ? [entry, secondaryEnvironment()]
          : [entry]
        : [],
      environment: entry,
      target: null,
      targets: [],
    };
  };
  return {
    ...(await original()),
    useSettingsScope: scope as never,
  };
});
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();

  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      providersValueAtom: (id: string) => (id === secondaryId ? srcProviders : macProviders),
      upsertScheduledTask: {
        ...actual.serverEnvironment.upsertScheduledTask,
        permissionAtom: (id: string | null) => permissions.get(id ?? "")!,
      },
    },
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => {
  const actual = await original();
  const useAtomCommand: typeof actual.useAtomCommand = (command, options) =>
    typeof options === "object" && options?.label === "scheduled task upsert"
      ? saveAutomation
      : actual.useAtomCommand(command, options);
  return { ...actual, useAtomCommand };
});
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
}));
vi.mock(import("../../state/threads"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    threadFamilies: { ...actual.threadFamilies, familyAtom: (() => threadFamilyRead) as never },
  };
});
// Mirrors the real query: a null request (disconnected environment) has no data.
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((request: unknown) => ({
    data:
      request === null || request === threadFamilyRead
        ? request
        : { tasks: state.tasksLoaded ? [task] : [] },
    error: null,
    isPending: false,
    refresh: vi.fn(),
  })) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironment: ((id: EnvironmentId) =>
    id === secondaryId ? secondaryEnvironment() : environment()) as never,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => [
    { id: projectId, environmentId, title: "Mac project" },
    { id: projectId, environmentId: secondaryId, title: "SRC project" },
  ]) as never,
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: (() => DEFAULT_UNIFIED_SETTINGS) as never,
}));

describe("ScheduledTasksSettings", () => {
  it("creates on a permitted secondary and reacts to permission changes", async () => {
    setup();
    state.secondary = true;
    const registry = AtomRegistry.make();
    using _registry = { [Symbol.dispose]: () => registry.dispose() };
    registry.set(permissions.get(environmentId)!, false);
    await using screen = await render(
      <RegistryContext.Provider value={registry}>
        <ScheduledTasksSettings />
      </RegistryContext.Provider>,
    );
    const create = screen.getByRole("button", { name: "New automation" });
    await expect.element(create).toBeEnabled();
    await act(() => registry.set(permissions.get(secondaryId)!, false));
    await expect.element(create).toBeDisabled();
    await act(() => registry.set(permissions.get(secondaryId)!, true));
    await expect.element(create).toBeEnabled();
    await create.click();
    await expect.element(page.getByLabelText("Runs on")).toHaveTextContent("SRC server");
  });

  it("keeps the permitted representative as the creation target", async () => {
    setup();
    state.secondary = true;
    await using screen = await render(<ScheduledTasksSettings />);
    await screen.getByRole("button", { name: "New automation" }).click();
    await expect.element(page.getByLabelText("Runs on")).toHaveTextContent("Laptop");
  });

  it("keeps the cron schedule when switching from the Mac to SRC", async () => {
    setup();
    state.secondary = true;
    await using screen = await render(<ScheduledTasksSettings />);
    await screen.getByRole("button", { name: "New automation" }).click();
    const dialog = page.getByRole("dialog", { name: "New automation" });
    await expect.element(dialog.getByText(/desktop interaction uses CuaDriver/i)).toBeVisible();
    await dialog.getByRole("button", { name: "Cron", exact: true }).click();
    await userEvent.fill(dialog.getByRole("textbox", { name: "Cron expression" }), "0 9 * * 1-5");
    await userEvent.fill(dialog.getByRole("textbox", { name: "Time zone" }), "America/Los_Angeles");

    await page.getByLabelText("Runs on").click();
    await page.getByRole("option", { name: "SRC server" }).click();
    await expect.element(page.getByLabelText("Runs on")).toHaveTextContent("SRC server");
    await expect.element(dialog.getByText(/server’s tools and model accounts/)).toBeVisible();
    await expect
      .element(dialog.getByRole("textbox", { name: "Cron expression" }))
      .toHaveValue("0 9 * * 1-5");
    await expect
      .element(dialog.getByRole("textbox", { name: "Time zone" }))
      .toHaveValue("America/Los_Angeles");

    await userEvent.fill(dialog.getByRole("textbox", { name: "Name" }), "Check reports");
    await userEvent.fill(dialog.getByRole("textbox", { name: "Prompt" }), "Check the reports.");
    await dialog.getByRole("button", { name: "SRC Standard" }).click();
    await userEvent.fill(page.getByPlaceholder("Search models..."), "SRC Review");
    await page.getByRole("option", { name: /SRC Review/ }).click();
    await dialog.getByRole("button", { name: "Create automation" }).click();
    expect(saveAutomation).toHaveBeenCalledWith({
      environmentId: secondaryId,
      input: expect.objectContaining({
        modelSelection: { instanceId: "codex", model: "src-review" },
        schedule: { type: "cron", expression: "0 9 * * 1-5", timeZone: "America/Los_Angeles" },
      }),
    });
  });

  it("disables creation without a connected target", async () => {
    setup();
    state.connected = false;
    await using screen = await render(<ScheduledTasksSettings />);
    await expect.element(screen.getByRole("button", { name: "New automation" })).toBeDisabled();
  });

  it("keeps a linked task's unsaved edits across a disconnect and reconnect", async () => {
    setup();
    await using screen = await render(<ScheduledTasksSettings taskId={task.id} />);
    await expect.element(page.getByRole("dialog").getByText("Fix login bug")).toBeVisible();
    const name = page.getByRole("dialog").getByRole("textbox", { name: "Name" });
    await expect.element(name).toHaveValue("Review issues");
    await userEvent.fill(name, "Review stale issues");

    state.connected = false;
    await screen.rerender(<ScheduledTasksSettings taskId={task.id} />);

    await expect.element(name).toHaveValue("Review stale issues");

    state.connected = true;
    await screen.rerender(<ScheduledTasksSettings taskId={task.id} />);
    await expect.element(name).toHaveValue("Review stale issues");
  });

  it("keeps an editor the user opened when the linked task loads later", async () => {
    setup();
    state.tasksLoaded = false;
    await using screen = await render(<ScheduledTasksSettings taskId={task.id} />);
    await userEvent.click(page.getByRole("button", { name: "New automation" }));
    const dialog = page.getByRole("dialog");
    const name = dialog.getByRole("textbox", { name: "Name" });
    await userEvent.fill(name, "My draft");

    state.tasksLoaded = true;
    await screen.rerender(<ScheduledTasksSettings taskId={task.id} />);

    await expect
      .element(dialog.getByRole("heading", { name: "New automation" }))
      .toBeInTheDocument();
    await expect.element(name).toHaveValue("My draft");
  });
});
