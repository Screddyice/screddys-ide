import type { EnvironmentId, UnifiedSettings, UsageAccountProvider } from "@t3tools/contracts";
import { useState } from "react";

import { isElectron } from "../../env";
import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { ensureLocalApi } from "../../localApi";
import {
  USAGE_ACCOUNT_PROVIDERS,
  defaultUsageAccountLabel,
  guessUsageAccountProvider,
  newUsageAccountId,
  usageAccountProblem,
  usageAccountProviderInfo,
} from "../usage/usageAccounts";
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
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

/** Adds a home folder whose transcripts count toward the token totals on this environment. */
export function AddUsageAccountDialog({
  open,
  onOpenChange,
  environmentId,
  environmentLabel,
  accounts,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly accounts: UnifiedSettings["usageAccounts"];
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [provider, setProvider] = useState<UsageAccountProvider | null>(null);
  const [homePath, setHomePath] = useState("");
  const [label, setLabel] = useState("");
  const chosenProvider = provider ?? guessUsageAccountProvider(homePath);
  const info = usageAccountProviderInfo(chosenProvider);
  const effectiveLabel = label.trim() || defaultUsageAccountLabel(homePath);
  const problem = usageAccountProblem(
    { provider: chosenProvider, label: effectiveLabel, homePath },
    accounts,
  );

  const close = () => {
    setProvider(null);
    setHomePath("");
    setLabel("");
    onOpenChange(false);
  };

  const save = () => {
    if (problem !== null) return;
    updateSettings({
      usageAccounts: {
        [newUsageAccountId(effectiveLabel, accounts)]: {
          provider: chosenProvider,
          label: effectiveLabel,
          homePath: homePath.trim(),
          enabled: true,
        },
      },
    });
    close();
  };

  const browse = async () => {
    const picked = await ensureLocalApi()
      .dialogs.pickFolder(homePath.trim() ? { initialPath: homePath.trim() } : undefined)
      .catch(() => null);
    if (picked) setHomePath(picked);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add a usage account</DialogTitle>
          <DialogDescription>
            Count another account's token usage in the menu bar and on the Usage page, from a home
            folder on {environmentLabel}.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="usage-account-home">Home folder</Label>
              <div className="flex gap-2">
                <Input
                  id="usage-account-home"
                  placeholder={info.example}
                  value={homePath}
                  onChange={(event) => setHomePath(event.target.value)}
                  autoFocus
                />
                {isElectron ? (
                  <Button type="button" variant="outline" onClick={() => void browse()}>
                    Choose…
                  </Button>
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground">
                The folder you point {info.label} at, such as a CLAUDE_CONFIG_DIR. Screddy reads its{" "}
                <code>{info.folder}</code> folder.
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="usage-account-provider">App</Label>
              <Select
                value={chosenProvider}
                onValueChange={(next) => {
                  const match = USAGE_ACCOUNT_PROVIDERS.find((entry) => entry.value === next);
                  if (match) setProvider(match.value);
                }}
              >
                <SelectTrigger id="usage-account-provider" aria-label="App">
                  <SelectValue>{info.label}</SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {USAGE_ACCOUNT_PROVIDERS.map((entry) => (
                    <SelectItem key={entry.value} value={entry.value}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="usage-account-label">Name</Label>
              <Input
                id="usage-account-label"
                placeholder={defaultUsageAccountLabel(homePath) || "Work"}
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </div>
            {homePath.trim() !== "" && problem !== null ? (
              <p role="alert" className="text-xs text-destructive">
                {problem}
              </p>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button onClick={save} disabled={problem !== null}>
            Add account
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
