import { createFileRoute } from "@tanstack/react-router";

import { AutomationsPage } from "../components/AutomationsPage";
import { validateScheduledTasksSearch } from "../components/settings/scheduledTasksSettings.logic";
import { validateSettingsScopeSearch } from "../components/settings/settingsScope";

function AutomationsRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <AutomationsPage
      scope={search}
      task={search}
      onScopeChange={(next) => {
        void navigate({
          search: () => ({ project: next.project, machine: next.machine, checkout: next.checkout }),
          resetScroll: false,
        });
      }}
    />
  );
}

export const Route = createFileRoute("/_chat/automations")({
  validateSearch: (raw: Record<string, unknown>) => ({
    ...validateSettingsScopeSearch(raw),
    ...validateScheduledTasksSearch(raw),
  }),
  component: AutomationsRoute,
});
