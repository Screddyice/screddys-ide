import { ChevronDownIcon } from "lucide-react";
import type { Ref } from "react";

import { Button } from "../ui/button";

export const splitPaneHeaderClass = "flex shrink-0 items-center gap-2 border-b border-border p-2";

interface SplitPaneThreadSelectorProps {
  readonly paneNumber: number;
  readonly title: string | null;
  readonly pickerId: string;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly ref?: Ref<HTMLButtonElement>;
}

export function SplitPaneThreadSelector({
  paneNumber,
  title,
  pickerId,
  open,
  onToggle,
  ref,
}: SplitPaneThreadSelectorProps) {
  return (
    <Button
      ref={ref}
      aria-label={`Choose a thread for pane ${paneNumber}`}
      aria-expanded={open}
      aria-controls={open ? pickerId : undefined}
      title={title ?? undefined}
      variant="outline"
      size="sm"
      className="min-w-0 flex-1 justify-between"
      onClick={onToggle}
    >
      <span className="min-w-0 truncate" dir="auto">
        {title ?? "Choose a thread"}
      </span>
      <ChevronDownIcon aria-hidden="true" className="size-3.5" />
    </Button>
  );
}
