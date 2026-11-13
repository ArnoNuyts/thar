import { expect, test, vi } from "vitest";
import {
  getTodayKey,
  msUntilNextDay,
  scheduleNextDay,
} from "../hooks/useTodayKey.ts";

test("getTodayKey: uses the local calendar day", () => {
  expect(getTodayKey(new Date(2026, 0, 1, 12))).toEqual(
    new Date(2026, 0, 1).toDateString(),
  );
  expect(getTodayKey(new Date(2026, 0, 2, 0))).not.toEqual(
    getTodayKey(new Date(2026, 0, 1, 23, 59, 59)),
  );
});

test("msUntilNextDay: measures to the next local midnight", () => {
  expect(msUntilNextDay(new Date(2026, 0, 1, 23, 59, 30))).toEqual(30_000);
  expect(msUntilNextDay(new Date(2026, 0, 1, 0, 0, 0))).toEqual(
    24 * 60 * 60 * 1000,
  );
  // Never schedule a zero-delay timer at midnight.
  expect(msUntilNextDay(new Date(2026, 0, 2, 0, 0, 0))).toBeGreaterThan(0);
});

test("scheduleNextDay: fires once at midnight and can be cancelled", () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date(2026, 0, 1, 23, 59, 30));
    const onMidnight = vi.fn();

    const cancel = scheduleNextDay(onMidnight);
    vi.advanceTimersByTime(29_999);
    expect(onMidnight).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onMidnight).toHaveBeenCalledTimes(1);

    const cancelled = vi.fn();
    const cancelCancelled = scheduleNextDay(cancelled);
    cancelCancelled();
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(cancelled).not.toHaveBeenCalled();

    cancel();
  } finally {
    vi.useRealTimers();
  }
});
