import { expect, test } from "vitest";

import { addMonths, format } from "date-fns";

import { dateForOption, formatDateTag, parseDateTag } from "../logic/dates.ts";

test("parseDateTag - parses valid yyyy-MM-dd tags without timezone drift", () => {
  for (const value of [
    "2024-01-01",
    "2024-02-29",
    "1999-12-31",
    "3000-01-01",
    "2024-12-31",
  ]) {
    const parsed = parseDateTag(value);
    expect(parsed !== undefined, `expected ${value} to parse`).toEqual(true);
    expect(formatDateTag(parsed!)).toEqual(value);
    // Round-tripping through format (local time) must never shift the day.
    expect(format(parsed!, "yyyy-MM-dd")).toEqual(value);
  }
});

test("parseDateTag - rejects invalid and non-string values", () => {
  const invalidValues: unknown[] = [
    "",
    " ",
    "not-a-date",
    "2024-02-30",
    "2023-02-29",
    "2024-13-01",
    "2024-00-10",
    "2024-01-32",
    "2024-1-1",
    "24-01-01",
    "2024-01-01T10:00:00",
    "2024-01-01 due",
    undefined,
    null,
    20240101,
    {},
    ["2024-01-01"],
  ];

  for (const value of invalidValues) {
    expect(
      parseDateTag(value),
      `expected ${String(value)} to be rejected`,
    ).toEqual(undefined);
  }
});

test("parseDateTag - leap day is accepted only in leap years", () => {
  expect(formatDateTag(parseDateTag("2024-02-29")!)).toEqual("2024-02-29");
  expect(parseDateTag("2023-02-29")).toEqual(undefined);
  expect(parseDateTag("1900-02-29")).toEqual(undefined);
  expect(parseDateTag("2000-02-29") !== undefined).toEqual(true);
});

test("formatDateTag - uses the local calendar day", () => {
  expect(formatDateTag(new Date(2024, 0, 1))).toEqual("2024-01-01");
  expect(formatDateTag(new Date(2024, 0, 1, 23, 59, 59))).toEqual("2024-01-01");
  expect(formatDateTag(new Date(2024, 11, 31, 0, 0, 0))).toEqual("2024-12-31");
});

test("dateForOption - preserves existing option semantics", () => {
  const now = new Date(2024, 4, 15, 13, 45, 30);
  const today = formatDateTag(dateForOption("today", now));

  expect(today).toEqual("2024-05-15");
  expect(formatDateTag(dateForOption("tomorrow", now))).toEqual("2024-05-16");
  expect(formatDateTag(dateForOption("next-week", now))).toEqual("2024-05-22");
  expect(formatDateTag(dateForOption("next-month", now))).toEqual("2024-06-15");

  // Option dates are normalized to the start of the local day.
  const startOfToday = dateForOption("today", now);
  expect(startOfToday.getHours()).toEqual(0);
  expect(startOfToday.getMinutes()).toEqual(0);
  expect(startOfToday.getSeconds()).toEqual(0);
  expect(startOfToday.getMilliseconds()).toEqual(0);
});

test("dateForOption - month-end clamps instead of rolling into the next month", () => {
  // addMonths semantics: Jan 31 + 1 month = Feb 28/29, never March 2/3.
  const jan31 = new Date(2024, 0, 31, 15, 30);

  expect(formatDateTag(dateForOption("next-month", jan31))).toEqual(
    "2024-02-29",
  );
  expect(
    formatDateTag(dateForOption("next-month", new Date(2023, 0, 31))),
  ).toEqual("2023-02-28");
  expect(
    formatDateTag(dateForOption("next-month", new Date(2024, 2, 31))),
  ).toEqual("2024-04-30");
  expect(
    formatDateTag(dateForOption("next-month", new Date(2024, 4, 31))),
  ).toEqual("2024-06-30");

  // The modal's arithmetic is exactly date-fns addMonths, so month ends do not
  // silently roll over the way Date#setMonth does.
  expect(formatDateTag(dateForOption("next-month", jan31))).toEqual(
    formatDateTag(addMonths(jan31, 1)),
  );
});

test("dateForOption - handles leap day boundaries", () => {
  const feb28 = new Date(2024, 1, 28, 23, 0);
  expect(formatDateTag(dateForOption("tomorrow", feb28))).toEqual("2024-02-29");
  expect(
    formatDateTag(dateForOption("next-week", new Date(2024, 1, 22))),
  ).toEqual("2024-02-29");
  expect(
    formatDateTag(dateForOption("next-month", new Date(2024, 1, 29))),
  ).toEqual("2024-03-29");

  // Non-leap years skip Feb 29 entirely.
  expect(
    formatDateTag(dateForOption("tomorrow", new Date(2023, 1, 28))),
  ).toEqual("2023-03-01");
});
