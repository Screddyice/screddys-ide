import { cn, newMessageId } from "~/lib/utils";
import {
  parseScopedThreadKey,
  scopedProjectKey,
  scopeProjectRef,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { sortThreads } from "@t3tools/client-runtime/state/thread-sort";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import {
  ArrowUpRightIcon,
  ChevronDownIcon,
  MessageSquareIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { Link } from "@tanstack/react-router";

import { ComposerHandleContext } from "../../composerHandleContext";
import { type DraftId, useComposerDraftStore } from "../../composerDraftStore";
import {
  type DesktopSplitPane,
  type DesktopSplitWorkspaceRoute,
  readDesktopSplitWorkspace,
  sameDesktopSplitWorkspaceRoute,
  saveDesktopSplitWorkspace,
} from "../../desktopSplitWorkspace";
import { isElectron } from "../../env";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import {
  readThreadShell,
  useAnyEnvironmentHiding,
  useProjects,
  useHiddenThreadKeys,
  useQuietThreadShell,
  useVisibleThreadShells,
} from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentsWithScope } from "../../state/session";
import { useEnvironmentShellStatus } from "../../state/shell";
import { useEnvironmentThread, useOpenThreadFamily } from "../../state/threads";
import ChatView from "../ChatView";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  PrimarySplitPaneMoveContext,
  SplitPaneMoveHandle,
  type SplitPaneMove,
} from "./SplitPaneMoveHandle";
import { SplitPaneResizeHandle } from "./SplitPaneResizeHandle";
import { AppearanceToggleButton } from "./AppearanceToggleButton";
import { SplitContext, SplitThreadButton, type SplitPaneCount } from "./SplitThreadButton";
import {
  threadContextDropTargetProps,
  threadContextSnapAreaProps,
  threadContextSnapTargetProps,
  useThreadContextDrop,
  type ThreadContextSnapEdge,
} from "./threadContextDrag";

const gridClasses = {
  1: "grid-rows-[minmax(0,1fr)]",
  2: "@min-[36rem]/split-workspace:grid-rows-[minmax(0,1fr)]",
  3: "@min-[36rem]/split-workspace:min-h-[34rem] @min-[36rem]/split-workspace:grid-rows-[var(--split-rows,repeat(2,minmax(0,1fr)))]",
  4: "@min-[36rem]/split-workspace:min-h-[34rem] @min-[36rem]/split-workspace:grid-rows-[var(--split-rows,repeat(2,minmax(0,1fr)))]",
} satisfies Record<SplitPaneCount, string>;
const stackedRowBoundaries = [0, 1, 2];

function splitThreadKey(thread: EnvironmentThreadShell) {
  return scopedThreadKey({ environmentId: thread.environmentId, threadId: thread.id });
}

interface Pane {
  readonly id: string;
  readonly primary?: false;
  readonly selection: string;
  readonly draftId?: DraftId | undefined;
}

const primarySlot = { id: "primary", primary: true } as const;
type PaneSlot = Pane | typeof primarySlot;

type SplitLayoutElement = HTMLDivElement & {
  startViewTransition?: (update: () => void) => ViewTransition;
};

function createPane(): Pane {
  return { id: newMessageId(), selection: "" };
}

function restoreSlots(
  route: DesktopSplitWorkspaceRoute,
  currentThread: ScopedThreadRef | null,
): readonly PaneSlot[] | null {
  const saved = readDesktopSplitWorkspace();
  if (!saved || !sameDesktopSplitWorkspaceRoute(saved.route, route)) return null;
  const seen = new Set(currentThread ? [scopedThreadKey(currentThread)] : []);
  const drafts = useComposerDraftStore.getState();
  return saved.panes.map((entry) => {
    if (entry.kind === "primary") return primarySlot;
    const pane = createPane();
    if (entry.kind === "draft") {
      const draft = drafts.getDraftSession(entry.draftId);
      const promoted = drafts.getPromotedDraftRedirect(entry.draftId);
      const ref = promoted ?? draft?.promotedTo ?? draft;
      if (!ref) return pane;
      const key = scopedThreadKey(ref);
      if (seen.has(key)) return pane;
      seen.add(key);
      return promoted ? { ...pane, selection: key } : { ...pane, draftId: entry.draftId };
    }
    if (entry.kind === "thread") {
      const key = scopedThreadKey(entry.threadRef);
      if (seen.has(key)) return pane;
      seen.add(key);
      return { ...pane, selection: key };
    }
    return pane;
  });
}

export function SplitThreadWorkspace({
  children,
  currentThread = null,
  initialPaneCount = 1,
  standalone = false,
  persistenceRoute,
}: {
  readonly children?: ReactNode;
  readonly currentThread?: ScopedThreadRef | null;
  readonly initialPaneCount?: SplitPaneCount;
  readonly standalone?: boolean;
  readonly persistenceRoute?: DesktopSplitWorkspaceRoute;
}) {
  const primaryPaneCount = standalone ? 0 : 1;
  const [slots, setSlots] = useState<readonly PaneSlot[]>(
    () =>
      (persistenceRoute && restoreSlots(persistenceRoute, currentThread)) ?? [
        ...(standalone ? [] : [primarySlot]),
        ...Array.from({ length: initialPaneCount - primaryPaneCount }, createPane),
      ],
  );
  const panes = slots.filter((slot): slot is Pane => !slot.primary);
  const [openPickerId, setOpenPickerId] = useState<string | null>(null);
  const layoutRef = useRef<SplitLayoutElement>(null);
  const paneCount = slots.length as SplitPaneCount;
  const stackedTracks = `--split-stack-${paneCount}` as const;
  const primaryKey = currentThread ? scopedThreadKey(currentThread) : null;
  const snapEnabled = !standalone && paneCount === 1 && primaryKey !== null;
  const promotions = useComposerDraftStore((store) => store.promotedDraftRedirects);
  const drafts = useComposerDraftStore((store) => store.draftThreadsByThreadKey);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps desktop storage in sync with committed pane order and draft promotion before quit
  useLayoutEffect(() => {
    if (!persistenceRoute) return;
    if (slots.length < 2) {
      saveDesktopSplitWorkspace(null);
      return;
    }
    const savedPanes = slots.map((slot): DesktopSplitPane => {
      if (slot.primary) return { kind: "primary" };
      if (slot.draftId) {
        const promoted = promotions[slot.draftId];
        return promoted
          ? { kind: "thread", threadRef: promoted }
          : { kind: "draft", draftId: slot.draftId };
      }
      const ref = parseScopedThreadKey(slot.selection);
      return ref ? { kind: "thread", threadRef: ref } : { kind: "blank" };
    });
    saveDesktopSplitWorkspace({ route: persistenceRoute, panes: savedPanes });
  }, [persistenceRoute, promotions, slots]);
  const selectedThreadKey = (pane: Pane) => {
    const promoted = pane.draftId ? promotions[pane.draftId] : undefined;
    const draft = pane.draftId ? drafts[pane.draftId] : undefined;
    if (promoted) return scopedThreadKey(promoted);
    if (draft) return scopedThreadKey(draft.promotedTo ?? draft);
    return pane.selection;
  };
  const [previousPrimaryKey, setPreviousPrimaryKey] = useState(primaryKey);
  if (previousPrimaryKey !== primaryKey) {
    setPreviousPrimaryKey(primaryKey);
    if (panes.some((pane) => selectedThreadKey(pane) === primaryKey)) {
      setSlots(
        slots.map((slot) =>
          !slot.primary && selectedThreadKey(slot) === primaryKey
            ? { ...slot, selection: "", draftId: undefined }
            : slot,
        ),
      );
    }
  }
  const allThreads = useVisibleThreadShells(panes.length > 0);
  const threads = sortThreads(
    allThreads.filter(
      (thread) =>
        !thread.lineage.sideChat &&
        thread.deletedAt === null &&
        thread.archivedAt === null &&
        splitThreadKey(thread) !== primaryKey,
    ),
    "updated_at",
  );
  function transitionLayout(update: () => void) {
    const layout = layoutRef.current;
    if (
      !layout?.startViewTransition ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      update();
      return;
    }
    const transition = layout.startViewTransition(() => flushSync(update));
    void transition.finished.catch(() => undefined);
    void transition.ready.catch(() => undefined);
  }

  function setPaneCount(count: SplitPaneCount) {
    if (count === paneCount) {
      setOpenPickerId(null);
      return;
    }
    const nextLength = count - primaryPaneCount;
    const newPanes = Array.from({ length: nextLength }, createPane);
    transitionLayout(() => {
      setSlots((previous) => {
        const retained = previous.filter((slot) => !slot.primary).slice(0, nextLength);
        return [
          ...previous.filter((slot) => slot.primary || retained.includes(slot)),
          ...newPanes.slice(retained.length),
        ];
      });
      setOpenPickerId(null);
    });
  }

  function snapThread(edge: ThreadContextSnapEdge, refs: ReadonlyArray<ScopedThreadRef>) {
    if (!snapEnabled) return;
    const nextThread = refs.find((ref) => {
      if (scopedThreadKey(ref) === primaryKey) return false;
      const thread = readThreadShell(ref);
      return thread && !thread.lineage.sideChat && !thread.deletedAt && !thread.archivedAt;
    });
    if (!nextThread) return;
    const nextPane = { ...createPane(), selection: scopedThreadKey(nextThread) };
    transitionLayout(() =>
      setSlots((previous) =>
        previous.length !== 1
          ? previous
          : edge === "left"
            ? [nextPane, ...previous]
            : [...previous, nextPane],
      ),
    );
  }

  function moveInfo(id: string, index: number): SplitPaneMove | null {
    const destinations = slots.flatMap((slot, slotIndex) =>
      slot.id === id || (slot.primary && !primaryKey)
        ? []
        : [
            {
              id: slot.id,
              number: slotIndex + 1,
              empty: !slot.primary && !slot.selection && !slot.draftId,
            },
          ],
    );
    if (destinations.length === 0) return null;
    return {
      number: index + 1,
      destinations,
      findTarget: ({ x, y }) => {
        const pane = document
          .elementFromPoint(x, y)
          ?.closest<HTMLElement>("[data-split-move-target]");
        if (!pane || pane.parentElement !== layoutRef.current) return null;
        const targetId = pane.dataset.splitMoveTarget;
        const preview = pane.querySelector<HTMLElement>(":scope > [data-split-move-preview]");
        return preview &&
          destinations.some((destination) => destination.id === targetId) &&
          targetId
          ? { id: targetId, preview }
          : null;
      },
      moveTo: (targetId) => {
        if (!destinations.some((destination) => destination.id === targetId)) return;
        transitionLayout(() => {
          setSlots((previous) => {
            const source = previous.find((slot) => slot.id === id);
            const target = previous.find((slot) => slot.id === targetId);
            if (!source || !target) return previous;
            return previous.map((slot) =>
              slot === source ? target : slot === target ? source : slot,
            );
          });
          setOpenPickerId(null);
        });
      },
    };
  }

  const primaryPane = (index: number) => (
    <div
      key={primarySlot.id}
      data-split-layout-pane
      data-split-move-target={paneCount > 1 && primaryKey ? primarySlot.id : undefined}
      {...(snapEnabled ? threadContextSnapAreaProps(primaryKey) : {})}
      className={cn(
        "relative flex min-h-0 min-w-0 flex-col overflow-hidden bg-background",
        paneCount > 1 && "@container/chat-pane",
        paneCount === 3 && index === 0 && "@min-[36rem]/split-workspace:col-span-2",
      )}
    >
      <PrimarySplitPaneMoveContext value={primaryKey ? moveInfo(primarySlot.id, index) : null}>
        {children}
      </PrimarySplitPaneMoveContext>
      {paneCount > 1 && primaryKey && <SplitMovePreview />}
      {snapEnabled && (
        <>
          <SplitSnapPreview edge="left" onDrop={snapThread} />
          <SplitSnapPreview edge="right" onDrop={snapThread} />
        </>
      )}
    </div>
  );

  return (
    <SplitContext value={{ paneCount, setPaneCount }}>
      {standalone || paneCount > 1 ? (
        <WorkspacePageHeader
          electron={standalone || isElectron}
          className={standalone ? "justify-end" : undefined}
        >
          <div className="flex shrink-0 items-center gap-1">
            <SplitThreadButton />
            <AppearanceToggleButton />
          </div>
        </WorkspacePageHeader>
      ) : null}
      <div className="@container/split-workspace min-h-0 min-w-0 flex-1 overflow-auto">
        <div
          ref={layoutRef}
          data-split-layout-active={paneCount > 1 || undefined}
          className={cn(
            "split-thread-layout relative grid h-full grid-cols-[minmax(0,1fr)]",
            gridClasses[paneCount],
            paneCount > 1 &&
              "gap-px bg-border @max-[36rem]/split-workspace:min-h-(--split-stack-height) @max-[36rem]/split-workspace:grid-rows-(--split-stack-template) @min-[36rem]/split-workspace:grid-cols-[var(--split-columns,repeat(2,minmax(0,1fr)))]",
          )}
          style={
            {
              "--split-stack-height": `${paneCount * 17}rem`,
              "--split-stack-template": `var(${stackedTracks},repeat(${paneCount},minmax(0,1fr)))`,
            } as CSSProperties
          }
        >
          {slots.map((pane, index) =>
            pane.primary ? (
              primaryPane(index)
            ) : (
              <SplitPane
                key={pane.id}
                id={pane.id}
                index={index}
                fillsRow={paneCount === 3 && index === 0}
                move={moveInfo(pane.id, index)}
                threads={threads}
                pickerOpen={openPickerId === pane.id}
                onPickerOpenChange={(open) =>
                  setOpenPickerId((current) =>
                    open ? pane.id : current === pane.id ? null : current,
                  )
                }
                selection={selectedThreadKey(pane)}
                draftId={pane.draftId}
                setSelection={(value, onlyIfBlank) =>
                  setSlots((previous) => {
                    const target = previous.find((other) => other.id === pane.id);
                    if (
                      !target ||
                      target.primary ||
                      (onlyIfBlank && (selectedThreadKey(target) || target.draftId))
                    ) {
                      return previous;
                    }
                    if (
                      value &&
                      (value === primaryKey ||
                        previous.some(
                          (other) =>
                            !other.primary &&
                            other.id !== pane.id &&
                            selectedThreadKey(other) === value,
                        ))
                    ) {
                      return previous;
                    }
                    return previous.map((other) =>
                      !other.primary && other.id === pane.id
                        ? { ...other, selection: value, draftId: undefined }
                        : other,
                    );
                  })
                }
                setDraft={(draftId) =>
                  setSlots((previous) =>
                    previous.map((other) =>
                      !other.primary && other.id === pane.id
                        ? { ...other, selection: "", draftId }
                        : other,
                    ),
                  )
                }
                otherSelections={panes
                  .filter((other) => other.id !== pane.id)
                  .map(selectedThreadKey)}
                close={
                  paneCount > 1
                    ? () => {
                        transitionLayout(() => {
                          setSlots((previous) => previous.filter((other) => other.id !== pane.id));
                          setOpenPickerId((current) => (current === pane.id ? null : current));
                        });
                      }
                    : undefined
                }
                standalone={standalone}
              />
            ),
          )}
          {paneCount > 1 && (
            <SplitPaneResizeHandle
              axis="columns"
              index={0}
              trackProperty="--split-columns"
              className="hidden @min-[36rem]/split-workspace:block"
              style={{ gridColumn: "1 / 2", gridRow: paneCount === 3 ? "2 / 3" : "1 / -1" }}
            />
          )}
          {paneCount > 2 && (
            <SplitPaneResizeHandle
              axis="rows"
              index={0}
              trackProperty="--split-rows"
              className="hidden @min-[36rem]/split-workspace:block"
              style={{ gridColumn: "1 / -1", gridRow: "1 / 2" }}
            />
          )}
          {stackedRowBoundaries.slice(0, paneCount - 1).map((index) => (
            <SplitPaneResizeHandle
              key={`${paneCount}:${index}`}
              axis="rows"
              index={index}
              trackProperty={stackedTracks}
              className="@min-[36rem]/split-workspace:hidden"
              style={{ gridColumn: "1 / 2", gridRow: `${index + 1} / ${index + 2}` }}
            />
          ))}
        </div>
      </div>
    </SplitContext>
  );
}

const splitDropPreviewClass =
  "split-thread-drop-preview pointer-events-none absolute z-30 grid place-items-center rounded-lg bg-primary/15 opacity-0 ring-2 ring-primary/60 ring-inset data-[thread-context-over=true]:opacity-100";

function SplitMovePreview({ blank = false }: { blank?: boolean }) {
  return (
    <div
      data-split-move-preview
      aria-hidden="true"
      className={cn(splitDropPreviewClass, "inset-0")}
    >
      <span className="rounded-md bg-background px-3 py-2 text-sm font-medium shadow">
        {blank ? "Move thread here" : "Swap panes"}
      </span>
    </div>
  );
}

function SplitSnapPreview({
  edge,
  onDrop,
}: {
  readonly edge: ThreadContextSnapEdge;
  readonly onDrop: (edge: ThreadContextSnapEdge, refs: ReadonlyArray<ScopedThreadRef>) => void;
}) {
  const target = useRef<HTMLDivElement>(null);
  useThreadContextDrop(target, null, edge, (refs) => onDrop(edge, refs));
  return (
    <div
      ref={target}
      {...threadContextSnapTargetProps(edge)}
      aria-hidden="true"
      className={cn(
        splitDropPreviewClass,
        "h-1/2 w-full @min-[36rem]/split-workspace:h-full @min-[36rem]/split-workspace:w-1/2",
        edge === "left" ? "top-0 left-0" : "right-0 bottom-0",
      )}
    >
      <span className="rounded-md bg-background px-3 py-2 text-sm font-medium shadow">
        Open in split pane
      </span>
    </div>
  );
}

function SplitPane({
  id,
  index,
  fillsRow,
  move,
  threads,
  pickerOpen,
  onPickerOpenChange,
  selection,
  draftId,
  setSelection,
  setDraft,
  otherSelections,
  close,
  standalone,
}: {
  readonly id: string;
  readonly index: number;
  readonly fillsRow: boolean;
  readonly move: SplitPaneMove | null;
  readonly threads: readonly EnvironmentThreadShell[];
  readonly pickerOpen: boolean;
  readonly onPickerOpenChange: (open: boolean) => void;
  readonly selection: string;
  readonly draftId?: DraftId | undefined;
  readonly setSelection: (selection: string, onlyIfBlank?: boolean) => void;
  readonly setDraft: (draftId: DraftId) => void;
  readonly otherSelections: readonly string[];
  readonly close: (() => void) | undefined;
  readonly standalone: boolean;
}) {
  const paneNumber = index + 1;
  const pickerId = useId();
  const dropTarget = useRef<HTMLElement>(null);
  const promoted = useComposerDraftStore((store) =>
    draftId ? store.getPromotedDraftRedirect(draftId) : null,
  );
  const draft = useComposerDraftStore((store) => (draftId ? store.getDraftSession(draftId) : null));
  const selectedRef = promoted ?? (draft ? null : parseScopedThreadKey(selection));
  const selectedShell = useQuietThreadShell(selectedRef);
  const shellStatus = useEnvironmentShellStatus(selectedRef?.environmentId ?? null);
  const hiddenKeys = useHiddenThreadKeys();
  const hidingAnywhere = useAnyEnvironmentHiding();
  const { isReady: environmentsReady, presentationById } = useEnvironments();
  useOpenThreadFamily(selectedRef, shellStatus === "live" && selectedShell === null);
  const thread = draft
    ? null
    : (threads.find((item) => splitThreadKey(item) === selection) ??
      (selectedShell &&
      !selectedShell.archivedAt &&
      !selectedShell.deletedAt &&
      !selectedShell.lineage.sideChat &&
      !hiddenKeys.has(
        threadKey({ environmentId: selectedShell.environmentId, threadId: selectedShell.id }),
      )
        ? selectedShell
        : null));
  const unlistedRef = thread || selectedShell ? null : selectedRef;
  const unlisted = useEnvironmentThread(
    unlistedRef?.environmentId ?? null,
    unlistedRef?.threadId ?? null,
  );
  const unlistedThread = Option.getOrNull(unlisted.data)?.thread;
  const unavailable =
    (selectedRef !== null && hiddenKeys.has(threadKey(selectedRef))) ||
    (selectedShell !== null && !thread) ||
    unlisted.status === "deleted" ||
    (unlistedThread != null &&
      (unlistedThread.archivedAt !== null ||
        unlistedThread.deletedAt !== null ||
        unlistedThread.lineage.sideChat ||
        hidingAnywhere)) ||
    (environmentsReady && selectedRef !== null && !presentationById.has(selectedRef.environmentId));
  const [query, setQuery] = useState("");
  const [choosingProject, setChoosingProject] = useState(false);
  const search = query.trim().toLocaleLowerCase();
  const matchingThreads = threads.filter(
    (item) =>
      !otherSelections.includes(splitThreadKey(item)) &&
      item.title.toLocaleLowerCase().includes(search),
  );
  function choose(value: string) {
    setSelection(value);
    onPickerOpenChange(false);
  }
  const openThreadRef = unavailable
    ? null
    : thread
      ? scopeThreadRef(thread.environmentId, thread.id)
      : unlistedThread
        ? unlistedRef
        : promoted;
  const closePicker = () => {
    setChoosingProject(false);
    onPickerOpenChange(false);
  };
  const blank = selection === "" && !draftId;
  const paneTitle =
    thread?.title ??
    (!unavailable ? unlistedThread?.title : undefined) ??
    (promoted || draft ? "New thread" : null);
  useThreadContextDrop(dropTarget, null, pickerId, (refs) => {
    if (!blank) return;
    const key = refs
      .map(scopedThreadKey)
      .find(
        (candidate) =>
          !otherSelections.includes(candidate) &&
          threads.some((item) => splitThreadKey(item) === candidate),
      );
    if (!key) return;
    setSelection(key, true);
    closePicker();
  });

  return (
    <section
      ref={dropTarget}
      {...(blank ? threadContextDropTargetProps() : {})}
      data-side-chat-pane
      data-split-layout-pane
      data-split-move-target={move ? id : undefined}
      aria-label={`Pane ${paneNumber}`}
      className={cn(
        "@container/chat-pane relative flex min-h-0 min-w-0 flex-col overflow-hidden bg-background",
        blank && "data-[thread-context-over=true]:bg-accent/40",
        fillsRow && "@min-[36rem]/split-workspace:col-span-2",
      )}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border p-2">
        {move && !blank && <SplitPaneMoveHandle move={move} title={paneTitle ?? "Thread"} />}
        <Button
          aria-label={`Choose a thread for pane ${paneNumber}`}
          aria-expanded={pickerOpen}
          aria-controls={pickerOpen ? pickerId : undefined}
          variant="outline"
          size="sm"
          className="min-w-0 flex-1 justify-between"
          onClick={() => {
            if (pickerOpen) {
              closePicker();
            } else {
              setQuery("");
              setChoosingProject(false);
              onPickerOpenChange(true);
            }
          }}
        >
          <span className="min-w-0 truncate">{paneTitle ?? "Choose a thread"}</span>
          <ChevronDownIcon aria-hidden="true" className="size-3.5" />
        </Button>
        {(standalone && openThreadRef) || (draftId && draft) ? (
          <Button
            size="icon-sm"
            variant="ghost"
            render={
              openThreadRef ? (
                <Link
                  to="/$environmentId/$threadId"
                  params={{
                    environmentId: openThreadRef.environmentId,
                    threadId: openThreadRef.threadId,
                  }}
                  aria-label={`Open pane ${paneNumber} thread in full view`}
                />
              ) : draftId ? (
                <Link
                  to="/draft/$draftId"
                  params={{ draftId }}
                  aria-label={`Open pane ${paneNumber} draft in full view`}
                />
              ) : undefined
            }
          >
            <ArrowUpRightIcon />
          </Button>
        ) : null}
        {close ? (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Close pane ${paneNumber}`}
            onClick={close}
          >
            <XIcon />
          </Button>
        ) : null}
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          className="flex min-h-0 flex-1 flex-col"
          data-split-pane-content={blank ? "blank" : "thread"}
          inert={pickerOpen}
        >
          {openThreadRef || (draftId && draft) ? (
            <ComposerHandleContext value={null}>
              {openThreadRef ? (
                <ChatView
                  key={draftId ?? selection}
                  routeKind="server"
                  environmentId={openThreadRef.environmentId}
                  threadId={openThreadRef.threadId}
                  splitPane
                />
              ) : draftId && draft ? (
                <ChatView
                  key={draftId}
                  routeKind="draft"
                  draftId={draftId}
                  environmentId={draft.environmentId}
                  threadId={draft.threadId}
                  splitPane
                />
              ) : null}
            </ComposerHandleContext>
          ) : blank ? (
            <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-sm">
              <div className="split-thread-drop-hint flex flex-col items-center gap-2 text-muted-foreground">
                <MessageSquareIcon className="size-5" aria-hidden />
                <span>Drag a thread here</span>
              </div>
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center px-4 text-center text-sm text-muted-foreground">
              {unavailable ? "Thread unavailable" : "Restoring thread…"}
            </div>
          )}
        </div>
        {pickerOpen ? (
          <div
            id={pickerId}
            role="group"
            aria-label={`Threads for pane ${paneNumber}`}
            className="split-thread-picker absolute inset-0 z-10 flex flex-col bg-background px-2 pb-2"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                closePicker();
              }
            }}
          >
            {choosingProject ? (
              <SplitDraftProjectPicker
                onBack={() => setChoosingProject(false)}
                onOpenDraft={(id) => {
                  setDraft(id);
                  closePicker();
                }}
              />
            ) : (
              <>
                <div className="shrink-0 pt-2">
                  <Input
                    nativeInput
                    autoFocus
                    aria-label="Search threads"
                    placeholder="Search threads…"
                    value={query}
                    onChange={(event) => setQuery(event.currentTarget.value)}
                  />
                </div>
                <div className="shrink-0 py-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start"
                    onClick={() => setChoosingProject(true)}
                  >
                    <PlusIcon aria-hidden="true" />
                    New thread
                  </Button>
                </div>
                <div className="min-h-0 overflow-y-auto">
                  {!blank && !search ? (
                    <ThreadOption onClick={() => choose("")}>Clear pane</ThreadOption>
                  ) : null}
                  {matchingThreads.map((item) => {
                    const key = splitThreadKey(item);
                    return (
                      <ThreadOption key={key} onClick={() => choose(key)}>
                        {item.title}
                      </ThreadOption>
                    );
                  })}
                  {matchingThreads.length === 0 ? (
                    <p className="px-2 py-2 text-sm text-muted-foreground">No matching threads</p>
                  ) : null}
                </div>
              </>
            )}
          </div>
        ) : null}
      </div>
      {move && <SplitMovePreview blank={blank} />}
    </section>
  );
}

function SplitDraftProjectPicker({
  onBack,
  onOpenDraft,
}: {
  readonly onBack: () => void;
  readonly onOpenDraft: (draftId: DraftId) => void;
}) {
  const projects = useProjects();
  const { environments } = useEnvironments();
  const operable = useEnvironmentsWithScope(environments, AuthOrchestrationOperateScope);
  const createDraft = useNewThreadHandler();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const request = useRef<AbortController | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- cancels draft creation if the pane or picker closes while project defaults load
  useEffect(() => () => request.current?.abort(), []);
  const connected = new Set(
    environments
      .filter(({ connection }) => connection.phase === "connected")
      .map(({ environmentId }) => environmentId),
  );
  const choices = projects
    .filter(
      (project) =>
        project.archivedAt == null &&
        !project.isScratch &&
        connected.has(project.environmentId) &&
        operable.has(project.environmentId),
    )
    .sort((a, b) => a.title.localeCompare(b.title));

  async function chooseProject(project: EnvironmentProject) {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setError(false);
    const projectRef = scopeProjectRef(project.environmentId, project.id);
    const result = await createDraft(projectRef, { pane: { signal: controller.signal } }).catch(
      () => null,
    );
    request.current = null;
    if (controller.signal.aborted) return;
    setPending(false);
    if (result) onOpenDraft(result.draftId);
    else setError(true);
  }

  return (
    <>
      <div className="flex shrink-0 items-center justify-between gap-2 py-2">
        <span className="px-2 text-sm font-medium">
          {pending ? "Opening draft…" : "Choose a project"}
        </span>
        <Button size="sm" variant="ghost" onClick={onBack}>
          Back
        </Button>
      </div>
      <div className="min-h-0 overflow-y-auto">
        {choices.map((project) => (
          <Button
            key={scopedProjectKey(scopeProjectRef(project.environmentId, project.id))}
            variant="ghost"
            size="sm"
            disabled={pending}
            className="w-full justify-start"
            onClick={() => void chooseProject(project)}
          >
            <span className="min-w-0 truncate">{project.title}</span>
            {environments.length > 1 ? (
              <span className="min-w-0 truncate text-xs text-muted-foreground">
                {
                  environments.find(
                    (environment) => environment.environmentId === project.environmentId,
                  )?.label
                }
              </span>
            ) : null}
          </Button>
        ))}
        {error ? (
          <p role="alert" className="px-2 py-2 text-sm text-error-foreground">
            Couldn’t open the draft. Try again.
          </p>
        ) : null}
        {choices.length === 0 ? (
          <p className="px-2 py-2 text-sm text-muted-foreground">
            Add a project in a connected environment to start a thread.
          </p>
        ) : null}
      </div>
    </>
  );
}

function ThreadOption({
  onClick,
  children,
}: {
  readonly onClick: () => void;
  readonly children: string;
}) {
  return (
    <Button variant="ghost" size="sm" className="w-full justify-start" onClick={onClick}>
      <span className="min-w-0 truncate">{children}</span>
    </Button>
  );
}
