import { MessagesSquareIcon } from "lucide-react";
import { createPortal } from "react-dom";

import { useThreadContextDragGhost } from "./threadContextDrag";

export function ThreadContextDragGhost() {
  const ghost = useThreadContextDragGhost();
  if (ghost === null) return null;
  return createPortal(
    <div
      aria-hidden="true"
      data-thread-context-drag-ghost={ghost.exiting ? "exiting" : "dragging"}
      className="pointer-events-none fixed left-0 top-0 z-[100]"
      style={{
        transform: `translate3d(min(${ghost.x + 12}px, calc(100dvw - 100% - 8px)), min(${ghost.y + 12}px, calc(100dvh - 100% - 8px)), 0)`,
      }}
    >
      <div className="thread-context-drag-card flex max-w-72 items-center gap-2 rounded-lg border bg-popover px-3 py-2 text-sm shadow-lg">
        <MessagesSquareIcon className="size-4 shrink-0 text-secondary-label" />
        <span className="truncate">{ghost.title}</span>
        {ghost.count > 1 ? (
          <span className="shrink-0 rounded-full bg-muted px-1.5 text-xs text-secondary-label">
            +{ghost.count - 1}
          </span>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
