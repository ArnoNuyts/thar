import { expect, test } from "vitest";

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
