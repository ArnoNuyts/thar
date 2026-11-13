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

const DONE_PREFIX_REGEX = /^x\s+/;
const PRIORITY_PREFIX_REGEX = /^\([A-Z]\)\s+/;
const LEADING_DATE_TOKEN_REGEX = /^\d{4}-\d{2}-\d{2}(?=\s|$)/;
const WHITESPACE_PREFIX_REGEX = /^\s+/;

/**
 * Metadata discovered at the start of a todo line. Leading dates are only
 * consumed by `Todo` when they are valid and unambiguous; otherwise the raw
 * tokens stay in `text` so the line round-trips.
 */
export interface TodoPrefix {
  hasDoneMarker: boolean;
  priority?: string;
  /** Index of the first leading date token (after `x` and priority). */
  dateStartIndex: number;
  /** Index after the consumed leading date tokens and their whitespace. */
  endIndex: number;
  dateTokens: string[];
  invalidDateTokens: string[];
}

/** Scan the optional `x`, priority, and leading `yyyy-MM-dd` tokens. */
export const scanTodoPrefix = (text: string): TodoPrefix => {
  let index = 0;

  const doneMatch = DONE_PREFIX_REGEX.exec(text);
  const hasDoneMarker = doneMatch !== null;
  if (doneMatch) {
    index = doneMatch[0].length;
  }

  let priority: string | undefined;
  const priorityMatch = PRIORITY_PREFIX_REGEX.exec(text.slice(index));
  if (priorityMatch) {
    priority = priorityMatch[0][1];
    index += priorityMatch[0].length;
  }

  const dateStartIndex = index;
  const dateTokens: string[] = [];
  while (dateTokens.length < 2) {
    const token = LEADING_DATE_TOKEN_REGEX.exec(text.slice(index));
    if (!token) break;
    dateTokens.push(token[0]);
    index += token[0].length;
    const spacing = WHITESPACE_PREFIX_REGEX.exec(text.slice(index));
    if (spacing) {
      index += spacing[0].length;
    }
  }

  return {
    hasDoneMarker,
    priority,
    dateStartIndex,
    endIndex: index,
    dateTokens,
    invalidDateTokens: dateTokens.filter((token) => !parseDateTag(token)),
  };
};

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
  if (!isValid(date)) return undefined;
  // date-fns formats year 1 BCE as `0001`, so accepting year 0000 would
  // silently rewrite a loaded line. Keep the token literal instead.
  const year = date.getFullYear();
  return year >= 1 && year <= 9999 ? startOfDay(date) : undefined;
};

/** True for a valid Date whose local calendar year is 1..9999. */
export const isValidTodoDate = (date: Date): boolean => {
  if (!isValid(date)) return false;
  const year = date.getFullYear();
  return year >= 1 && year <= 9999;
};

/** Format a Date as a `yyyy-MM-dd` date-tag value in local time. */
export const formatDateTag = (date: Date): string => format(date, "yyyy-MM-dd");

/** Relative date choices offered by the date modal. */
export type DateOptionValue = "today" | "tomorrow" | "next-week" | "next-month";

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
