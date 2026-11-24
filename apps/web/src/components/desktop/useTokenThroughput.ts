import { useState } from "react";

import type { EnvironmentUsageStatus } from "../../state/usage";
import { tokensPerMinute, type TokenSample } from "../MissionControl.logic";

/** Tokens per minute between the last two usage reads of today's total; null until two reads exist. */
export function useTokenThroughput(
  environments: readonly EnvironmentUsageStatus[],
  todayTokens: number | null,
): number | null {
  const readAtMs = Math.max(
    0,
    ...environments.map(({ summary }) => (summary ? Date.parse(summary.readAt) : 0)),
  );
  const [samples, setSamples] = useState<{
    readonly previous: TokenSample | null;
    readonly current: TokenSample | null;
  }>({ previous: null, current: null });
  // Each new usage read becomes the current sample and pushes the last one back.
  if (todayTokens !== null && readAtMs > 0 && samples.current?.atMs !== readAtMs) {
    setSamples({ previous: samples.current, current: { tokens: todayTokens, atMs: readAtMs } });
  }
  return tokensPerMinute(samples.previous, samples.current);
}
