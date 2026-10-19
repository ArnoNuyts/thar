import { assertEquals } from "@std/assert";
import { addMonths, format } from "date-fns";

import { dateForOption, formatDateTag, parseDateTag } from "../logic/dates.ts";

Deno.test("parseDateTag - parses valid yyyy-MM-dd tags without timezone drift", () => {
  for (
    const value of [
      "2024-01-01",
      "2024-02-29",
      "1999-12-31",
      "3000-01-01",
      "2024-12-31",
    ]
  ) {
    const parsed = parseDateTag(value);
    assertEquals(parsed !== undefined, true, `expected ${value} to parse`);
    assertEquals(formatDateTag(parsed!), value);
    // Round-tripping through format (local time) must never shift the day.
    assertEquals(format(parsed!, "yyyy-MM-dd"), value);
  }
});

Deno.test("parseDateTag - rejects invalid and non-string values", () => {
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
    assertEquals(
      parseDateTag(value),
      undefined,
      `expected ${String(value)} to be rejected`,
    );
  }
});

Deno.test("parseDateTag - leap day is accepted only in leap years", () => {
  assertEquals(formatDateTag(parseDateTag("2024-02-29")!), "2024-02-29");
  assertEquals(parseDateTag("2023-02-29"), undefined);
  assertEquals(parseDateTag("1900-02-29"), undefined);
  assertEquals(parseDateTag("2000-02-29") !== undefined, true);
});

Deno.test("formatDateTag - uses the local calendar day", () => {
  assertEquals(formatDateTag(new Date(2024, 0, 1)), "2024-01-01");
  assertEquals(formatDateTag(new Date(2024, 0, 1, 23, 59, 59)), "2024-01-01");
  assertEquals(formatDateTag(new Date(2024, 11, 31, 0, 0, 0)), "2024-12-31");
});

Deno.test("dateForOption - preserves existing option semantics", () => {
  const now = new Date(2024, 4, 15, 13, 45, 30);
  const today = formatDateTag(dateForOption("today", now));

  assertEquals(today, "2024-05-15");
  assertEquals(formatDateTag(dateForOption("tomorrow", now)), "2024-05-16");
  assertEquals(formatDateTag(dateForOption("next-week", now)), "2024-05-22");
  assertEquals(formatDateTag(dateForOption("next-month", now)), "2024-06-15");

  // Option dates are normalized to the start of the local day.
  const startOfToday = dateForOption("today", now);
  assertEquals(startOfToday.getHours(), 0);
  assertEquals(startOfToday.getMinutes(), 0);
  assertEquals(startOfToday.getSeconds(), 0);
  assertEquals(startOfToday.getMilliseconds(), 0);
});

Deno.test("dateForOption - month-end clamps instead of rolling into the next month", () => {
  // addMonths semantics: Jan 31 + 1 month = Feb 28/29, never March 2/3.
  const jan31 = new Date(2024, 0, 31, 15, 30);

  assertEquals(
    formatDateTag(dateForOption("next-month", jan31)),
    "2024-02-29",
  );
  assertEquals(
    formatDateTag(dateForOption("next-month", new Date(2023, 0, 31))),
    "2023-02-28",
  );
  assertEquals(
    formatDateTag(dateForOption("next-month", new Date(2024, 2, 31))),
    "2024-04-30",
  );
  assertEquals(
    formatDateTag(dateForOption("next-month", new Date(2024, 4, 31))),
    "2024-06-30",
  );

  // The modal's arithmetic is exactly date-fns addMonths, so month ends do not
  // silently roll over the way Date#setMonth does.
  assertEquals(
    formatDateTag(dateForOption("next-month", jan31)),
    formatDateTag(addMonths(jan31, 1)),
  );
});

Deno.test("dateForOption - handles leap day boundaries", () => {
  const feb28 = new Date(2024, 1, 28, 23, 0);
  assertEquals(formatDateTag(dateForOption("tomorrow", feb28)), "2024-02-29");
  assertEquals(
    formatDateTag(dateForOption("next-week", new Date(2024, 1, 22))),
    "2024-02-29",
  );
  assertEquals(
    formatDateTag(dateForOption("next-month", new Date(2024, 1, 29))),
    "2024-03-29",
  );

  // Non-leap years skip Feb 29 entirely.
  assertEquals(
    formatDateTag(dateForOption("tomorrow", new Date(2023, 1, 28))),
    "2023-03-01",
  );
});
