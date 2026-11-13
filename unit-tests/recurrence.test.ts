import { expect, test } from "vitest";

import { formatDateTag } from "../logic/dates.ts";
import {
  isValidRecurrence,
  MAX_RECURRENCE_AMOUNT,
  planRecurrence,
} from "../logic/recurrence.ts";

const INVALID_RECURRENCE_MESSAGE =
  "Invalid recurrence value; no new todo was created";
const OUT_OF_RANGE_RECURRENCE_MESSAGE =
  "Recurrence is out of range; no new todo was created";

const base = new Date(2026, 0, 15, 13, 45, 30);

test("planRecurrence - schedules daily, weekly, monthly, and yearly intervals", () => {
  const cases = [
    { value: "1d", expected: "2026-01-16" },
    { value: "2w", expected: "2026-01-29" },
    { value: "1m", expected: "2026-02-15" },
    { value: "1y", expected: "2027-01-15" },
    { value: "+2d", expected: "2026-01-17" },
  ];

  for (const { value, expected } of cases) {
    const plan = planRecurrence(value, base);
    expect("nextDue" in plan, `expected ${value} to plan`).toEqual(true);
    if ("nextDue" in plan) {
      expect(formatDateTag(plan.nextDue)).toEqual(expected);
    }
  }
});

test("planRecurrence - accepts the 1 and 9999 amount bounds", () => {
  const lower = planRecurrence("1d", base);
  expect("nextDue" in lower).toEqual(true);

  const upperValue = `${MAX_RECURRENCE_AMOUNT}d`;
  expect(isValidRecurrence(upperValue)).toEqual(true);
  const upper = planRecurrence(upperValue, base);
  expect("nextDue" in upper).toEqual(true);
  if ("nextDue" in upper) {
    expect(formatDateTag(upper.nextDue)).toEqual("2053-06-01");
  }
});

test("planRecurrence - rejects zero, negative, and above-maximum amounts", () => {
  expect(planRecurrence("0d", base)).toEqual({
    error: OUT_OF_RANGE_RECURRENCE_MESSAGE,
  });
  expect(planRecurrence("00w", base)).toEqual({
    error: OUT_OF_RANGE_RECURRENCE_MESSAGE,
  });
  expect(planRecurrence("-1d", base)).toEqual({
    error: INVALID_RECURRENCE_MESSAGE,
  });
  expect(planRecurrence(`${MAX_RECURRENCE_AMOUNT + 1}d`, base)).toEqual({
    error: OUT_OF_RANGE_RECURRENCE_MESSAGE,
  });
});

test("planRecurrence - rejects non-numeric, uppercase, and malformed values", () => {
  for (const value of [
    "",
    "d",
    "1",
    "x1d",
    "1dd",
    "1d2",
    "1 d",
    "01dd",
    "1D",
    "1W",
    "abc",
  ]) {
    expect(planRecurrence(value, base), `value ${value}`).toEqual({
      error: INVALID_RECURRENCE_MESSAGE,
    });
  }
});

test("planRecurrence - rejects non-string values", () => {
  const values: unknown[] = [undefined, null, 1, ["1d"], { rec: "1d" }, true];

  for (const value of values) {
    expect(planRecurrence(value, base), `value ${String(value)}`).toEqual({
      error: INVALID_RECURRENCE_MESSAGE,
    });
  }
});

test("planRecurrence - reports year overflow as out of range", () => {
  expect(planRecurrence("1y", new Date(9999, 0, 1, 12))).toEqual({
    error: OUT_OF_RANGE_RECURRENCE_MESSAGE,
  });
  expect(planRecurrence("1m", new Date(9999, 11, 1, 12))).toEqual({
    error: OUT_OF_RANGE_RECURRENCE_MESSAGE,
  });
  expect(planRecurrence("1w", new Date(9999, 11, 31, 12))).toEqual({
    error: OUT_OF_RANGE_RECURRENCE_MESSAGE,
  });
  expect(planRecurrence("1d", new Date(9999, 11, 31, 12))).toEqual({
    error: OUT_OF_RANGE_RECURRENCE_MESSAGE,
  });
});

test("planRecurrence - clamps month ends and leap days", () => {
  const leapYearJan31 = new Date(2024, 0, 31, 12);
  const leapMonth = planRecurrence("1m", leapYearJan31);
  expect("nextDue" in leapMonth && formatDateTag(leapMonth.nextDue)).toEqual(
    "2024-02-29",
  );

  const nonLeapYearJan31 = new Date(2026, 0, 31, 12);
  const nonLeapMonth = planRecurrence("1m", nonLeapYearJan31);
  expect(
    "nextDue" in nonLeapMonth && formatDateTag(nonLeapMonth.nextDue),
  ).toEqual("2026-02-28");

  const leapDay = new Date(2024, 1, 29, 12);
  const year = planRecurrence("1y", leapDay);
  expect("nextDue" in year && formatDateTag(year.nextDue)).toEqual(
    "2025-02-28",
  );
});

test("isValidRecurrence - validates storable rec values", () => {
  expect(isValidRecurrence("+2d")).toEqual(true);
  expect(isValidRecurrence("9999y")).toEqual(true);
  expect(isValidRecurrence(2)).toEqual(false);
  expect(isValidRecurrence("0d")).toEqual(false);
  expect(isValidRecurrence("10000d")).toEqual(false);
  expect(isValidRecurrence("1D")).toEqual(false);
});
