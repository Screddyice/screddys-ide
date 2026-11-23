import type { MissionControlItem } from "@t3tools/contracts";

import { isRestrictedMissionControlTask, routingCandidate } from "./handoff.ts";
import { decideMissionControl } from "./jev.ts";
import { obj } from "./sources.ts";

const taskSources = new Set(["slack", "linear", "nebos", "tasks", "srcos"]);
const criteria = [
  "Defer: optional or informational follow-up with negligible impact.",
  "Routine: actionable work without a clear time-sensitive or blocking signal.",
  "High: time-sensitive or consequential work, such as clearing a build blocker.",
  "Immediate: urgent intervention or an overdue high-impact action.",
];

export function prioritySignal(item: MissionControlItem, today: string) {
  if (!taskSources.has(item.source) || isRestrictedMissionControlTask(item)) return null;
  const route = routingCandidate(item);
  const due = item.due === null ? "unscheduled" : item.due <= today ? "due_now" : "upcoming";
  const prioritizedLocally = Boolean(item.priorityReason);
  if (!route && !prioritizedLocally && due === "unscheduled" && item.urgency === "normal") {
    return null;
  }
  return JSON.stringify({
    source: item.source,
    actions: route ? obj(JSON.parse(route)).actions : [],
    due,
    urgency: item.urgency,
    prioritizedLocally,
  });
}

const cacheLifetime = 30 * 60_000;
const scores = new Map<string, { expiresAt: number; score: Promise<number | undefined> }>();

export async function scoreMissionControlPriorities(
  home: string,
  items: readonly MissionControlItem[],
  today: string,
  now: number,
): Promise<ReadonlyMap<string, number>> {
  for (const [key, entry] of scores) {
    if (entry.expiresAt <= now) scores.delete(key);
  }

  const candidates = items.flatMap((item) => {
    const signal = prioritySignal(item, today);
    return signal ? [{ id: item.id, signal, key: JSON.stringify([home, signal]) }] : [];
  });
  const missing = [
    ...new Map(
      candidates.filter(({ key }) => !scores.has(key)).map(({ key, signal }) => [key, signal]),
    ),
  ].slice(0, 20);
  for (let offset = 0; offset < missing.length; offset += 10) {
    const batch = missing.slice(offset, offset + 10);
    const response = decideMissionControl(
      home,
      batch.map(([, signal], index) => `priority_${index}: ${signal}`).join("\n"),
      Object.fromEntries(
        batch.map((_, index) => [
          `priority_${index}`,
          {
            type: "score",
            criteria,
            instructions: `Score only priority_${index} by the evidence in its fields. Missing evidence about impact or timing is not evidence of urgency.`,
          },
        ]),
      ),
    );
    batch.forEach(([key], index) => {
      scores.set(key, {
        expiresAt: now + cacheLifetime,
        score: response.then(
          (data) => {
            const { type, score, confidence } = obj(obj(obj(data).answers)[`priority_${index}`]);
            if (
              type === "score" &&
              typeof score === "number" &&
              score >= 0 &&
              score <= 3 &&
              typeof confidence === "number" &&
              confidence >= 0.6 &&
              confidence <= 1
            ) {
              return score;
            }
            return undefined;
          },
          () => undefined,
        ),
      });
    });
  }
  const resolved = await Promise.all(
    candidates.map(async ({ id, key }) => [id, await scores.get(key)?.score] as const),
  );
  while (scores.size > 256) scores.delete(scores.keys().next().value!);
  return new Map(
    resolved.filter((entry): entry is readonly [string, number] => entry[1] !== undefined),
  );
}
