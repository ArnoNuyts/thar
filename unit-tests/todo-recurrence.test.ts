import { expect, test, vi } from "vitest";

import { Todo } from "../logic/todo.ts";

test("setRecurrence - sets correctly", () => {
  const testCases = [
    { text: "todo", input: "1d", expected: "1d" },
    {
      text: "todo rec:2w",
      input: "1d",
      expected: "1d",
    },
  ];

  for (const { text, input, expected } of testCases) {
    const todo = new Todo(text);
    const updated = todo.setRecurrence(input);

    expect(updated.tags.rec, `Input "${input}" should be: ${expected}`).toEqual(
      expected,
    );
  }
});

const formatDate = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

test("toggleState - daily recurrence", () => {
  const todo = new Todo("todo rec:1d");
  const { recurring } = todo.toggleState();

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);

  expect(recurring?.tags.due).toEqual(formatDate(tomorrow));
});

test("toggleState - weekly recurrence", () => {
  const todo = new Todo("todo rec:1w");
  const { recurring } = todo.toggleState();

  const nextWeek = new Date();
  nextWeek.setDate(nextWeek.getDate() + 7);

  expect(recurring?.tags.due).toEqual(formatDate(nextWeek));
});

test("toggleState - monthly recurrence", () => {
  const todo = new Todo("todo rec:1m");
  const { recurring } = todo.toggleState();

  const nextMonth = new Date();
  nextMonth.setMonth(nextMonth.getMonth() + 1);

  expect(recurring!.tags.due).toEqual(formatDate(nextMonth));
});

test("toggleState - yearly recurrence", () => {
  const todo = new Todo("todo rec:1y");
  const { recurring } = todo.toggleState();

  const nextYear = new Date();
  nextYear.setFullYear(nextYear.getFullYear() + 1);

  expect(recurring?.tags.due).toEqual(formatDate(nextYear));
});

test("toggleState - accepts an explicit plus sign", () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date(2026, 0, 1, 12));
    const { recurring, recurrenceError } = new Todo(
      "todo rec:+2d",
    ).toggleState();

    expect(recurrenceError).toBeUndefined();
    expect(recurring?.tags.due).toEqual("2026-01-03");
  } finally {
    vi.useRealTimers();
  }
});

test("toggleState - rejects malformed recurrence values without throwing", () => {
  for (const recurrence of [
    "1dd",
    "1d2",
    "x1d",
    "d",
    "1",
    "-1d",
    "1D",
    "1 d",
    "0d",
    "01dd",
  ]) {
    const todo = new Todo(`todo rec:${recurrence}`);

    expect(() => todo.toggleState()).not.toThrow();
    const result = todo.toggleState();
    expect(result.updated.isDone()).toEqual(true);
    expect(result.recurring).toBeUndefined();
    expect(result.recurrenceError).toMatch(/recurrence/i);
  }
});

test("toggleState - out-of-range yearly and monthly recurrence does not throw", () => {
  for (const recurrence of [
    "999999999999y",
    "999999999999m",
    "999999999999d",
  ]) {
    const todo = new Todo(`task rec:${recurrence}`);

    expect(() => todo.toggleState()).not.toThrow();
    const result = todo.toggleState();
    expect(result.recurring).toBeUndefined();
    expect(result.updated.isDone()).toEqual(true);
    expect(result.recurrenceError).toMatch(/out of range/i);
    expect(result.updated.toString()).not.toMatch(/Invalid Date|NaN/);
  }
});

test("toggleState - monthly recurrence clamps to the end of the month", () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date(2024, 0, 31, 12));
    const { recurring } = new Todo("task rec:1m").toggleState();
    expect(recurring?.tags.due).toEqual("2024-02-29");
  } finally {
    vi.useRealTimers();
  }
});

test("toggleState - yearly recurrence clamps a leap day", () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date(2024, 1, 29, 12));
    const { recurring } = new Todo("task rec:1y").toggleState();
    expect(recurring?.tags.due).toEqual("2025-02-28");
  } finally {
    vi.useRealTimers();
  }
});
