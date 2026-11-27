import type { UsageSummaryInput } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../test/render";
import type { UsageView } from "../state/usage";

const usage = vi.hoisted(() => ({ windows: [] as unknown[] }));
vi.mock("../state/usage", () => ({
  mergeAnsweredUsage: () => ({ buckets: [] }),
  useUsage: (input: UsageSummaryInput) => {
    usage.windows.push(input);
    return { environments: [], refresh: async () => {} } as unknown as UsageView;
  },
}));

import { MissionControlTokenBar } from "./MissionControlTokenBar";
import { useUsageRange } from "./desktop/useUsageRange";

/** Shows the date "today" refers to, like Agent activity's per-provider totals. */
function TodayProbe() {
  const { range } = useUsageRange();
  return <p>{`Today is ${range.month.untilDay}`}</p>;
}

it("moves the shared usage window to the new day on its own timer", async () => {
  using _timers = fakeTimers();
  // Local time, so the test means the same thing in every runner's time zone.
  vi.setSystemTime(new Date(2026, 10, 27, 23, 59, 30));
  await using screen = await render(<TodayProbe />, { router: false });
  expect(screen.container.textContent).toBe("Today is 2026-11-27");
  vi.setSystemTime(new Date(2026, 10, 28, 0, 0, 30));
  await act(() => vi.advanceTimersByTime(60_000));
  expect(screen.container.textContent).toBe("Today is 2026-11-28");
});

it("asks for the same usage window object on every render", async () => {
  usage.windows.length = 0;
  // router: false -- the bar reads no route state.
  await using screen = await render(<MissionControlTokenBar />, { router: false });
  await screen.rerender(<MissionControlTokenBar />);
  await screen.rerender(<MissionControlTokenBar />);
  // useUsage re-renders whenever its window object changes identity, so a fresh one each render never settles.
  expect(usage.windows.length).toBeGreaterThan(1);
  expect(new Set(usage.windows).size).toBe(1);
});

it("moves today's total to the new day after midnight even with no environment connected", async () => {
  usage.windows.length = 0;
  using _timers = fakeTimers();
  vi.setSystemTime(new Date(2026, 10, 27, 23, 59, 30));
  await using _screen = await render(<MissionControlTokenBar />, { router: false });
  expect((usage.windows.at(-1) as UsageSummaryInput).untilDay).toBe("2026-11-27");
  vi.setSystemTime(new Date(2026, 10, 28, 0, 0, 30));
  await act(() => vi.advanceTimersByTime(60_000));
  expect((usage.windows.at(-1) as UsageSummaryInput).untilDay).toBe("2026-11-28");
});
