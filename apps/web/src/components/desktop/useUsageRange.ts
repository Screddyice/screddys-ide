import { useEffect, useEffectEvent, useState } from "react";

import { currentUsageRange } from "./desktopUsageSnapshot";

const ROLL_OVER_MS = 60_000;

/**
 * The usage window behind every "today", "this week" and "30 days" total, shared with the menu bar.
 *
 * It moves to a new local date or time zone within a minute, whether or not any environment can be
 * read, so "today" starts over at midnight. `rollOver` does the same check on demand and returns the
 * window to read now.
 */
export function useUsageRange() {
  // Held in state: useUsage re-renders whenever its window object changes identity.
  const [range, setRange] = useState(currentUsageRange);
  const rollOver = useEffectEvent(() => {
    const next = currentUsageRange();
    if (
      next.month.untilDay === range.month.untilDay &&
      next.month.timeZone === range.month.timeZone
    ) {
      return range;
    }
    setRange(next);
    return next;
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Owns the timer that moves "today" to the next date while the caller is shown.
  useEffect(() => {
    const timer = window.setInterval(() => rollOver(), ROLL_OVER_MS);
    return () => window.clearInterval(timer);
  }, []);

  return { range, rollOver };
}
