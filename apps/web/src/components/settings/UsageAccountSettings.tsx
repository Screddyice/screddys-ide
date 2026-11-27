import type { EnvironmentId, UnifiedSettings, UsageAccountConfig } from "@t3tools/contracts";
import { formatCount, formatTokens } from "@t3tools/shared/usageFormat";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { ensureLocalApi } from "../../localApi";
import { useUsage } from "../../state/usage";
import { currentUsageRange } from "../desktop/desktopUsageSnapshot";
import {
  usageAccountProviderInfo,
  usageAccountStatus,
  type UsageAccountStatus,
} from "../usage/usageAccounts";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { AddUsageAccountDialog } from "./AddUsageAccountDialog";
import { searchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

function statusText(status: UsageAccountStatus): string {
  switch (status.kind) {
    case "off":
      return "Off: not counted";
    case "pending":
      return "Checking…";
    case "missing":
      return `No ${status.folder} folder found in this home`;
    case "counting":
      return `${formatTokens(status.totalTokens)} tokens · ${formatCount(status.sessions)} ${
        status.sessions === 1 ? "session" : "sessions"
      } in 30 days`;
  }
}

export function UsageAccountSettings({
  environmentId,
  environmentLabel,
  accounts,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly accounts: UnifiedSettings["usageAccounts"];
  readonly readOnly: boolean;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [adding, setAdding] = useState(false);
  // The menu bar's 30-day window, so both read one usage fetch.
  const [range] = useState(currentUsageRange);
  const usage = useUsage(range.month);
  const summary =
    usage.environments.find((environment) => environment.environmentId === environmentId)
      ?.summary ?? null;
  const entries = Object.entries(accounts);
  const save = (id: string, account: UsageAccountConfig) =>
    updateSettings({ usageAccounts: { [id]: account } });
  const remove = async (id: string, account: UsageAccountConfig) => {
    const confirmed = await ensureLocalApi()
      .dialogs.confirm(
        `Remove ${account.label}?\nIts usage stops counting toward the totals. The folder and its transcripts are left as they are.`,
        { variant: "destructive" },
      )
      .catch(() => false);
    if (confirmed) updateSettings({ usageAccounts: { [id]: null } });
  };

  return (
    <>
      <SettingsSection
        {...searchableSetting("usage-accounts")}
        headerAction={
          !readOnly ? (
            <Button size="xs" variant="outline" onClick={() => setAdding(true)}>
              <PlusIcon className="size-3" aria-hidden />
              Add account
            </Button>
          ) : null
        }
      >
        {entries.length === 0 ? (
          <SettingsRow
            title="No extra accounts."
            description="~/.claude, every ~/.claude-* folder and each provider's own home are already counted. Add an account kept anywhere else."
          />
        ) : (
          entries.map(([id, account]) => (
            <SettingsRow
              key={id}
              title={account.label}
              description={
                <span className="break-all">
                  {usageAccountProviderInfo(account.provider).label} · {account.homePath}
                  <br />
                  {statusText(usageAccountStatus(account, summary))}
                </span>
              }
              control={
                !readOnly ? (
                  <span className="flex items-center gap-2">
                    <Switch
                      aria-label={`Count ${account.label}`}
                      checked={account.enabled}
                      onCheckedChange={(checked) =>
                        save(id, { ...account, enabled: Boolean(checked) })
                      }
                    />
                    <Button size="xs" variant="ghost" onClick={() => void remove(id, account)}>
                      Remove
                    </Button>
                  </span>
                ) : null
              }
            />
          ))
        )}
      </SettingsSection>
      {adding && !readOnly ? (
        <AddUsageAccountDialog
          open
          onOpenChange={setAdding}
          environmentId={environmentId}
          environmentLabel={environmentLabel}
          accounts={accounts}
        />
      ) : null}
    </>
  );
}
