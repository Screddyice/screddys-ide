import type { CSSProperties } from "react";

import { useResizeDrag } from "../../hooks/useResizeDrag";
import { cn } from "../../lib/utils";

export function SplitPaneResizeHandle({
  axis,
  index,
  trackProperty,
  className,
  style,
}: {
  readonly axis: "columns" | "rows";
  readonly index: number;
  readonly trackProperty: `--split-${string}`;
  readonly className?: string;
  readonly style: CSSProperties;
}) {
  const columns = axis === "columns";
  const label = columns ? "Resize pane widths" : `Resize pane rows ${index + 1} and ${index + 2}`;

  function start(handle: HTMLDivElement) {
    const grid = handle.parentElement;
    if (!grid) return null;
    const computed = getComputedStyle(grid);
    const tracks = (columns ? computed.gridTemplateColumns : computed.gridTemplateRows)
      .split(" ")
      .map((track) => Number.parseFloat(track));
    const first = tracks[index];
    const second = tracks[index + 1];
    if (
      first === undefined ||
      second === undefined ||
      tracks.some((track) => !Number.isFinite(track))
    ) {
      return null;
    }
    const total = first + second;
    if (total <= 0) return null;
    const min = Math.min(columns ? 216 : 160, total / 3, first, second);
    const bounds = { min, max: total - min };
    const previous = grid.style.getPropertyValue(trackProperty);
    return {
      first,
      bounds,
      resize(size: number) {
        tracks[index] = size;
        tracks[index + 1] = total - size;
        grid.style.setProperty(
          trackProperty,
          tracks.map((track) => `minmax(0,${track}fr)`).join(" "),
        );
        return size;
      },
      restore() {
        if (previous) grid.style.setProperty(trackProperty, previous);
        else grid.style.removeProperty(trackProperty);
      },
    };
  }

  const drag = useResizeDrag<HTMLDivElement>((event) => {
    if (!event.isPrimary) return null;
    const split = start(event.currentTarget);
    if (!split) return null;
    return {
      width: split.first,
      edge: columns ? "right" : "bottom",
      bounds: split.bounds,
      resize: split.resize,
      finish: (_size, moved) => {
        if (!moved) split.restore();
      },
      cleanup: (committed) => {
        if (!committed) split.restore();
      },
    };
  });
  const { cancel: _cancel, refresh: _refresh, ...pointerHandlers } = drag;

  return (
    <div
      {...pointerHandlers}
      role="separator"
      aria-label={label}
      aria-orientation={columns ? "vertical" : "horizontal"}
      tabIndex={0}
      className={cn(
        "absolute z-20 touch-none outline-none before:absolute before:bg-transparent hover:before:bg-primary focus-visible:before:bg-primary active:before:bg-primary",
        columns
          ? "inset-y-0 -right-1 w-2 cursor-col-resize before:inset-y-0 before:left-1/2 before:w-0.5"
          : "inset-x-0 -bottom-1 h-2 cursor-row-resize before:inset-x-0 before:top-1/2 before:h-0.5",
        className,
      )}
      style={style}
      onKeyDown={(event) => {
        const direction =
          event.key === (columns ? "ArrowLeft" : "ArrowUp")
            ? -1
            : event.key === (columns ? "ArrowRight" : "ArrowDown")
              ? 1
              : 0;
        if (direction === 0) return;
        const split = start(event.currentTarget);
        if (!split) return;
        event.preventDefault();
        split.resize(
          Math.max(split.bounds.min, Math.min(split.bounds.max, split.first + direction * 24)),
        );
      }}
    />
  );
}
