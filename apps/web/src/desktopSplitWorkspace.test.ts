import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

import { DraftId } from "./composerDraftStore";
import { readDesktopSplitWorkspace } from "./desktopSplitWorkspace";
import { removeLocalStorageItem, setLocalStorageItem } from "./hooks/useLocalStorage";

const storageKey = "screddy:split-workspace:v1";
const threadRef = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const draftId = DraftId.make("draft-1");

function store(value: unknown) {
  setLocalStorageItem(storageKey, value, Schema.Unknown);
  return { [Symbol.dispose]: () => removeLocalStorageItem(storageKey) };
}

it("restores a layout saved with a Local Qwen pane, with that pane blank", () => {
  using _stored = store({
    route: { kind: "server", threadRef },
    panes: [
      { kind: "primary" },
      { kind: "qwen", model: "4b" },
      { kind: "thread", threadRef },
      { kind: "draft", draftId },
    ],
  });
  expect(readDesktopSplitWorkspace()).toEqual({
    route: { kind: "server", threadRef },
    panes: [
      { kind: "primary" },
      { kind: "blank" },
      { kind: "thread", threadRef },
      { kind: "draft", draftId },
    ],
  });
});

it("still drops a layout with a pane kind it has never known", () => {
  using _stored = store({
    route: { kind: "split" },
    panes: [{ kind: "blank" }, { kind: "terminal" }],
  });
  expect(readDesktopSplitWorkspace()).toBeNull();
});
