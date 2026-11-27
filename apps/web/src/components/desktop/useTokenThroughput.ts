import { useState } from "react";

import type { EnvironmentUsageStatus } from "../../state/usage";
import { addTokenSample, throughputFromSamples, type TokenSample } from "../MissionControl.logic";

/** Tokens per minute across the last minute of usage reads of today's total; null until then. */
export function useTokenThroughput(
  environments: readonly EnvironmentUsageStatus[],
  todayTokens: number | null,
): number | null {
  const readAtMs = Math.max(
    0,
    ...environments.map(({ summary }) => (summary ? Date.parse(summary.readAt) : 0)),
  );
  const [samples, setSamples] = useState<readonly TokenSample[]>([]);
  // Each new usage read joins the samples; the rate spans at least 45 seconds of them.
  if (todayTokens !== null && readAtMs > 0 && samples.at(-1)?.atMs !== readAtMs) {
    setSamples(addTokenSample(samples, { tokens: todayTokens, atMs: readAtMs }));
  }
  return throughputFromSamples(samples);
}
