import type { MissionControlItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { gmailThread, prioritize, safeProviderUrl } from "./triage.ts";
import {
  contextualizePriority,
  personalFocusTerms,
  teamLaneOrder,
  teamTaskContext,
} from "./context.ts";

const address = "me@example.com";
const incoming = "Person <sender@example.com>";

function mail(
  sender: string,
  subject: string,
  time: number,
  labels: string[] = [],
  extra: { name: string; value: string }[] = [],
) {
  return {
    internalDate: String(time),
    labelIds: labels,
    payload: {
      headers: [{ name: "From", value: sender }, { name: "Subject", value: subject }, ...extra],
    },
  };
}

describe("Mission Control email triage", () => {
  it("uses the newest substantive message and sees a sent reply", () => {
    const inbound = mail(incoming, "Could you review tomorrow?", 10);
    const sent = mail(address, "Re: Could you review tomorrow?", 20, ["SENT"]);
    const next = mail(incoming, "Here is the revised version", 30);
    const draft = mail(address, "Draft", 40, ["DRAFT"]);
    expect(gmailThread([sent, inbound], address)?.needsReply).toBe(false);
    expect(gmailThread([sent, draft, next, inbound], address)?.needsReply).toBe(true);
    expect(gmailThread([draft, inbound], address)?.needsReply).toBe(true);
  });

  it("filters cold pitches and bulk messages even when they ask a question", () => {
    expect(
      gmailThread([mail(incoming, "Open to a quick demo?", 10, ["IMPORTANT"])], address)
        ?.needsReply,
    ).toBe(false);
    expect(
      gmailThread(
        [
          mail(
            incoming,
            "Can you confirm?",
            10,
            [],
            [{ name: "List-Unsubscribe", value: "opt-out" }],
          ),
        ],
        address,
      )?.needsReply,
    ).toBe(false);
    expect(
      gmailThread([mail("no-reply@example.com", "Please review", 10)], address)?.needsReply,
    ).toBe(false);
  });
});

it("puts due work and urgent issues ahead of routine recent messages", () => {
  const item: MissionControlItem = {
    id: "email",
    source: "email",
    account: "Personal",
    title: "Question",
    detail: "",
    url: null,
    activity: "2026-11-16T06:00:00Z",
    due: null,
    urgency: "normal",
  };
  expect(
    prioritize(
      [
        item,
        { ...item, id: "p1", source: "linear", urgency: "urgent" },
        { ...item, id: "due", source: "tasks", due: "2026-11-16" },
        { ...item, id: "soon", source: "tasks", due: "2026-11-18" },
      ],
      "2026-11-16",
    ).map(({ id }) => id),
  ).toEqual(["due", "p1", "soon", "email"]);
});

it("permits only HTTPS links on the expected provider", () => {
  expect(safeProviderUrl("https://team.slack.com/archives/1", "slack.com", true)).toBeTruthy();
  expect(safeProviderUrl("https://slack.com.evil.test/archives/1", "slack.com", true)).toBeNull();
  expect(safeProviderUrl("http://slack.com/archives/1", "slack.com", true)).toBeNull();
  expect(safeProviderUrl("https://user@slack.com/archives/1", "slack.com", true)).toBeNull();
});

it("orders team lanes across sources and applies pinned personal focus to SRCOS only", () => {
  const base: MissionControlItem = {
    id: "new",
    source: "linear",
    account: "Team Nebula",
    title: "Follow up on budget review",
    detail: "",
    url: null,
    activity: "2026-11-16T22:00:00Z",
    due: null,
    urgency: "normal",
  };
  const lanes = teamLaneOrder(
    "---\nns: tmn\ntenant: teamnebula\n---\nLane priority (founders' decision date): **L2 first, then L3.**",
  );
  const team = { lanes, workstreams: ["budget review"] };
  const personal = personalFocusTerms("- Priority: budget review\n- Priority: home repairs");
  const result = prioritize(
    [
      { ...base, id: "urgent", urgency: "urgent" },
      {
        ...base,
        id: "one",
        title: "Lane task",
        source: "nebos",
        taskContext: teamTaskContext("Lane task", "NEBOS", ["GTM-L2"]),
      },
      {
        ...base,
        id: "two",
        title: "Lane task",
        taskContext: teamTaskContext("Lane task", "HyperScale", ["L3"]),
      },
      { ...base, id: "personal", source: "srcos" },
      { ...base, id: "mail", source: "email" },
      { ...base, id: "workstream", source: "nebos" },
    ].map((item) => contextualizePriority(item as MissionControlItem, team, personal)),
    "2026-11-16",
    lanes,
  );
  expect(result.map(({ id }) => id)).toEqual([
    "urgent",
    "one",
    "two",
    "personal",
    "workstream",
    "mail",
  ]);
  expect(result.find(({ id }) => id === "personal")?.taskContext).toBeUndefined();
  expect(result.find(({ id }) => id === "workstream")?.taskContext).toEqual({
    activeWorkstream: true,
  });
  expect(result.find(({ id }) => id === "mail")?.priorityReason).toBeUndefined();
});
