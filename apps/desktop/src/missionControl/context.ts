import type { MissionControlItem, MissionControlTaskContext } from "@t3tools/contracts";

const products = ["nebos", "hyperscale", "hypercrawl"] as const;
const laneLabel = /^(?:(?:lane|gtm)[- :]+)?(L(?:10|[1-9]))$/i;
const laneInTitle = /\bL(?:10|[1-9])\b/gi;
const restricted = /\b(rs21|pnm|nmprc|nerc|confidential|regulated data)\b/i;

export type TeamPriorityContext = {
  lanes: readonly string[];
  workstreams: readonly string[];
};

export function teamLaneOrder(contents: string): readonly string[] {
  const frontmatter = contents.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatter || !/^tenant: teamnebula\r?$/m.test(frontmatter[1]!)) {
    throw new Error("Team Nebula context unavailable");
  }
  const decision = contents.match(
    /^Lane priority \(founders' decision [^)]*\):\s*\*\*([^*]+)\*\*/m,
  )?.[1];
  return [...new Set(decision?.toUpperCase().match(laneInTitle) ?? [])];
}

function unique<T>(values: readonly T[]) {
  const entries = [...new Set(values)];
  return entries.length === 1 ? entries[0] : undefined;
}

export function teamTaskContext(
  title: string,
  project: string,
  labels: readonly string[],
): MissionControlTaskContext {
  // Product/workflow hints come from structured project and tracker metadata.
  const metadata = [project, ...labels].join(" ");
  if (restricted.test(metadata) || restricted.test(title)) return { restricted: true };
  const metadataWords = metadata.toLowerCase().split(/[^a-z0-9]+/);
  const product = unique(products.filter((name) => metadataWords.includes(name)));
  const assignedLanes = labels.flatMap(
    (label) => label.trim().match(laneLabel)?.[1]?.toUpperCase() ?? [],
  );
  const lane = unique(
    assignedLanes.length ? assignedLanes : (title.toUpperCase().match(laneInTitle) ?? []),
  );
  const workflows = labels.flatMap((label) => {
    switch (label.trim().toLowerCase()) {
      case "bug":
      case "bugfix":
      case "implementation":
        return ["implementation" as const];
      case "code review":
      case "technical design":
        return ["review" as const];
      case "outreach":
      case "prospecting":
        return ["outreach" as const];
      case "public web research":
        return ["research" as const];
      default:
        return [];
    }
  });
  const workflow = unique(workflows);
  return {
    ...(product && { product }),
    ...(lane && { lane }),
    ...(workflow && { workflow }),
  };
}

function normalizedWords(value: string) {
  return (
    " " +
    value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim() +
    " "
  );
}

function hasPhrase(title: string, phrase: string) {
  const words = normalizedWords(phrase);
  return words.length >= 6 && normalizedWords(title).includes(words);
}

export function personalFocusTerms(note: string): readonly string[] {
  return [...note.matchAll(/^[ \t]*(?:[-*][ \t]+)?Priority:[ \t]*([^\r\n]{4,80}?)[ \t]*\r?$/gim)]
    .map((match) => match[1]!.trim())
    .slice(0, 8);
}

export function contextualizePriority(
  item: MissionControlItem,
  team: TeamPriorityContext,
  personalFocus: readonly string[],
): MissionControlItem {
  if (item.source === "srcos" && personalFocus.some((focus) => hasPhrase(item.title, focus))) {
    return { ...item, priorityReason: "Matches your pinned SRCOS priorities" };
  }
  if ((item.source !== "linear" && item.source !== "nebos") || item.taskContext?.restricted)
    return item;
  const lane = item.taskContext?.lane;
  const activeWorkstream = team.workstreams.some((workstream) => hasPhrase(item.title, workstream));
  if (!activeWorkstream && (!lane || !team.lanes.includes(lane))) return item;
  return {
    ...item,
    ...(activeWorkstream && { taskContext: { ...item.taskContext, activeWorkstream: true } }),
    priorityReason:
      lane && team.lanes.includes(lane)
        ? "Team Nebula priority · " + lane
        : "Matches an enabled NEBOS workstream",
  };
}

export function contextOrder(item: MissionControlItem, lanes: readonly string[]): number {
  if (!item.priorityReason) return Number.MAX_SAFE_INTEGER;
  const lane = item.taskContext?.lane;
  const index = lane ? lanes.indexOf(lane) : -1;
  return index === -1 ? lanes.length : index;
}
