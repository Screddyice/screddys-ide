import { createFileRoute, redirect } from "@tanstack/react-router";

import { SplitThreadWorkspace } from "../components/chat/SplitThreadWorkspace";
import { SidebarInset } from "../components/ui/sidebar";
import { isElectron } from "../env";

function SplitRoute() {
  const { panes } = Route.useSearch();
  return (
    <SidebarInset aria-label="Split workspace" className="h-dvh min-h-0 overflow-hidden">
      <SplitThreadWorkspace
        standalone
        initialPaneCount={panes}
        persistenceRoute={{ kind: "split" }}
      />
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/split")({
  validateSearch: (search: Record<string, unknown>): { panes: 2 | 3 | 4 } => ({
    panes: search.panes === 3 || search.panes === 4 ? search.panes : 2,
  }),
  beforeLoad: () => {
    if (!isElectron) throw redirect({ to: "/", replace: true });
  },
  component: SplitRoute,
});
