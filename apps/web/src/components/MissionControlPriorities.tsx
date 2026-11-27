import {
  missionControlPrioritySources,
  type DesktopBridge,
  type MissionControlActionResult,
  type MissionControlHandoff,
  type MissionControlItem,
  type MissionControlPriorityFilter,
  type MissionControlRequest,
  type MissionControlResponse,
} from "@t3tools/contracts";
import { ArrowUpRightIcon, ChevronLeftIcon, ChevronRightIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { cn } from "../lib/utils";
import {
  MissionControlHandoffButton,
  useMissionControlHandoffs,
} from "./MissionControlHandoffButton.tsx";
import { MissionControlItemAction } from "./MissionControlItemAction.tsx";
import { MissionControlTaskButton } from "./MissionControlTaskDialog.tsx";
import { Button } from "./ui/button";
import { toastManager } from "./ui/toast";

const labels = {
  email: "Email",
  slack: "Slack",
  linear: "Linear",
  nebos: "NEBOS",
  srcos: "SRCOS",
  tasks: "Google Tasks",
  context: "Team context",
} as const;

const filters = [
  ["all", "All"],
  ["email", "Email replies"],
  ["slack", "Slack replies"],
  ["team", "Workspace tasks"],
  ["tasks", "Personal tasks"],
  ["srcos", "SRCOS"],
] as const;

const priorityBatchSize = 5;
const mailPageSize = 15;

function ItemRow({
  item,
  handoff,
  resolved,
  onDone,
  onChanged,
}: {
  item: MissionControlItem;
  handoff: MissionControlHandoff | undefined;
  resolved: boolean;
  onDone: (result: Extract<MissionControlActionResult, { ok: true }>) => void;
  onChanged: (result: Extract<MissionControlActionResult, { ok: true }>) => void;
}) {
  const detail = [
    labels[item.source],
    item.account,
    item.detail,
    item.due ? `Due ${item.due}` : "",
    item.priorityReason,
  ]
    .filter(Boolean)
    .join(" · ");
  const content = (
    <>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium break-words" dir="auto">
          {item.title}
        </span>
        <span className="mt-1 block text-xs text-muted-foreground" dir="auto">
          {detail}
        </span>
      </span>
      {item.urgency !== "normal" && (
        <span className="text-xs text-warning-foreground">
          {item.urgency === "urgent" ? "Urgent" : "High"}
        </span>
      )}
      {item.url && (
        <ArrowUpRightIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      )}
    </>
  );
  const className = "flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left";
  const url = item.url;
  return (
    <li className="flex flex-wrap items-center gap-x-2 pr-3">
      {url ? (
        <button
          type="button"
          className={cn(
            className,
            "hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          )}
          onClick={() => void window.desktopBridge?.openExternal(url)}
        >
          {content}
        </button>
      ) : (
        <div className={className}>{content}</div>
      )}
      {resolved ? (
        <span className="text-xs text-muted-foreground">Replied</span>
      ) : (
        <>
          <MissionControlItemAction item={item} onDone={onDone} />
          {item.source === "tasks" && <MissionControlTaskButton item={item} onSaved={onChanged} />}
          <MissionControlHandoffButton key={item.title} item={item} handoff={handoff} />
        </>
      )}
    </li>
  );
}

function Sources({ sources }: { sources: MissionControlResponse["sources"] }) {
  const unavailable = sources.filter((source) => source.state === "unavailable");
  if (!unavailable.length) return null;
  return (
    <details className="rounded-lg border border-border px-4 py-3 text-sm">
      <summary className="cursor-pointer">Sources · {unavailable.length} unavailable</summary>
      <ul className="mt-3 space-y-2 text-xs text-muted-foreground">
        {unavailable.map((source) => (
          <li key={`${source.source}:${source.account}`}>
            <span className="font-medium text-foreground">
              {labels[source.source]} · {source.account}
            </span>
            {source.detail && ` · ${source.detail}`}
          </li>
        ))}
      </ul>
    </details>
  );
}

function useMissionControlFeed(
  bridge: DesktopBridge | undefined,
  request: MissionControlRequest | null,
) {
  const [refreshRequest, setRefreshRequest] = useState<{ key: string; revision: number }>();
  const [result, setResult] = useState<{
    key: string;
    revision: number;
    mailboxes: MissionControlResponse["mailboxes"];
    data?: MissionControlResponse;
    failed: boolean;
  }>();

  const key = request ? JSON.stringify(request) : null;
  const revision = refreshRequest?.key === key ? refreshRequest.revision : 0;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Fetches an external IPC feed and drops responses from a view that was closed or changed.
  useEffect(() => {
    if (!bridge?.getMissionControl || !key) return;
    const request = JSON.parse(key) as MissionControlRequest;
    let active = true;
    const input = request.view === "priorities" ? { ...request, refresh: revision > 0 } : request;
    void bridge.getMissionControl(input).then(
      (data) => {
        if (active) setResult({ key, revision, data, mailboxes: data.mailboxes, failed: false });
      },
      () => {
        if (active)
          setResult((previous) => ({
            key,
            revision,
            mailboxes: previous?.mailboxes ?? [],
            failed: true,
            ...(previous?.key === key && previous.data ? { data: previous.data } : {}),
          }));
      },
    );
    return () => {
      active = false;
    };
  }, [bridge, key, revision]);

  const current = result?.key === key ? result : undefined;
  return {
    data: current?.data,
    mailboxes: result?.mailboxes ?? [],
    isFetching: Boolean(bridge?.getMissionControl && request && current?.revision !== revision),
    isError: current?.failed ?? false,
    refresh: () => {
      if (key) setRefreshRequest((previous) => ({ key, revision: (previous?.revision ?? 0) + 1 }));
    },
  };
}

export function MissionControlPriorities() {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  const [filter, setFilter] = useState<MissionControlPriorityFilter>("all");
  const [account, setAccount] = useState<string>();
  const [replies, setReplies] = useState(false);
  const [page, setPage] = useState<(string | null)[]>([null]);
  const [priorityLimit, setPriorityLimit] = useState(priorityBatchSize);
  const [resolved, setResolved] = useState<ReadonlyMap<string, string>>(() => new Map());
  const listId = useId();

  const cursor = page.at(-1) ?? null;
  const priorities = useMissionControlFeed(bridge, {
    view: "priorities",
    refresh: false,
    filter,
  });
  const mail = useMissionControlFeed(
    bridge,
    account ? { view: "mail", account, cursor, replies } : null,
  );
  const snapshot = priorities.data;
  const active = account ? mail : priorities;
  const current = active.data;
  const scope = missionControlPrioritySources[filter];
  const displayed = (current?.items ?? []).filter(
    (item) =>
      (account || scope.includes(item.source)) &&
      ((account && !replies) || resolved.get(item.id) !== item.activity),
  );
  const visible = displayed.slice(0, account ? mailPageSize : priorityLimit);
  const handoffs = useMissionControlHandoffs(bridge, visible);
  const sources = (current?.sources ?? []).filter(
    (source) => account || scope.includes(source.source),
  );
  const filterLabel = filters.find(([id]) => id === filter)?.[1] ?? "All";
  const heading = account
    ? `${replies ? "Inbox reply candidates" : "All Mail"} · ${account}`
    : filter === "all"
      ? "Top priorities"
      : filterLabel;
  const loadingLabel = account
    ? `${account} mail`
    : filter === "all"
      ? "your sources"
      : filterLabel;
  const unavailable =
    active.isError ||
    (sources.length > 0 && sources.every((source) => source.state === "unavailable"));
  if (!bridge?.getMissionControl || (snapshot && !snapshot.configured)) return null;
  const onChanged = (result: Extract<MissionControlActionResult, { ok: true }>) => {
    toastManager.add({ type: "success", title: result.message });
    active.refresh();
  };
  const canAddTask =
    !account &&
    (filter === "all" || filter === "tasks") &&
    Boolean(snapshot?.sources.some((source) => source.source === "tasks"));

  return (
    <section aria-label="Personal priorities" className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{heading}</h2>
          {!account && (filter === "all" || filter === "team") && snapshot?.context && (
            <p className="mt-1 text-xs text-muted-foreground">{snapshot.context}</p>
          )}
          {!account && (filter === "all" || filter === "srcos") && snapshot?.srcosContext && (
            <p className="mt-1 text-xs text-muted-foreground">
              SRCOS context · {snapshot.srcosContext}
            </p>
          )}
          {current?.fetchedAt && (
            <p className="mt-1 text-xs text-muted-foreground">
              Updated{" "}
              {new Date(current.fetchedAt).toLocaleTimeString([], {
                hour: "numeric",
                minute: "2-digit",
              })}
              {!account && Boolean(current.priorityScoredCount) && " · Ranked with JEV"}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          {canAddTask && <MissionControlTaskButton onSaved={onChanged} />}
          <Button variant="outline" size="sm" disabled={active.isFetching} onClick={active.refresh}>
            <RefreshCwIcon className={cn("size-4", active.isFetching && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap gap-2" aria-label="Priority filters">
        {filters.map(([id, name]) => (
          <Button
            key={id}
            size="sm"
            variant={!account && filter === id ? "secondary" : "outline"}
            aria-pressed={!account && filter === id}
            onClick={() => {
              setAccount(undefined);
              setFilter(id);
              setPriorityLimit(priorityBatchSize);
            }}
          >
            {name}
          </Button>
        ))}
        {priorities.mailboxes.map((label) => (
          <Button
            key={label}
            size="sm"
            variant={account === label ? "secondary" : "outline"}
            aria-pressed={account === label}
            onClick={() => {
              setAccount(label);
              setReplies(false);
              setPage([null]);
              setPriorityLimit(priorityBatchSize);
            }}
          >
            {label} mail
          </Button>
        ))}
      </div>
      {account && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setReplies(!replies);
            setPage([null]);
          }}
        >
          {replies ? "Browse all mail" : "Browse inbox reply candidates"}
        </Button>
      )}
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        {displayed.length > 0 ? (
          <ul id={listId} className="divide-y divide-border/70">
            {visible.map((item, index) => (
              <ItemRow
                key={item.id}
                item={item}
                handoff={handoffs[index]}
                resolved={resolved.get(item.id) === item.activity}
                onDone={(result) => {
                  setResolved((previous) => new Map(previous).set(item.id, item.activity));
                  toastManager.add({ type: "success", title: result.message });
                  active.refresh();
                }}
                onChanged={onChanged}
              />
            ))}
          </ul>
        ) : (
          <p className="px-4 py-6 text-sm text-muted-foreground" role="status">
            {active.isFetching
              ? `Checking ${loadingLabel}…`
              : unavailable
                ? "This view is unavailable. Check Sources and try refreshing."
                : account
                  ? replies
                    ? "No reply candidates on this page."
                    : "No messages on this page."
                  : "No items found in the available sources."}
          </p>
        )}
        {account && (current?.nextCursor || page.length > 1) && (
          <div className="flex justify-between border-t border-border p-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={page.length === 1 || mail.isFetching}
              onClick={() => setPage((previous) => previous.slice(0, -1))}
            >
              <ChevronLeftIcon /> Previous
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!current?.nextCursor || mail.isFetching}
              onClick={() => {
                if (current?.nextCursor) setPage((previous) => [...previous, current.nextCursor]);
              }}
            >
              Next <ChevronRightIcon />
            </Button>
          </div>
        )}
        {!account && displayed.length > priorityBatchSize && (
          <div className="flex gap-2 p-2">
            {displayed.length > priorityLimit && (
              <Button
                variant="ghost"
                size="sm"
                aria-controls={listId}
                onClick={() => setPriorityLimit((previous) => previous + priorityBatchSize)}
              >
                See more
              </Button>
            )}
            {visible.length > priorityBatchSize && (
              <Button
                variant="ghost"
                size="sm"
                aria-controls={listId}
                onClick={() => setPriorityLimit(priorityBatchSize)}
              >
                See less
              </Button>
            )}
          </div>
        )}
      </div>
      {active.isError && current && (
        <p role="status" className="text-xs text-warning-foreground">
          Refresh failed. Showing the last available results.
        </p>
      )}
      <Sources sources={sources} />
    </section>
  );
}
