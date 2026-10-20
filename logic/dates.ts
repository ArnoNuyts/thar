import {
  addDays,
  addMonths,
  addWeeks,
  format,
  isValid,
  parseISO,
  startOfDay,
} from "date-fns";

/** Date tags (`due:`, `t:`) are stored as plain calendar days. */
const DATE_TAG_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse a `yyyy-MM-dd` date-tag value into a local Date at the start of that
 * day. Returns `undefined` for missing, malformed, or out-of-range values.
 *
 * Parsing date-only strings with `parseISO` keeps the calendar day intact in
 * every timezone; formatting the result with `format(date, "yyyy-MM-dd")`
 * round-trips the same day.
 */
export const parseDateTag = (value: unknown): Date | undefined => {
  if (typeof value !== "string" || !DATE_TAG_REGEX.test(value)) {
    return undefined;
  }
  const date = parseISO(value);
  return isValid(date) ? startOfDay(date) : undefined;
};

/** Format a Date as a `yyyy-MM-dd` date-tag value in local time. */
export const formatDateTag = (date: Date): string => format(date, "yyyy-MM-dd");

/** Relative date choices offered by the date modal. */
export type DateOptionValue =
  | "today"
  | "tomorrow"
  | "next-week"
  | "next-month";

/**
 * Resolve a relative date option against `now`, normalized to the start of the
 * local day.
 *
 * Month arithmetic uses `addMonths`, which clamps to the last day of the target
 * month: Jan 31 + 1 month is Feb 28 (or Feb 29 in a leap year), never March 2/3
 * as `Date#setMonth` would produce.
 */
export const dateForOption = (
  value: DateOptionValue,
  now: Date = new Date(),
): Date => {
  const base = startOfDay(now);
  switch (value) {
    case "tomorrow":
      return addDays(base, 1);
    case "next-week":
      return addWeeks(base, 1);
    case "next-month":
      return addMonths(base, 1);
    case "today":
    default:
      return base;
  }
};
