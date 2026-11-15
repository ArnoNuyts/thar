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

export class InvalidClockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidClockError";
  }
}

const parseClock = (clockLocal: string): PinnedClock => {
  const match = CLOCK_PATTERN.exec(clockLocal);
  if (!match) {
    throw new InvalidClockError(
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
    throw new InvalidClockError(
      `Invalid --clock value ${JSON.stringify(clockLocal)}: not a real date and time`,
    );
  }

  return { clockLocal, fixedTime: date.getTime() };
};

/**
 * The real constructor, captured once. Every pin subclasses this and never the
 * previously installed pin, so repeated calls cannot nest `Date` subclasses.
 */
const RealDate = globalThis.Date;

/** Build a `Date` subclass whose no-argument form returns `fixedTime`. */
const createPinnedDate = (fixedTime: number): DateConstructor => {
  class PinnedDate extends RealDate {
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
  return PinnedDate as unknown as DateConstructor;
};

let installed: { clock: PinnedClock; ctor: DateConstructor } | undefined;

/**
 * Replace the global `Date` with a subclass whose no-argument constructor and
 * `Date.now()` return the pinned instant. Explicit constructors
 * (`new Date(value)`, `new Date(y, m, d, ...)`) keep their normal behaviour,
 * and `instanceof Date` keeps working because the subclass extends the real
 * constructor.
 *
 * Idempotent: pinning the same wall time twice leaves the installed
 * constructor untouched (no nested subclasses), and pinning a different time
 * replaces it with a fresh subclass of the original `Date`. Re-pinning after
 * `globalThis.Date` was restored reinstalls the pin.
 */
export const pinClock = (clockLocal: string): PinnedClock => {
  const pinned = parseClock(clockLocal);

  if (
    installed !== undefined &&
    installed.clock.clockLocal === pinned.clockLocal &&
    globalThis.Date === installed.ctor
  ) {
    return installed.clock;
  }

  const ctor = createPinnedDate(pinned.fixedTime);
  globalThis.Date = ctor;
  installed = { clock: pinned, ctor };
  return pinned;
};
