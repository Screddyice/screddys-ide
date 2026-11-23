// @effect-diagnostics nodeBuiltinImport:off -- Uses the configured JEV MCP launcher and local bot links.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { MissionControlHandoff, MissionControlHandoffRequest } from "@t3tools/contracts";

import { isGrokBotConversationUrl } from "../electron/GrokBotLink.ts";
import { isRestrictedText } from "./context.ts";
import { launcherJev, type JevDecider } from "./jev.ts";
import { bindingsAt, obj } from "./sources.ts";

const criteria = {
  grok_build:
    "Default development agent for writing, debugging, testing, reviewing, or designing code in a repository.",
  cursor:
    "Development agent for coding or technical review when the task explicitly requests Cursor.",
  codex: "GPT in Codex for development when the task explicitly requests GPT or Codex.",
  claude:
    "Claude Code for an explicitly requested Claude task or a technical review centered on reasoning or design.",
  grok: "Open the main Grok Bot for productivity, research, outreach, and other work outside a coding workspace.",
  needs_review:
    "Insufficient or contradictory evidence, or no clear task the available agents can perform.",
} as const;

const trackerActions = {
  implementation: "implementation, debugging, or verification in a repository",
  review: "technical design or code review",
  outreach: "HyperScale outreach and prospecting operations",
  research: "HyperCrawl public web research",
  productivity: "productivity such as replying, drafting, scheduling, or organizing",
} as const;

const actionTypes = [
  [
    trackerActions.implementation,
    /\b(?:refactor|(?:code|test|ui) regression|unit tests?|test suite|code changes?|build failure|ci failure|pull requests?|database migration|deploy(?:ment)? (?:code|pipeline|config)|(?:fix|patch|implement|add|debug)\b.{0,60}\b(?:bug|code|frontend|backend|component|sidebar|api endpoint|function|integration|test|tests))\b/i,
  ],
  [
    trackerActions.review,
    /\b(?:code review|review (?:the )?(?:code|pr|diff|pull request)|(?:software|system|api|technical) (?:architecture|design)|architecture review)\b/i,
  ],
  [
    "HyperScale outreach and prospecting operations",
    /\b(campaign|prospect(?:ing|s)?|outreach|lead list)\b/i,
  ],
  [
    "HyperCrawl public web research",
    /\b(public (web|research)|scrap(?:e|ing)|crawl|competitor research|website research)\b/i,
  ],
  [
    "Connected workspace operations",
    /\b(workstream|crm|pipeline|triage queue|team coordination)\b/i,
  ],
  ["LinkedIn", /\blinkedin\b/i],
  ["X or Twitter", /\b(twitter|x\.com|x (agent|post|posts|dm|dms|account|engagement))\b/i],
  ["Instagram", /\b(instagram|linkdm)\b/i],
  [
    trackerActions.productivity,
    /\b(?:reply|respond|follow[ -]up|draft|summari[sz]e|recap|meeting notes|schedule|calendar|book|organize|organise|research|(?:prepare|review) (?:the |a )?(?:brief|agenda|notes|report|deck|proposal)|triage|send (?:an? |the )?(?:email|message)|appointment|groceries|pick up|renew passport|pay bill)\b/i,
  ],
] as const;

const cursorRequest =
  /\b(?:(?:use|using|in|with|via|launch) (?:the )?cursor\b(?! (?:position|icon|shape|style))|cursor (?:ide|agent))\b/i;
const codexRequest =
  /\b(?:use|using|in|with|via|launch) (?:the )?(?:codex|gpt(?:-\d+(?:\.\d+)?)?)\b/i;
const claudeRequest = /\b(?:use|using|in|with|via|launch) (?:the )?claude(?: code)?\b/i;
const teamSources = new Set(["linear", "nebos", "slack"]);
const localSources = new Set(["email", "tasks", "srcos", ...teamSources]);
const personalTaskSources = new Set(["tasks", "srcos"]);

export function isRestrictedMissionControlTask({
  title,
  taskContext,
}: MissionControlHandoffRequest) {
  return taskContext?.restricted || isRestrictedText(title);
}

function hasDevelopmentAction(actions: readonly string[]) {
  return actions.includes(trackerActions.implementation) || actions.includes(trackerActions.review);
}

function routingSignals({ source, title, taskContext }: MissionControlHandoffRequest) {
  // Only closed-vocabulary categories cross the external JEV boundary.
  const titleActions = actionTypes.flatMap(([label, pattern]) =>
    pattern.test(title) ? [label] : [],
  );
  const trackerAction = taskContext?.workflow && trackerActions[taskContext.workflow];
  const workstreamAction =
    taskContext?.activeWorkstream &&
    !titleActions.some((action) => action !== trackerActions.productivity) &&
    "Connected workspace operations";
  const fallbackAction =
    trackerAction || workstreamAction || (source === "slack" && trackerActions.productivity);
  const identified = [...new Set([...titleActions, ...(fallbackAction ? [fallbackAction] : [])])];
  const specific = identified.filter((action) => action !== trackerActions.productivity);
  const actions = specific.length ? specific : identified;
  const technical = hasDevelopmentAction(actions);
  const requested = [
    cursorRequest.test(title) ? ("cursor" as const) : null,
    codexRequest.test(title) ? ("codex" as const) : null,
    claudeRequest.test(title) ? ("claude" as const) : null,
  ].filter((agent) => agent !== null);
  return {
    source,
    actions,
    ...(taskContext?.product && !technical && { product: taskContext.product }),
    ...(taskContext?.workflow && { workflow: taskContext.workflow }),
    ...(workstreamAction && !trackerAction && { activeNebosWorkstream: true }),
    ...(technical && requested.length === 1 && { preferredIde: requested[0] }),
  };
}

export function routingInput(request: MissionControlHandoffRequest) {
  return JSON.stringify(routingSignals(request));
}

export function routingCandidate(request: MissionControlHandoffRequest): string | null {
  const firstParty = teamSources.has(request.source);
  if (
    (!firstParty && !personalTaskSources.has(request.source)) ||
    isRestrictedMissionControlTask(request)
  )
    return null;
  const signals = routingSignals(
    firstParty ? request : { source: request.source, title: request.title },
  );
  // A product name alone does not tell us what the task needs.
  return signals.actions.length || signals.workflow || signals.activeNebosWorkstream
    ? JSON.stringify(signals)
    : null;
}

export function localRoute(request: MissionControlHandoffRequest) {
  if (!localSources.has(request.source) || isRestrictedMissionControlTask(request))
    return "needs_review";
  const { actions, preferredIde } = routingSignals(request);
  if (hasDevelopmentAction(actions)) return preferredIde ?? "grok_build";
  return actions.length ? "grok" : "needs_review";
}

export function routingChoices(signal: string): Readonly<Record<string, string>> {
  const { actions, preferredIde } = obj(JSON.parse(signal));
  if (Array.isArray(actions) && hasDevelopmentAction(actions)) {
    if (preferredIde === "cursor" || preferredIde === "codex" || preferredIde === "claude") {
      return { [preferredIde]: criteria[preferredIde], needs_review: criteria.needs_review };
    }
    return {
      grok_build: criteria.grok_build,
      ...(actions.includes(trackerActions.review) && { claude: criteria.claude }),
      needs_review: criteria.needs_review,
    };
  }
  return { grok: criteria.grok, needs_review: criteria.needs_review };
}

export function pickRoute(response: unknown, question = "route"): keyof typeof criteria {
  const decision = obj(obj(obj(response).answers)[question]);
  const choice = decision.choice;
  if (typeof choice !== "string" || !Object.hasOwn(criteria, choice)) return "needs_review";
  const probabilities = obj(decision.probabilities);
  const top = probabilities[choice];
  if (typeof top !== "number" || !Number.isFinite(top) || top > 1 || top < 0.8) {
    return "needs_review";
  }
  const runnerUp = Math.max(
    0,
    ...Object.keys(criteria).flatMap((key) => {
      const p = probabilities[key];
      return key !== choice && typeof p === "number" && Number.isFinite(p) ? [p] : [];
    }),
  );
  return top - runnerUp >= 0.2 ? (choice as keyof typeof criteria) : "needs_review";
}

export function grokBotUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return isGrokBotConversationUrl(url) ? url.href : null;
  } catch {
    return null;
  }
}

type Route = keyof typeof criteria | "unavailable";
const routes = new Map<string, Promise<Route>>();

export async function routeItems(
  home: string,
  baseDir: string,
  input: readonly MissionControlHandoffRequest[],
  openRouter?: JevDecider,
): Promise<readonly MissionControlHandoff[]> {
  const bindings = await bindingsAt(baseDir);
  const requests = input.map((request) =>
    isRestrictedText(request.title, bindings?.restrictedTerms)
      ? { ...request, taskContext: { ...request.taskContext, restricted: true } }
      : request,
  );
  const command = bindings?.jevCommand;
  const jev = openRouter ?? (command ? launcherJev(home, command) : undefined);
  const decisions = jev ? await routeWithJev(jev, requests) : requests.map(localRoute);
  const mainBot: Record<string, unknown> = decisions.includes("grok")
    ? await NodeFSP.readFile(NodePath.join(baseDir, "mission-control.json"), "utf8")
        .then((raw) => obj(obj(JSON.parse(raw)).grokBot))
        .catch(() => ({}))
    : {};
  const url = grokBotUrl(mainBot.url);
  const botName = typeof mainBot.botName === "string" ? mainBot.botName.trim() : "";
  return decisions.map((kind, index) => {
    if (kind === "grok") {
      return { kind, url, ...(url && botName && botName.length <= 100 && { botName }) };
    }
    if (
      (kind === "needs_review" || kind === "unavailable") &&
      !isRestrictedMissionControlTask(requests[index]!)
    ) {
      return { kind: "claude" };
    }
    return { kind };
  });
}

async function routeWithJev(
  jev: JevDecider,
  requests: readonly MissionControlHandoffRequest[],
): Promise<readonly Route[]> {
  const key = (signal: string) => JSON.stringify([jev.revision, signal]);
  const signals = requests.map(routingCandidate);
  const missing = [
    ...new Set(
      signals.filter((signal): signal is string => signal !== null && !routes.has(key(signal))),
    ),
  ];
  for (let i = 0; i < missing.length; i += 10) {
    const batch = missing.slice(i, i + 10);
    const decisions = jev.decide(
      batch.map((signal, index) => `route_${index}: ${signal}`).join("\n"),
      Object.fromEntries(
        batch.map((signal, index) => [
          `route_${index}`,
          {
            type: "choice",
            instructions: `Classify only route_${index}. Follow an explicit agent request if supported. Use Grok Build for implementation, Claude for technical reasoning when offered, and the main Grok Bot for productivity, research, or outreach. Choose needs_review if the signals do not establish a task.`,
            criteria: routingChoices(signal),
          },
        ]),
      ),
    );
    batch.forEach((signal, index) => {
      const cacheKey = key(signal);
      routes.set(
        cacheKey,
        decisions.then(
          (data) => {
            const kind = pickRoute(data, `route_${index}`);
            return Object.hasOwn(routingChoices(signal), kind) ? kind : "needs_review";
          },
          () => {
            routes.delete(cacheKey);
            return "unavailable";
          },
        ),
      );
    });
  }
  const decisions = await Promise.all(
    requests.map(async (request, index) => {
      const signal = signals[index];
      if (!signal) return localRoute(request);
      const decision = (await routes.get(key(signal))) ?? "unavailable";
      return decision === "unavailable" ? localRoute(request) : decision;
    }),
  );
  while (routes.size > 256) routes.delete(routes.keys().next().value!);
  return decisions;
}
