import type { MissionControlJevStatus } from "@t3tools/contracts";
import { useEffect, useId, useState } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { SecretInput } from "./SecretInput";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function JevSetupDialog({
  configured = false,
  onClose,
  onComplete,
  onSkip,
}: {
  readonly configured?: boolean;
  readonly onClose: () => void;
  readonly onComplete: (enabled: boolean) => void;
  readonly onSkip?: () => void;
}) {
  const keyId = useId();
  const formId = keyId + "-form";
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(value: string | null) {
    const setJevKey = window.desktopBridge?.setMissionControlJevKey;
    if (!setJevKey || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await setJevKey(value);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setKey("");
      onComplete(value !== null);
    } catch {
      setError("Could not finish JEV setup. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{configured ? "OpenRouter for JEV" : "Set up JEV"}</DialogTitle>
          <DialogDescription>
            JEV helps Mission Control route and prioritize tasks. Requests use your OpenRouter
            balance.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            className="space-y-2.5"
            onSubmit={(event) => {
              event.preventDefault();
              if (key.trim()) void save(key);
            }}
          >
            <label className="block text-sm font-medium" htmlFor={keyId}>
              OpenRouter API key
            </label>
            <SecretInput
              id={keyId}
              configured={configured}
              value={key}
              onChange={(event) => setKey(event.target.value)}
              disabled={busy}
              maxLength={256}
              placeholder="Paste your OpenRouter API key"
            />
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
              <a
                className="underline underline-offset-2"
                href="https://openrouter.ai/keys"
                target="_blank"
                rel="noreferrer noopener"
              >
                Get an OpenRouter key
              </a>
              <span className="text-muted-foreground">Stored securely on this Mac.</span>
            </div>
            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter>
          {onSkip ? (
            <Button type="button" variant="ghost-muted" disabled={busy} onClick={onSkip}>
              Skip
            </Button>
          ) : null}
          {configured ? (
            <Button
              type="button"
              variant="ghost-muted"
              disabled={busy}
              onClick={() => void save(null)}
            >
              Remove key
            </Button>
          ) : null}
          <Button type="submit" form={formId} disabled={busy || !key.trim()}>
            {busy ? "Working…" : configured ? "Replace key" : "Enable JEV"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function JevSettings() {
  const getStatus = window.desktopBridge?.getMissionControlJevStatus;
  const [status, setStatus] = useState<MissionControlJevStatus>("unsupported");
  const [open, setOpen] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads this device's JEV status from native secure storage
  useEffect(() => {
    if (!getStatus) return;
    let active = true;
    void getStatus()
      .then((next) => {
        if (active) setStatus(next);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [getStatus]);

  if (status === "unsupported" || !window.desktopBridge?.setMissionControlJevKey) return null;
  const configured = status === "enabled";
  return (
    <SettingsSection id="mission-control-jev" title="Mission Control">
      <SettingsRow
        title="JEV via OpenRouter"
        description={
          configured
            ? "Connected on this Mac."
            : "Optional task routing and prioritization through your OpenRouter account."
        }
        control={
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            {configured ? "Manage key" : "Set up JEV"}
          </Button>
        }
      />
      {open ? (
        <JevSetupDialog
          configured={configured}
          onClose={() => setOpen(false)}
          onComplete={(enabled) => {
            setStatus(enabled ? "enabled" : "disabled");
            setOpen(false);
          }}
        />
      ) : null}
    </SettingsSection>
  );
}
