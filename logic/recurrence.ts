import { addDays, addMonths, addWeeks, addYears, isValid } from "date-fns";

const RECURRENCE_REGEX = /^\+?(\d+)([dwmy])$/;

/** Upper bound for `rec:` amounts so serialized values stay sane. */
export const MAX_RECURRENCE_AMOUNT = 9_999;

const INVALID_RECURRENCE_MESSAGE =
  "Invalid recurrence value; no new todo was created";
const OUT_OF_RANGE_RECURRENCE_MESSAGE =
  "Recurrence is out of range; no new todo was created";

/** True when `value` can be stored in a `rec:` tag. */
export const isValidRecurrence = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const match = RECURRENCE_REGEX.exec(value);
  if (!match) return false;
  const amount = Number(match[1]);
  return (
    Number.isSafeInteger(amount) &&
    amount > 0 &&
    amount <= MAX_RECURRENCE_AMOUNT
  );
};

/** Result of scheduling the next instance of a recurring todo. */
export type RecurrencePlan = { nextDue: Date } | { error: string };

const isValidDueDate = (date: Date): boolean => {
  if (!isValid(date)) return false;
  const year = date.getFullYear();
  return year >= 1 && year <= 9999;
};

/**
 * Resolve the next due date for a `rec:` value relative to `base`.
 *
 * Invalid values never throw; they return the same user-facing error strings
 * the todo toggle flow reports. Month/year arithmetic uses date-fns, which
 * clamps month ends instead of rolling over.
 */
export const planRecurrence = (
  value: unknown,
  base: Date = new Date(),
): RecurrencePlan => {
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

  let nextDue: Date;
  switch (match[2]) {
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
    default:
      nextDue = addYears(base, amount);
      break;
  }

  if (!isValidDueDate(nextDue)) {
    return { error: OUT_OF_RANGE_RECURRENCE_MESSAGE };
  }

  return { nextDue };
};
