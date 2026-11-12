import { expect, test } from "vitest";
import { isValid } from "date-fns";

import { Todo } from "../logic/todo.ts";
import { TodoInputError, validateTodoText } from "../logic/todo-input.ts";

const IMPOSSIBLE_DATES = [
  "2024-13-01",
  "2024-02-30",
  "2024-00-00",
  "2024-01-39",
];

test("impossible leading dates stay literal and round-trip", () => {
  for (const token of IMPOSSIBLE_DATES) {
    const input = `${token} impossible`;
    const todo = new Todo(input);

    expect(todo.toString()).toEqual(input);
    expect(todo.text).toEqual(input);
    expect(todo.invalidDateTokens).toEqual([token]);
    expect(todo.creationDate).toBeUndefined();
    expect(todo.completionDate).toBeUndefined();
  }
});

test("impossible completion dates on done lines stay literal", () => {
  for (const token of IMPOSSIBLE_DATES) {
    const input = `x ${token} completed`;
    const todo = new Todo(input);

    expect(todo.toString()).toEqual(input);
    expect(todo.invalidDateTokens).toEqual([token]);
    expect(todo.completionDate).toBeUndefined();
    expect(() => todo.toString()).not.toThrow();
  }
});

test("a done line with one invalid and one valid date is not duplicated or dropped", () => {
  const input = "x 2024-02-30 2024-01-01 done";
  const todo = new Todo(input);

  expect(todo.toString()).toEqual(input);
  expect(todo.invalidDateTokens).toEqual(["2024-02-30"]);
  expect(todo.completionDate).toBeUndefined();
  // The valid token is still exposed, but serialized exactly once as text.
  expect(todo.creationDate).toBeInstanceOf(Date);
  expect(isValid(todo.creationDate!)).toEqual(true);
  expect(todo.toString().match(/2024-01-01/g)).toHaveLength(1);
  expect(todo.toString().match(/2024-02-30/g)).toHaveLength(1);
});

test("a done line with a valid completion and invalid creation date round-trips", () => {
  const input = "x 2024-01-01 2024-02-30 done";
  const todo = new Todo(input);

  expect(todo.toString()).toEqual(input);
  expect(todo.invalidDateTokens).toEqual(["2024-02-30"]);
  expect(todo.completionDate?.getFullYear()).toEqual(2024);
  expect(todo.creationDate).toBeUndefined();
});

test("valid done lines still parse completion and creation dates", () => {
  const todo = new Todo("x 2024-01-02 2024-01-01 done");

  expect(todo.toString()).toEqual("x 2024-01-02 2024-01-01 done");
  expect(todo.invalidDateTokens).toEqual([]);
  expect(todo.completionDate?.getFullYear()).toEqual(2024);
  expect(todo.completionDate?.getMonth()).toEqual(0);
  expect(todo.completionDate?.getDate()).toEqual(2);
  expect(todo.creationDate?.getDate()).toEqual(1);
});

test("an open todo with two leading dates preserves both tokens", () => {
  const input = "2026-01-01 2026-01-02 task";
  const todo = new Todo(input);

  expect(todo.toString()).toEqual(input);
  expect(todo.text).toEqual(input);
  expect(todo.creationDate).toBeUndefined();
  expect(todo.invalidDateTokens).toEqual([]);
});

test("an open todo with one valid leading date still parses it", () => {
  const todo = new Todo("2026-01-01 task");

  expect(todo.toString()).toEqual("2026-01-01 task");
  expect(todo.text).toEqual("task");
  expect(todo.creationDate?.getFullYear()).toEqual(2026);
});

test("odd loaded lines survive an unrelated edit without throwing", () => {
  for (const input of [
    ...IMPOSSIBLE_DATES.map((token) => `${token} impossible`),
    "x 2024-02-30 2024-01-01 done",
    "2026-01-01 2026-01-02 task",
  ]) {
    const todo = new Todo(input);
    const edited = todo.setPriority("A").setRecurrence("1d").setText(todo.text);

    expect(() => edited.toString()).not.toThrow();
    expect(edited.toString()).toContain(todo.text);
  }
});

test("write validation rejects impossible and ambiguous leading dates", () => {
  for (const token of IMPOSSIBLE_DATES) {
    expect(() => validateTodoText(`${token} new`)).toThrow(TodoInputError);
    expect(() => validateTodoText(`${token} new`)).toThrow(/impossible date/i);
  }

  expect(() => validateTodoText("2026-01-01 2026-01-02 new")).toThrow(
    TodoInputError,
  );
  expect(() => validateTodoText("2026-01-01 2026-01-02 new")).toThrow(
    /more than one date/i,
  );
});

test("setters ignore invalid dates instead of throwing", () => {
  const invalid = new Date(Number.NaN);
  const todo = new Todo("task");

  expect(() => todo.setDue(invalid)).not.toThrow();
  expect(() => todo.setThreshold(invalid)).not.toThrow();
  expect(() => todo.setCreationDate(invalid)).not.toThrow();
  expect(() => todo.setCompletionDate(invalid)).not.toThrow();

  expect(todo.setDue(invalid).tags.due).toBeUndefined();
  expect(todo.setThreshold(invalid).tags.t).toBeUndefined();
  expect(todo.setCreationDate(invalid).creationDate).toBeUndefined();
  expect(todo.setCompletionDate(invalid).completionDate).toBeUndefined();
  expect(todo.toString()).toEqual("task");
});
