import {
  AuthProvidersManageScope,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceMutation,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ProviderModelPicker } from "./ProviderModelPicker";

const localEnvironmentId = EnvironmentId.make("local-test-host");
const calls = vi.hoisted(() => ({
  persist: vi.fn<(input: ProviderInstanceMutation) => void>(),
}));

vi.mock(import("../../state/primaryEnvironment"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  return {
    ...(await original()),
    hostEnvironmentIdAtom: Atom.make<string | null>("local-test-host"),
  };
});
vi.mock(import("../../state/session"), async (original) => {
  const hasScope = (environmentId: string | null, scope: string) =>
    environmentId === localEnvironmentId && scope === AuthProvidersManageScope;
  return { ...(await original()), useEnvironmentScope: hasScope, readEnvironmentScope: hasScope };
});
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  usePersistEnvironmentProviderInstanceMutation: (() => async (input: ProviderInstanceMutation) => {
    calls.persist(input);
    return { _tag: "Success" };
  }) as never,
}));

it("adds a loopback model from the normal composer picker and blocks reserved models", async () => {
  calls.persist.mockClear();
  const activeInstanceId = ProviderInstanceId.make("codex");
  const model = { slug: "gpt-test", name: "Cloud test model", isCustom: false, capabilities: {} };
  const entries = deriveProviderInstanceEntries([
    {
      instanceId: activeInstanceId,
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [model],
      slashCommands: [],
      skills: [],
    },
  ]);
  await using screen = await render(
    <ProviderModelPicker
      environmentId={localEnvironmentId}
      activeInstanceId={activeInstanceId}
      model={model.slug}
      lockedProvider={null}
      instanceEntries={entries}
      modelOptionsByInstance={new Map([[activeInstanceId, [model]]])}
      onInstanceModelChange={() => {}}
      isComposerOwned
    />,
  );

  await screen.getByRole("button", { name: "Cloud test model" }).click();
  await page.getByRole("button", { name: "Add local model" }).click();
  const dialog = page.getByRole("dialog", { name: "Add local model" });
  await dialog.getByLabelText("Model ID").fill("qwen3.5:4b-256k");
  await dialog.getByRole("button", { name: "Add model" }).click();
  await expect
    .element(dialog.getByText("This Qwen model is reserved for standalone terminal use."))
    .toBeVisible();
  expect(calls.persist).not.toHaveBeenCalled();

  await dialog.getByLabelText("Model ID").fill("fixture-coder");
  await dialog.getByLabelText("Display name (optional)").fill("My fixture model");
  await dialog.getByRole("button", { name: "Add model" }).click();
  await expect.element(dialog).not.toBeInTheDocument();

  const mutation = calls.persist.mock.calls[0]?.[0];
  expect(mutation?.operation).toBe("create");
  if (!mutation || mutation.operation !== "create")
    throw new Error("Expected a local model registration");
  expect(mutation.instance.displayName).toBe("Local · My fixture model");
  expect(mutation.instance.driver).toBe("opencode");
  expect(mutation.instance.environment).toContainEqual(
    expect.objectContaining({
      name: "OPENCODE_CONFIG_CONTENT",
      value: expect.stringContaining("screddy-local/fixture-coder"),
    }),
  );
});
