import type { MissionControlItem } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { decideMissionControl } from "../../missionControl/jev.ts";
import {
  bindingsAt,
  readLinear,
  readMail,
  readSlack,
  readTasks,
  sharedContext,
} from "../../missionControl/sources.ts";
import { readSrcos } from "../../missionControl/srcos.ts";
import { readMissionControl } from "./missionControl.ts";

vi.mock("../../missionControl/sources.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../missionControl/sources.ts")>()),
  bindingsAt: vi.fn(async () => ({
    mail: [{ label: "Personal", selector: "test", email: "test@example.com" }],
    slack: "test",
    linear: "test",
    nebos: "test",
    tasks: "test",
    srcosTenant: "test",
    srcosCredentialFile: "/fixture/srcos.json",
    jevCommand: "/fixture/jev-launcher",
  })),
  connector: vi.fn(),
  readMail: vi.fn(),
  readSlack: vi.fn(),
  readTasks: vi.fn(),
  readLinear: vi.fn(async () => ({ items: [] })),
  readNebos: vi.fn(async () => ({ items: [] })),
  readNebosWorkstreams: vi.fn(async () => []),
  sharedContext: vi.fn(async () => []),
}));

vi.mock("../../missionControl/srcos.ts", () => ({
  readSrcos: vi.fn(async () => ({ items: [], context: "SRCOS guidance" })),
}));

vi.mock("../../missionControl/jev.ts", () => ({
  decideMissionControl: vi.fn(async () => ({})),
}));

function item(source: MissionControlItem["source"]) {
  return {
    id: source,
    source,
    account: "Fixture",
    title: `${source} fixture`,
    detail: "",
    url: "https://example.com",
    activity: "2026-11-16T22:00:00Z",
    due: null,
    urgency: "normal",
  } satisfies MissionControlItem;
}

it("returns focused priorities while the aggregate mail read is still pending", async () => {
  const email = Promise.withResolvers<Awaited<ReturnType<typeof readMail>>>();
  vi.mocked(readMail).mockReturnValue(email.promise);
  vi.mocked(readSlack).mockResolvedValue({ items: [item("slack")], partial: true });
  vi.mocked(readTasks).mockResolvedValue({ items: [item("tasks")] });
  const now = Date.parse("2026-11-16T22:00:00Z");

  const all = readMissionControl(
    "/fixture",
    "/fixture/all",
    { view: "priorities", refresh: false },
    now,
  );
  await vi.waitFor(() => expect(readMail).toHaveBeenCalledTimes(1));
  try {
    const slack = await readMissionControl(
      "/fixture",
      "/fixture/all",
      { view: "priorities", filter: "slack", refresh: false },
      now,
    );
    expect(slack.items).toEqual([item("slack")]);
    expect(slack.sources).toMatchObject([{ source: "slack", state: "partial" }]);
    expect(readSlack).toHaveBeenCalledTimes(1);

    const personal = await readMissionControl(
      "/fixture",
      "/fixture/personal",
      { view: "priorities", filter: "tasks", refresh: false },
      now,
    );
    expect(personal.items).toEqual([item("tasks")]);
    expect(personal.sources).toMatchObject([{ source: "tasks", state: "ready" }]);
    expect(personal.srcosContext).toBeNull();
    expect(readSrcos).toHaveBeenCalledTimes(1);
    expect(readMail).toHaveBeenCalledTimes(1);
  } finally {
    email.resolve({
      items: [{ ...item("email"), source: "email", canReply: true }],
      nextCursor: null,
      partial: false,
      note: "",
    });
  }
  expect((await all).items.map(({ source }) => source)).toEqual(
    expect.arrayContaining(["email", "slack", "tasks"]),
  );
});

it("ranks live-feed tasks with bounded JEV signals and preserves deadlines", async () => {
  vi.mocked(decideMissionControl)
    .mockClear()
    .mockImplementation(async (_home, _command, signals) => ({
      answers: Object.fromEntries(
        signals
          .split("\n")
          .map((line) => [
            line.slice(0, line.indexOf(":")),
            { type: "score", score: line.includes("implementation") ? 2.8 : 1, confidence: 0.9 },
          ]),
      ),
    }));
  vi.mocked(readTasks).mockResolvedValue({
    items: [
      { ...item("tasks"), id: "followup", title: "Follow up with private@example.com" },
      {
        ...item("tasks"),
        id: "fix",
        title: "Fix the build failure",
        detail: "internal fixture detail",
        activity: "2026-11-15T22:00:00Z",
      },
      { ...item("tasks"), id: "deadline", title: "Schedule a meeting", due: "2026-11-16" },
      { ...item("tasks"), id: "restricted", title: "Review confidential code" },
    ],
  });
  const home = "/fixture/personal-jev";
  const request = { view: "priorities", filter: "tasks", refresh: false } as const;
  const now = Date.parse("2026-11-16T22:00:00Z");
  const response = await readMissionControl(home, home, request, now);
  expect(response.items.slice(0, 2).map(({ id }) => id)).toEqual(["deadline", "fix"]);
  expect(response.priorityScoredCount).toBe(3);
  expect(decideMissionControl).toHaveBeenCalledTimes(1);
  const params = vi.mocked(decideMissionControl).mock.calls[0]!;
  expect(params[0]).toBe(home);
  expect(params[1]).toBe("/fixture/jev-launcher");
  expect(params[2]).not.toMatch(/private@example|internal fixture detail|confidential|2026-11-16/);

  await readMissionControl(home, home, request, now);
  expect(decideMissionControl).toHaveBeenCalledTimes(1);
});

it("leaves workspace sources disabled without explicit local bindings", async () => {
  vi.mocked(bindingsAt).mockResolvedValueOnce({
    mail: [],
    slack: "",
    linear: "",
    nebos: "",
    tasks: "",
    srcosTenant: "fixture-tenant",
  });
  vi.mocked(readLinear).mockClear();
  vi.mocked(readSrcos).mockClear();
  vi.mocked(sharedContext).mockClear();
  const response = await readMissionControl(
    "/fixture",
    "/fixture/clean",
    { view: "priorities", refresh: true },
    Date.parse("2026-11-16T22:00:00Z"),
  );
  expect(response).toMatchObject({ configured: false, items: [], sources: [] });
  expect(readLinear).not.toHaveBeenCalled();
  expect(readSrcos).not.toHaveBeenCalled();
  expect(sharedContext).not.toHaveBeenCalled();
});

it("uses local priorities without a configured JEV command", async () => {
  const configured = (await bindingsAt("/fixture"))!;
  vi.mocked(bindingsAt).mockResolvedValueOnce({ ...configured, jevCommand: undefined });
  vi.mocked(decideMissionControl).mockClear();
  vi.mocked(readTasks).mockResolvedValue({
    items: [{ ...item("tasks"), title: "Fix the build failure" }],
  });
  const response = await readMissionControl(
    "/fixture",
    "/fixture/local-priority",
    { view: "priorities", filter: "tasks", refresh: false },
    Date.parse("2026-11-16T22:00:00Z"),
  );
  expect(response.items).toHaveLength(1);
  expect(response.priorityScoredCount).toBe(0);
  expect(decideMissionControl).not.toHaveBeenCalled();
});
