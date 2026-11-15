/**
 * Deterministic clock for the CP1 contract.
 *
 * `Done`, `isOverdue`, `isVisibleInOverview` and recurrence read ambient time,
 * so the harness pins it before the first fixture is parsed. The pinned value
 * is a local wall-clock time (`yyyy-MM-ddTHH:mm:ss`), which is exactly how the
 * CP0 corpus pins it (`vi.setSystemTime(new Date("2026-11-15T12:00:00"))`).
 *
 * Building the pinned instant from calendar components instead of
 * `Date.parse` keeps it stable even if a host ignores the `TZ` override that
 * `contract.ts` sets (UTC); the `clockLocal` field records the pinned wall
 * time either way.
 */

const CLOCK_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;

export interface PinnedClock {
  clockLocal: string;
  /** Epoch milliseconds of the pinned local wall time. */
  fixedTime: number;
}

const parseClock = (clockLocal: string): PinnedClock => {
  const match = CLOCK_PATTERN.exec(clockLocal);
  if (!match) {
    throw new Error(
      `Invalid --clock value ${JSON.stringify(clockLocal)}: expected yyyy-MM-ddTHH:mm:ss`,
    );
  }

  const [year, month, day, hours, minutes, seconds] = match
    .slice(1)
    .map((part) => Number(part));

  const date = new Date(year, month - 1, day, hours, minutes, seconds, 0);
  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hours ||
    date.getMinutes() !== minutes ||
    date.getSeconds() !== seconds
  ) {
    throw new Error(
      `Invalid --clock value ${JSON.stringify(clockLocal)}: not a real date and time`,
    );
  }

  return { clockLocal, fixedTime: date.getTime() };
};

/**
 * Replace the global `Date` with a subclass whose no-argument constructor and
 * `Date.now()` return the pinned instant. Explicit constructors
 * (`new Date(value)`, `new Date(y, m, d, ...)`) keep their normal behaviour,
 * and `instanceof Date` keeps working because the subclass extends the real
 * constructor.
 */
export const pinClock = (clockLocal: string): PinnedClock => {
  const pinned = parseClock(clockLocal);
  const fixedTime = pinned.fixedTime;

  class PinnedDate extends Date {
    constructor(...args: unknown[]) {
      if (args.length === 0) {
        super(fixedTime);
      } else {
        super(...(args as [number]));
      }
    }

    static now(): number {
      return fixedTime;
    }
  }

  globalThis.Date = PinnedDate as DateConstructor;
  return pinned;
};
