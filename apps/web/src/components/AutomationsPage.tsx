import type { EnvironmentId, ScheduledTaskId } from "@t3tools/contracts";

import { isElectron } from "../env";
import { workspaceAreaProps } from "../lib/workspaceFocus";
import { ScheduledTasksSettings } from "./settings/ScheduledTasksSettings";
import { SettingsScopeProvider } from "./settings/SettingsScopeContext";
import type { SettingsScopeSearch } from "./settings/settingsScope";
import { SidebarInset } from "./ui/sidebar";
import { WorkspacePageHeader } from "./WorkspacePageHeader";

export function AutomationsPage({
  scope,
  task,
  onScopeChange,
}: {
  readonly scope: SettingsScopeSearch;
  readonly task: { readonly environmentId?: EnvironmentId; readonly taskId?: ScheduledTaskId };
  readonly onScopeChange: (next: SettingsScopeSearch) => void;
}) {
  return (
    <SidebarInset
      {...workspaceAreaProps("automations", 1, "Automations")}
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none"
    >
      <WorkspacePageHeader electron={isElectron} />
      <SettingsScopeProvider search={scope} onChange={onScopeChange}>
        <ScheduledTasksSettings {...task} />
      </SettingsScopeProvider>
    </SidebarInset>
  );
}
