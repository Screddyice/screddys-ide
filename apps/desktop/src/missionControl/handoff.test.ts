import { describe, expect, it } from "vite-plus/test";

import {
  grokBotUrl,
  localRoute,
  routeItems,
  pickRoute,
  routingCandidate,
  routingChoices,
  routingInput,
} from "./handoff.ts";
import { teamTaskContext } from "./context.ts";

describe("Mission Control handoff", () => {
  it("sends only source and recognized work categories", () => {
    const privateTitle = "Fix build failure for private@example.test using token abc-123";
    expect(JSON.parse(routingInput({ source: "email", title: privateTitle }))).toEqual({
      source: "email",
      actions: ["implementation, debugging, or verification in a repository"],
    });
    expect(routingInput({ source: "email", title: privateTitle })).not.toMatch(/example|token|abc/);
  });

  it("keeps enough signal to distinguish work on an integration from using it", () => {
    expect(
      JSON.parse(
        routingInput({ source: "nebos", title: "Debug the HyperScale campaign integration" }),
      ).actions,
    ).toEqual([
      "implementation, debugging, or verification in a repository",
      "HyperScale outreach and prospecting operations",
    ]);
    expect(
      JSON.parse(routingInput({ source: "nebos", title: "Update a HyperScale campaign" })).actions,
    ).toEqual(["HyperScale outreach and prospecting operations"]);
  });

  it("uses an allowable high-confidence JEV choice and leaves uncertainty for review", () => {
    const response = (choice: string, probabilities: object) => ({
      answers: { route: { choice, probabilities } },
    });
    expect(pickRoute(response("grok", { grok: 0.93, needs_review: 0.07 }))).toBe("grok");
    expect(pickRoute(response("cursor", { cursor: 0.79, grok_build: 0.21 }))).toBe("needs_review");
    expect(pickRoute(response("claude", { claude: 0.99 }))).toBe("claude");
    expect(pickRoute(response("codex", { codex: 0.97, needs_review: 0.03 }))).toBe("codex");
    expect(pickRoute(response("grok_build", { grok_build: 0.82, cursor: 0.67 }))).toBe(
      "needs_review",
    );
    expect(pickRoute(response("unknown", { unknown: 1 }))).toBe("needs_review");
  });

  it("offers coding agents only for development and the main Grok Bot for productivity", () => {
    const choices = (title: string) =>
      Object.keys(routingChoices(routingCandidate({ source: "linear", title })!));
    expect(choices("Fix the failing build, then summarize the pull request")).toEqual([
      "grok_build",
      "needs_review",
    ]);
    expect(choices("Review the code in Cursor")).toEqual(["cursor", "needs_review"]);
    expect(choices("Debug the frontend in GPT-5.5")).toEqual(["codex", "needs_review"]);
    expect(choices("Review the code in Claude Code")).toEqual(["claude", "needs_review"]);
    expect(choices("Review the API design")).toEqual(["grok_build", "claude", "needs_review"]);
    expect(choices("Fix the text cursor in the frontend component")).toEqual([
      "grok_build",
      "needs_review",
    ]);
    expect(choices("Fix the calendar invite in Cursor")).toEqual(["grok", "needs_review"]);
    expect(choices("Follow up on the HyperScale campaign")).toEqual(["grok", "needs_review"]);
    expect(
      localRoute({ source: "email", title: "Status?", taskContext: { workflow: "productivity" } }),
    ).toBe("grok");
    expect(localRoute({ source: "tasks", title: "Fix the unit tests with Cursor" })).toBe("cursor");
    expect(localRoute({ source: "srcos", title: "Schedule confidential review" })).toBe(
      "needs_review",
    );
  });

  it("uses workflow metadata when titles are vague and keeps private and priority text local", () => {
    const title = "Follow up with a person@example.test";
    const taskContext = teamTaskContext(title, "HyperCrawl", [
      "public web research",
      "L2",
      "internal label",
    ]);
    const candidate = routingCandidate({ source: "linear", title, taskContext });
    expect(JSON.parse(candidate!)).toMatchObject({ product: "hypercrawl", workflow: "research" });
    expect(candidate).not.toMatch(/example|L2|internal label/);
    const personal = routingCandidate({ source: "tasks", title, taskContext });
    expect(JSON.parse(personal!)).toEqual({
      source: "tasks",
      actions: ["productivity such as replying, drafting, scheduling, or organizing"],
    });
    expect(personal).not.toMatch(/example|hypercrawl|L2|internal label/);
    expect(routingCandidate({ source: "email", title, taskContext })).toBeNull();
    expect(
      routingCandidate({
        source: "linear",
        title,
        taskContext: teamTaskContext(title, "HyperCrawl", [
          "public web research",
          "client-confidential",
        ]),
      }),
    ).toBeNull();
    expect(
      routingCandidate({
        source: "nebos",
        title: "Check again",
        taskContext: { activeWorkstream: true },
      }),
    ).toContain('"activeNebosWorkstream":true');
  });

  it("accepts only native Grok Bot conversation links for the main assistant", () => {
    expect(grokBotUrl("grokbot://app/v1/agent?id=test-agent")).toBe(
      "grokbot://app/v1/agent?id=test-agent",
    );
    for (const rejected of [
      "https://grok.com/chat/example",
      "https://grok.com/",
      "https://grok.com.evil.test/chat/example",
      "https://grok.com/chat/example?credential=secret",
      "https://user:pass@grok.com/chat/example",
      "grokbot://mcp/oauth/callback",
      "grokbot://app/v1/agent-invite?id=test-agent&token=secret",
      "grokbot://app/v1/agent?id=test-agent&prompt=unsafe",
      "grokbot://app/v1/agent?id=test-agent&id=another",
    ])
      expect(grokBotUrl(rejected)).toBeNull();
  });
});

it("routes Google Tasks and Linear development work locally without JEV", async () => {
  await expect(
    routeItems("/unconfigured", "/unconfigured", [
      { source: "tasks", title: "Fix the build failure" },
      { source: "linear", title: "Follow up", taskContext: { workflow: "implementation" } },
    ]),
  ).resolves.toEqual([{ kind: "grok_build" }, { kind: "grok_build" }]);
});
