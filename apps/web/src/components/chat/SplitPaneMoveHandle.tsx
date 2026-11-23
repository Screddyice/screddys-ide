import { GripVerticalIcon } from "lucide-react";
import { createContext, useEffect, useRef, useState, type PointerEvent } from "react";

import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { endThreadContextDrag, showThreadDrag } from "./threadContextDrag";

type Point = { x: number; y: number };

export interface SplitPaneMove {
  readonly number: number;
  readonly destinations: readonly { id: string; number: number; empty: boolean }[];
  readonly findTarget: (point: Point) => { id: string; preview: HTMLElement } | null;
  readonly moveTo: (id: string) => void;
}

export const PrimarySplitPaneMoveContext = createContext<SplitPaneMove | null>(null);

interface PointerDrag {
  readonly pointerId: number;
  readonly start: Point;
  readonly cleanup: () => void;
  dragging: boolean;
}

function pointOf(event: PointerEvent): Point {
  return { x: event.clientX, y: event.clientY };
}

export function SplitPaneMoveHandle({ move, title }: { move: SplitPaneMove; title: string }) {
  const [open, setOpen] = useState(false);
  const activeDrag = useRef<PointerDrag | null>(null);
  const suppressClick = useRef(false);

  const finishDrag = () => {
    const drag = activeDrag.current;
    if (!drag) return;
    activeDrag.current = null;
    drag.cleanup();
    if (drag.dragging) endThreadContextDrag();
  };

  const releaseDrag = (event: PointerEvent) => {
    const drag = activeDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const target = drag.dragging ? move.findTarget(pointOf(event)) : null;
    finishDrag();
    if (target) move.moveTo(target.id);
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the global drag preview and pointer listeners if the handle unmounts mid-gesture
  useEffect(
    () => () => {
      const drag = activeDrag.current;
      drag?.cleanup();
      if (drag?.dragging) endThreadContextDrag();
    },
    [],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<Button size="icon-sm" variant="ghost" />}
        aria-label={`Move pane ${move.number}`}
        title="Drag to move pane"
        className="shrink-0 touch-none cursor-grab active:cursor-grabbing [-webkit-app-region:no-drag]"
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0 || activeDrag.current) return;
          const handle = event.currentTarget;
          const { pointerId } = event;
          const listeners = new AbortController();
          suppressClick.current = false;
          handle.setPointerCapture(pointerId);
          activeDrag.current = {
            pointerId,
            start: pointOf(event),
            dragging: false,
            cleanup: () => {
              listeners.abort();
              if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
            },
          };
          const options = { signal: listeners.signal };
          window.addEventListener("blur", finishDrag, options);
          window.addEventListener("resize", finishDrag, options);
          document.addEventListener(
            "keydown",
            (key) => {
              if (key.key === "Escape") finishDrag();
            },
            options,
          );
        }}
        onPointerMove={(event) => {
          const drag = activeDrag.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          if ((event.buttons & 1) === 0) {
            releaseDrag(event);
            return;
          }
          const point = pointOf(event);
          if (!drag.dragging) {
            if (Math.hypot(point.x - drag.start.x, point.y - drag.start.y) < 6) return;
            drag.dragging = true;
            suppressClick.current = true;
            setOpen(false);
          }
          showThreadDrag(point, { title, count: 1 }, move.findTarget(point)?.preview ?? null);
        }}
        onPointerUp={releaseDrag}
        onPointerCancel={finishDrag}
        onLostPointerCapture={finishDrag}
        onClickCapture={(event) => {
          if (event.detail > 0 && suppressClick.current) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
      >
        <GripVerticalIcon aria-hidden="true" />
      </PopoverTrigger>
      <PopoverPopup align="start" padding="none" aria-label={`Move pane ${move.number}`}>
        <div className="flex flex-col items-stretch p-1">
          {move.destinations.map((target) => (
            <Button
              key={target.id}
              size="sm"
              variant="ghost"
              onClick={() => {
                setOpen(false);
                move.moveTo(target.id);
              }}
            >
              {target.empty ? "Move to" : "Swap with"} pane {target.number}
            </Button>
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
