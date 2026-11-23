import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AuthProvidersManageScope, type EnvironmentId } from "@t3tools/contracts";
import { useId, useState } from "react";

import { usePersistEnvironmentProviderInstanceMutation } from "../../hooks/useSettings";
import { readEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { localModelInstance } from "./localModel";

export function AddLocalModelDialog({
  environmentId,
  providerLocked,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly providerLocked: boolean;
  readonly onClose: () => void;
}) {
  const id = useId();
  const persist = usePersistEnvironmentProviderInstanceMutation(environmentId);
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:11434/v1");
  const [modelId, setModelId] = useState("");
  const [label, setLabel] = useState("");
  const [toolCalling, setToolCalling] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const save = async () => {
    if (saving || !readEnvironmentScope(environmentId, AuthProvidersManageScope)) return;
    setSaving(true);
    setError(undefined);
    try {
      const registration = await localModelInstance({ baseUrl, modelId, label, toolCalling });
      const result = await persist({ operation: "create", ...registration });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      toastManager.add({
        type: "success",
        title: "Local model added",
        description: providerLocked
          ? "Select it from the model picker in a new thread."
          : "Select it from the model picker once the local provider is ready.",
      });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the local model.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogPopup>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>Add local model</DialogTitle>
            <DialogDescription>
              Use a chat model from an OpenAI-compatible server on this Mac.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 px-6 pb-6">
            <div className="space-y-1.5">
              <label htmlFor={`${id}-url`} className="text-sm font-medium">
                Server URL
              </label>
              <Input
                id={`${id}-url`}
                required
                type="url"
                value={baseUrl}
                autoComplete="off"
                onChange={(event) => setBaseUrl(event.currentTarget.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor={`${id}-model`} className="text-sm font-medium">
                Model ID
              </label>
              <Input
                id={`${id}-model`}
                required
                maxLength={160}
                value={modelId}
                autoComplete="off"
                onChange={(event) => setModelId(event.currentTarget.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor={`${id}-label`} className="text-sm font-medium">
                Display name (optional)
              </label>
              <Input
                id={`${id}-label`}
                value={label}
                maxLength={70}
                autoComplete="off"
                onChange={(event) => setLabel(event.currentTarget.value)}
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="accent-primary"
                checked={toolCalling}
                onChange={(event) => setToolCalling(event.currentTarget.checked)}
              />
              Model supports tool calling
            </label>
            {error && (
              <p className="text-sm text-error-foreground" role="alert">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !baseUrl.trim() || !modelId.trim()}>
              {saving ? "Adding…" : "Add model"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
