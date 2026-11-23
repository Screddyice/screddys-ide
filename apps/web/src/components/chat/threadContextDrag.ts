import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { type RefObject, useEffect, useEffectEvent, useSyncExternalStore } from "react";

export const THREAD_CONTEXT_DROP_EVENT = "t3-thread-context-drop";

export function useThreadContextDrop(
  targetRef: RefObject<EventTarget | null>,
  environmentId: EnvironmentId | null,
  targetKey: string,
  onDrop: (refs: ReadonlyArray<ScopedThreadRef>, isActive: () => boolean) => void,
) {
  const handleDrop = useEffectEvent(onDrop);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes the target element to thread-context drop events and marks old drops inactive
  useEffect(() => {
    const target = targetRef.current;
    if (!target) return;
    let active = true;
    const listener = (event: Event) =>
      handleDrop((event as CustomEvent<ReadonlyArray<ScopedThreadRef>>).detail, () => active);
    target.addEventListener(THREAD_CONTEXT_DROP_EVENT, listener);
    return () => {
      active = false;
      target.removeEventListener(THREAD_CONTEXT_DROP_EVENT, listener);
    };
  }, [
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A new environment or target ends the previous listener, so isActive reports false to drops still in flight for it.
    environmentId,
    targetKey,
    targetRef,
  ]);
}

const DROP_TARGET_ATTRIBUTE = "data-thread-context-drop";
const DROP_OVER_ATTRIBUTE = "data-thread-context-over";
const SNAP_AREA_ATTRIBUTE = "data-thread-context-snap";
const SNAP_EDGE_ATTRIBUTE = "data-thread-context-snap-edge";

export type ThreadContextSnapEdge = "left" | "right";

export interface ThreadContextDragGhost {
  readonly x: number;
  readonly y: number;
  readonly title: string;
  readonly count: number;
  readonly exiting?: true;
}

let ghost: ThreadContextDragGhost | null = null;
let ghostExitTimer: number | undefined;
const listeners = new Set<() => void>();

function setGhost(next: ThreadContextDragGhost | null) {
  if (ghost === next) return;
  ghost = next;
  for (const listener of listeners) listener();
}

export function useThreadContextDragGhost(): ThreadContextDragGhost | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => ghost,
    () => null,
  );
}

let overTarget: HTMLElement | null = null;

function findDropTarget(
  point: { x: number; y: number },
  threads: ReadonlyArray<ScopedThreadRef>,
): HTMLElement | null {
  const hit = document.elementFromPoint(point.x, point.y);
  if (!hit) return null;
  const snapArea = hit.closest<HTMLElement>(`[${SNAP_AREA_ATTRIBUTE}]`);
  if (snapArea) {
    const bounds = snapArea.getBoundingClientRect();
    const reach = Math.min(80, bounds.width * 0.16);
    const edge =
      point.x - bounds.left < reach ? "left" : bounds.right - point.x < reach ? "right" : null;
    const primaryKey = snapArea.getAttribute(SNAP_AREA_ATTRIBUTE);
    if (edge && threads.some((thread) => scopedThreadKey(thread) !== primaryKey)) {
      const target = snapArea.querySelector<HTMLElement>(
        `:scope > [${SNAP_EDGE_ATTRIBUTE}="${edge}"]`,
      );
      if (target) return target;
    }
  }
  return hit.closest<HTMLElement>(`[${DROP_TARGET_ATTRIBUTE}]`);
}

export function moveThreadContextDrag(
  point: { x: number; y: number },
  label: { title: string; count: number },
  threads: ReadonlyArray<ScopedThreadRef>,
) {
  showThreadDrag(point, label, findDropTarget(point, threads));
}

export function showThreadDrag(
  point: { x: number; y: number },
  label: { title: string; count: number },
  target: HTMLElement | null,
) {
  if (ghostExitTimer !== undefined) {
    window.clearTimeout(ghostExitTimer);
    ghostExitTimer = undefined;
  }
  if (target !== overTarget) {
    overTarget?.removeAttribute(DROP_OVER_ATTRIBUTE);
    target?.setAttribute(DROP_OVER_ATTRIBUTE, "true");
    overTarget = target;
  }
  setGhost({ x: point.x, y: point.y, ...label });
}

export function endThreadContextDrag() {
  overTarget?.removeAttribute(DROP_OVER_ATTRIBUTE);
  overTarget = null;
  if (!ghost || ghost.exiting) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    setGhost(null);
    return;
  }
  setGhost({ ...ghost, exiting: true });
  ghostExitTimer = window.setTimeout(() => {
    ghostExitTimer = undefined;
    setGhost(null);
  }, 150);
}

export function dropThreadContext(
  point: { x: number; y: number },
  threads: ReadonlyArray<ScopedThreadRef>,
): boolean {
  const target = findDropTarget(point, threads);
  if (!target || threads.length === 0) return false;
  target.dispatchEvent(new CustomEvent(THREAD_CONTEXT_DROP_EVENT, { detail: threads }));
  return true;
}

export function threadContextDropTargetProps() {
  return { [DROP_TARGET_ATTRIBUTE]: "true" } as const;
}

export function threadContextSnapAreaProps(primaryKey: string) {
  return { [SNAP_AREA_ATTRIBUTE]: primaryKey } as const;
}

export function threadContextSnapTargetProps(edge: ThreadContextSnapEdge) {
  return { [SNAP_EDGE_ATTRIBUTE]: edge } as const;
}
