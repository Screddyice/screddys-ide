import {
  OrchestratorMcpFailure,
  type ProjectId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

import { activeProjectPeers, isProjectPeer } from "../../../orchestration-v2/ProjectWorkContext.ts";
import { threadLinkFor } from "../../McpInvocationContext.ts";
import { assertLiveCaller, readCaller, unavailable } from "../../threadAccess.ts";

type Claim = {
  readonly projectId: ProjectId;
  readonly runId: RunId;
  readonly paths: ReadonlyArray<string>;
};

const overlaps = (left: string, right: string) =>
  left === "." ||
  right === "." ||
  left === right ||
  left.startsWith(`${right}/`) ||
  right.startsWith(`${left}/`);

const pathKey = (value: string) => {
  const path = value.trim();
  if (path.startsWith("/") || /[:\\\p{C}]/u.test(path) || path.split("/").includes(".."))
    return null;
  const normalized = path
    .split("/")
    .filter((part) => part !== "" && part !== ".")
    .join("/");
  return normalized || (path === "." ? "." : null);
};

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

// The toolkit owns one table for this environment. A claim expires with its run.
export const makeProjectWork = Effect.gen(function* () {
  const lane = yield* Semaphore.make(1);
  const claims = new Map<ThreadId, Claim>();

  const snapshot = Effect.gen(function* () {
    const context = yield* readCaller();
    const { caller, scope, threads } = context;
    if (caller === undefined) return yield* invalid("Open this tool from a project thread.");
    const project = yield* threads
      .listProjectThreads({
        projectId: caller.projectId,
        includeSubagents: true,
        includeSideChats: true,
      })
      .pipe(Effect.mapError(unavailable));
    const activeRuns = new Map(project.map((thread) => [thread.id, thread.activeRunId]));
    for (const [threadId, claim] of claims) {
      if (claim.projectId === caller.projectId && activeRuns.get(threadId) !== claim.runId) {
        claims.delete(threadId);
      }
    }
    const matching = project.filter((thread) => isProjectPeer(caller, thread));
    return { ...context, caller, scope, matching };
  });

  const read = () =>
    lane.withPermit(
      Effect.gen(function* () {
        const { caller, scope, matching } = yield* snapshot;
        const peers = activeProjectPeers(caller, matching).map((thread) => ({
          threadId: thread.id,
          link: threadLinkFor(scope, thread.id, thread.title),
          title: thread.title,
          model: thread.modelSelection.model,
          branch: thread.branch,
          status: thread.activityRunStatus ?? thread.status,
          paths:
            (claims.get(thread.id)?.runId === thread.activeRunId
              ? claims.get(thread.id)?.paths
              : undefined) ?? [],
        }));
        return { projectId: caller.projectId, threads: peers };
      }),
    );

  const change = (input: {
    readonly action: "claim" | "release";
    readonly paths?: ReadonlyArray<string> | undefined;
  }) =>
    lane.withPermit(
      Effect.gen(function* () {
        const context = yield* snapshot;
        yield* assertLiveCaller(context);
        const { caller, matching, scope } = context;
        const runId = caller.activeRunId;
        if (
          runId === null ||
          !matching.some(
            (thread) =>
              thread.id === caller.id &&
              thread.activeRunId === runId &&
              thread.providerInstanceId === caller.providerInstanceId,
          )
        ) {
          return yield* invalid("A claim needs an active run.");
        }
        if (input.action === "release") {
          claims.delete(caller.id);
          return { status: "released" as const };
        }
        const paths = [...new Set((input.paths ?? []).map(pathKey))];
        if (paths.length === 0 || paths.some((path) => path === null))
          return yield* invalid(
            "Supply project-relative file or directory paths without parent traversal.",
          );
        const existing = claims.get(caller.id);
        const normalized = [
          ...new Set([
            ...(existing?.runId === runId ? existing.paths : []),
            ...paths.filter((path): path is string => path !== null),
          ]),
        ];
        if (normalized.length > 24) return yield* invalid("A thread can claim up to 24 paths.");
        const conflicts = matching.flatMap((thread) => {
          if (thread.id === caller.id) return [];
          const claim = claims.get(thread.id);
          if (claim === undefined || claim.runId !== thread.activeRunId) return [];
          const covered = claim.paths.filter((path) =>
            normalized.some((next) => overlaps(path, next)),
          );
          return covered.length === 0
            ? []
            : [
                {
                  threadId: thread.id,
                  link: threadLinkFor(scope, thread.id, thread.title),
                  paths: covered,
                },
              ];
        });
        if (conflicts.length > 0) return { status: "conflict" as const, conflicts };
        claims.set(caller.id, { projectId: caller.projectId, runId, paths: normalized });
        return { status: "claimed" as const, paths: normalized };
      }),
    );

  return { read, change };
});
