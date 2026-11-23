import type { ThreadStructureVisibleTurnItem } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, OrchestrationV2Run, RunId } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import type { TimelineEntry } from "../../session-logic";
import type { Thread } from "../../types";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useServerConfigs } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { announcedRun } from "./threadActivityAnnouncement";

// Dismissed suggestions, keyed by environment and run, shared by every mounted composer and kept
// across remounts. Run ids derive from thread ids, which can repeat across environments.
let dismissedKeys: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
const subscribeDismissed = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const readDismissed = () => dismissedKeys;
const dismissKey = (environmentId: EnvironmentId, runId: RunId) => `${environmentId}\u0000${runId}`;

/**
 * The suggestion while the run that produced it is the thread's latest completed run. A message
 * promoted to Steer leaves its queued run cancelled before it started, still the latest run, so
 * the comparison skips to the last run that ran. Detail can lag the shell, so it skips only once
 * the runs include that cancelled run.
 */
function completedRunForSuggestion(
  latestRun: Thread["latestRun"] | undefined,
  runs: ReadonlyArray<OrchestrationV2Run>,
): RunId | null {
  const run = announcedRun(latestRun ?? null, runs);
  const skippedUnseenRun =
    latestRun != null &&
    run?.runId !== latestRun.runId &&
    !runs.some(
      (candidate) =>
        candidate.id === latestRun.runId &&
        candidate.status === "cancelled" &&
        candidate.startedAt === null,
    );
  return !skippedUnseenRun && run?.status === "completed" ? run.runId : null;
}

export function offeredPromptSuggestion<Suggestion extends { readonly runId: RunId }>(
  suggestion: Suggestion | null | undefined,
  latestRun: Thread["latestRun"] | undefined,
  runs: ReadonlyArray<OrchestrationV2Run>,
): Suggestion | null {
  return suggestion && suggestion.runId === completedRunForSuggestion(latestRun, runs)
    ? suggestion
    : null;
}

/** Choose a follow-up from the run's visible results without making another model request. */
function localPromptSuggestion(
  runId: RunId,
  timeline: ReadonlyArray<TimelineEntry>,
  visibleTurnItems: ReadonlyArray<ThreadStructureVisibleTurnItem>,
): string | null {
  let changedFiles = false;
  for (const entry of timeline) {
    if (
      entry.kind === "proposed-plan" &&
      entry.proposedPlan.runId === runId &&
      entry.proposedPlan.status === "active"
    ) {
      return "Walk me through the first step of the plan.";
    }
    if (
      entry.kind === "work" &&
      entry.entry.runId === runId &&
      entry.entry.toolLifecycleStatus === "completed" &&
      (entry.entry.changedFiles?.length ?? 0) > 0
    ) {
      changedFiles = true;
    }
  }
  if (changedFiles) return "Review the changes and verify that they work.";
  const hasReply = visibleTurnItems.some(
    ({ item }) => item.runId === runId && item.type === "assistant_message" && !item.streaming,
  );
  return hasReply ? "What should I do next based on this?" : null;
}

/**
 * Follow-up for the latest completed run, preferring an opted-in provider prediction.
 */
export function usePromptSuggestion({
  enabled,
  environmentId,
  thread,
  latestRun,
  runs,
  timeline,
  visibleTurnItems,
}: {
  readonly enabled: boolean;
  readonly environmentId: EnvironmentId;
  readonly thread: Thread | undefined;
  readonly latestRun: Thread["latestRun"];
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly timeline: ReadonlyArray<TimelineEntry>;
  readonly visibleTurnItems: ReadonlyArray<ThreadStructureVisibleTurnItem>;
}): { readonly suggestion: string | null; readonly dismiss: () => void } {
  // Older servers decode the missing setting as false, so true also proves the method exists.
  const providerPredictionsEnabled =
    useServerConfigs().get(environmentId)?.settings.promptSuggestionsEnabled === true;
  // Tab is the only way to accept one, so skip devices with no mouse or trackpad at all.
  const hasFinePointer = useMediaQuery("(any-pointer: fine)");
  const { data } = useEnvironmentQuery(
    // A local draft has no run, and so no suggestion, until its first send.
    enabled && providerPredictionsEnabled && hasFinePointer && thread && latestRun
      ? orchestrationEnvironment.v2.promptSuggestion({
          environmentId,
          input: { threadId: thread.id },
        })
      : null,
  );
  const dismissed = useSyncExternalStore(subscribeDismissed, readDismissed);
  const runId = enabled && hasFinePointer ? completedRunForSuggestion(latestRun, runs) : null;
  const key = runId === null ? null : dismissKey(environmentId, runId);
  const providerText = offeredPromptSuggestion(data, latestRun, runs)?.text.trim();
  return {
    suggestion:
      runId !== null && key !== null && !dismissed.has(key)
        ? providerText || localPromptSuggestion(runId, timeline, visibleTurnItems)
        : null,
    dismiss: () => {
      if (key === null) return;
      dismissedKeys = new Set(dismissedKeys).add(key);
      for (const listener of listeners) listener();
    },
  };
}
