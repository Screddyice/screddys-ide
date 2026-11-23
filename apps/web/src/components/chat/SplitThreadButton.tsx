import { Columns2Icon, Grid2X2Icon, PanelTopIcon, PanelsTopLeftIcon } from "lucide-react";
import { createContext, use } from "react";

import { Button } from "../ui/button";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuTrigger,
} from "../ui/menu";

const layouts = [
  { count: 1, label: "Single pane", icon: PanelTopIcon },
  { count: 2, label: "2 panes", icon: Columns2Icon },
  { count: 3, label: "3 panes", icon: PanelsTopLeftIcon },
  { count: 4, label: "4 panes", icon: Grid2X2Icon },
] as const;

export type SplitPaneCount = (typeof layouts)[number]["count"];

interface LayoutControl {
  readonly paneCount: SplitPaneCount;
  readonly setPaneCount: (count: SplitPaneCount) => void;
}

export const SplitContext = createContext<LayoutControl | null>(null);

export function SplitThreadButton({ layout }: { readonly layout?: LayoutControl } = {}) {
  const workspace = use(SplitContext);
  const split = layout ?? workspace;
  if (!split) return null;
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button size="sm" variant="outline" className="shrink-0 [-webkit-app-region:no-drag]" />
        }
      >
        <Columns2Icon aria-hidden="true" /> Split screen
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuRadioGroup
          value={String(split.paneCount)}
          onValueChange={(value) => {
            const selected = layouts.find(({ count }) => String(count) === value);
            if (selected) split.setPaneCount(selected.count);
          }}
        >
          {layouts.map(({ count, label, icon: Icon }) => (
            <MenuRadioItem key={count} value={String(count)} closeOnClick>
              <span className="flex items-center gap-2">
                <Icon aria-hidden="true" />
                <span className="flex-1">{label}</span>
                <MenuRadioItemIndicator />
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}
