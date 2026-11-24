import type { UsageSummaryInput } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
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
