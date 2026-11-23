import { type PointerEvent as ReactPointerEvent, useState } from "react";

export interface ResizeBounds {
  readonly min: number;
  readonly max: number;
}

interface ResizeSession {
  width: number;
  edge: "left" | "right" | "top" | "bottom";
  /** Pointer widths are clamped to these before `resize` sees them. */
  bounds: ResizeBounds;
  resize: (width: number) => number;
  finish: (width: number, moved: boolean) => void;
  cleanup?: (committed: boolean) => void;
}

function clampToBounds(width: number, bounds: ResizeBounds): number {
  return Math.max(bounds.min, Math.min(bounds.max, width));
}

interface ActiveDrag<T extends HTMLElement> {
  session: ResizeSession;
  target: T;
  pointerId: number;
  start: number;
  pending: number;
  width: number;
  moved: boolean;
  frame: number | null;
  listeners: AbortController;
}

type ResizePointerEvent = Pick<
  PointerEvent,
  "pointerId" | "clientX" | "clientY" | "preventDefault"
>;

function createResizeDrag<T extends HTMLElement>() {
  let drag: ActiveDrag<T> | null = null;
  const isVertical = (edge: ResizeSession["edge"]) => edge === "top" || edge === "bottom";
  const position = (event: ResizePointerEvent, edge: ResizeSession["edge"]) =>
    isVertical(edge) ? event.clientY : event.clientX;

  const flush = () => {
    const active = drag;
    if (!active) return;
    const edge = active.session.edge;
    const delta = (active.pending - active.start) * (edge === "left" || edge === "top" ? -1 : 1);
    if (Math.abs(delta) > 2) active.moved = true;
    active.width = active.session.resize(
      clampToBounds(active.session.width + delta, active.session.bounds),
    );
  };

  const finish = (commit: boolean) => {
    const active = drag;
    if (!active) return;
    if (active.frame !== null) cancelAnimationFrame(active.frame);
    active.listeners.abort();
    if (commit) flush();
    // Release can synchronously dispatch lostpointercapture.
    drag = null;
    try {
      if (active.target.hasPointerCapture(active.pointerId)) {
        active.target.releasePointerCapture(active.pointerId);
      }
    } catch {}
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
    active.session.cleanup?.(commit);
    if (commit) active.session.finish(active.width, active.moved);
  };

  const end = (event: ResizePointerEvent, usePosition: boolean) => {
    const active = drag;
    if (!active || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    if (usePosition) active.pending = position(event, active.session.edge);
    finish(true);
  };

  const move = (event: ResizePointerEvent) => {
    const active = drag;
    if (!active || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    active.pending = position(event, active.session.edge);
    if (Math.abs(active.pending - active.start) > 2) active.moved = true;
    if (active.frame !== null) return;
    active.frame = requestAnimationFrame(() => {
      active.frame = null;
      flush();
    });
  };

  // A native drag may never activate pointer capture, so movement and release can
  // land outside the handle. Keep the existing handle events for captured pointers.
  const outsideHandle = (handler: (event: PointerEvent) => void) => (event: PointerEvent) => {
    if (drag && !event.composedPath().includes(drag.target)) handler(event);
  };
  const moveOutside = outsideHandle(move);
  const releaseOutside = outsideHandle((event) => end(event, true));
  const cancelOutside = outsideHandle((event) => end(event, false));
  const abandonPreviousGrab = (event: PointerEvent) => {
    if (drag?.pointerId === event.pointerId) finish(false);
  };

  return {
    ref: (node: T | null) => (node === null ? undefined : () => finish(false)),
    cancel: () => finish(false),
    refresh(bounds?: ResizeBounds) {
      if (!drag) return;
      if (bounds) drag.session.bounds = bounds;
      flush();
    },
    begin(
      event: ReactPointerEvent<T>,
      start: (event: ReactPointerEvent<T>) => ResizeSession | null,
    ) {
      if (event.button !== 0 || drag) return;
      const session = start(event);
      if (!session) return;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Window listeners cover drags when capture is unavailable.
      }
      event.preventDefault();
      event.stopPropagation();
      const listeners = new AbortController();
      const startPosition = position(event, session.edge);
      drag = {
        session,
        target: event.currentTarget,
        pointerId: event.pointerId,
        start: startPosition,
        pending: startPosition,
        width: session.width,
        moved: false,
        frame: null,
        listeners,
      };
      const { signal } = listeners;
      // A new press from the same pointer starts a new gesture.
      window.addEventListener("pointerdown", abandonPreviousGrab, { capture: true, signal });
      window.addEventListener("pointermove", moveOutside, { capture: true, signal });
      window.addEventListener("pointerup", releaseOutside, { capture: true, signal });
      window.addEventListener("pointercancel", cancelOutside, { capture: true, signal });
      // Leaving the window mid-drag commits where the pointer was.
      window.addEventListener("blur", () => finish(true), { signal });
      document.body.style.cursor = isVertical(session.edge) ? "row-resize" : "col-resize";
      document.body.style.userSelect = "none";
    },
    onPointerMove: move,
    onPointerUp: (event: ResizePointerEvent) => end(event, true),
    onPointerCancel: (event: ResizePointerEvent) => end(event, false),
    onLostPointerCapture: (event: ResizePointerEvent) => end(event, false),
  };
}

/**
 * A pointer drag that resizes along one edge. The session `start` returns owns
 * everything the drag needs, so options read at pointer-down hold for the whole
 * drag. Attach `ref` to the handle so unmounting it abandons the drag.
 */
export function useResizeDrag<T extends HTMLElement>(
  start: (event: ReactPointerEvent<T>) => ResizeSession | null,
) {
  // Created once: `ref` must keep its identity, or a re-render mid-drag would run its cleanup.
  const [drag] = useState(createResizeDrag<T>);
  const { begin, ...rest } = drag;
  return { ...rest, onPointerDown: (event: ReactPointerEvent<T>) => begin(event, start) };
}
