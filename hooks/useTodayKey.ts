import { useEffect, useState } from "react";

/** Local calendar-day key; changes exactly once per day in the local timezone. */
export const getTodayKey = (now: Date = new Date()): string =>
  now.toDateString();

/** Milliseconds from `now` until the next local midnight (DST-aware). */
export const msUntilNextDay = (now: Date): number => {
  const nextMidnight = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
  );
  return Math.max(1, nextMidnight.getTime() - now.getTime());
};

/** Schedule `callback` for the next local midnight. Returns a cancel function. */
export const scheduleNextDay = (
  callback: () => void,
  now: Date = new Date(),
): (() => void) => {
  const timer = setTimeout(callback, msUntilNextDay(now));
  return () => clearTimeout(timer);
};

/**
 * Returns the current local day and re-renders at midnight.
 *
 * Todo rows are memoized, but overdue styling is time-dependent. Using the day
 * as part of the row key refreshes those rows exactly when the date rolls over,
 * without turning `isOverdue()` into a per-render prop.
 */
export const useTodayKey = (): string => {
  const [todayKey, setTodayKey] = useState(getTodayKey);

  useEffect(() => {
    // Re-scheduling after a change also recovers if the system clock was
    // adjusted while the app was running.
    return scheduleNextDay(() => setTodayKey(getTodayKey()));
  }, [todayKey]);

  return todayKey;
};
