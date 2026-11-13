import { addDays, addMonths, addWeeks, addYears } from "date-fns";
import { isValidTodoDate } from "./dates.ts";

const RECURRENCE_REGEX = /^\+?(\d+)([dwmy])$/;

/** Upper bound for `rec:` amounts so serialized values stay sane. */
export const MAX_RECURRENCE_AMOUNT = 9_999;

const INVALID_RECURRENCE_MESSAGE =
  "Invalid recurrence value; no new todo was created";
const OUT_OF_RANGE_RECURRENCE_MESSAGE =
  "Recurrence is out of range; no new todo was created";

type RecurrenceUnit = "d" | "w" | "m" | "y";

type ParsedRecurrence =
  | { amount: number; unit: RecurrenceUnit }
  | { error: string };

/**
 * Parse and validate a `rec:` value once, so `isValidRecurrence` and
 * `planRecurrence` cannot disagree about what is storable.
 */
const parseRecurrence = (value: unknown): ParsedRecurrence => {
  if (typeof value !== "string") {
    return { error: INVALID_RECURRENCE_MESSAGE };
  }

  const match = RECURRENCE_REGEX.exec(value);
  if (!match) {
    return { error: INVALID_RECURRENCE_MESSAGE };
  }

  const amount = Number(match[1]);
  if (
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    amount > MAX_RECURRENCE_AMOUNT
  ) {
    return { error: OUT_OF_RANGE_RECURRENCE_MESSAGE };
  }

  // The regex's second capture is restricted to d/w/m/y.
  return { amount, unit: match[2] as RecurrenceUnit };
};

/** True when `value` can be stored in a `rec:` tag. */
export const isValidRecurrence = (value: unknown): value is string =>
  !("error" in parseRecurrence(value));

/** Result of scheduling the next instance of a recurring todo. */
export type RecurrencePlan = { nextDue: Date } | { error: string };

/**
 * Resolve the next due date for a `rec:` value relative to `base`.
 *
 * `base` is required so the policy stays referentially transparent; callers
 * capture the completion clock once and pass it in. Invalid values never
 * throw; they return the same user-facing error strings the todo toggle flow
 * reports. Month/year arithmetic uses date-fns, which clamps month ends
 * instead of rolling over.
 */
export const planRecurrence = (value: unknown, base: Date): RecurrencePlan => {
  const parsed = parseRecurrence(value);
  if ("error" in parsed) {
    return { error: parsed.error };
  }

  const { amount, unit } = parsed;
  let nextDue: Date;
  switch (unit) {
    case "d":
      nextDue = addDays(base, amount);
      break;
    case "w":
      nextDue = addWeeks(base, amount);
      break;
    case "m":
      nextDue = addMonths(base, amount);
      break;
    case "y":
      nextDue = addYears(base, amount);
      break;
    default:
      // Unreachable for the current regex, but a future unit must not
      // silently fall back to years.
      return { error: INVALID_RECURRENCE_MESSAGE };
  }

  if (!isValidTodoDate(nextDue)) {
    return { error: OUT_OF_RANGE_RECURRENCE_MESSAGE };
  }

  return { nextDue };
};
