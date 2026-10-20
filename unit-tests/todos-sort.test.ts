import { expect, test } from "vitest";

import { Todo } from "../logic/todo.ts";
import { sortByImportance } from "../logic/Todos.ts";

/**
 * The previous implementation chained four stable sorts. This is the same
 * algorithm, kept here as the reference the single comparator must match.
 */
const referenceSortByImportance = (todos: Todo[]): Todo[] =>
  [...todos]
    .sort((a, b) => {
      if (a.priority === undefined && b.priority === undefined) return 0;
      if (a.priority === undefined) return 1;
      if (b.priority === undefined) return -1;
      return a.priority.localeCompare(b.priority);
    })
    .sort((a, b) => (b.isOverdue() ? 1 : 0) - (a.isOverdue() ? 1 : 0))
    .sort((a, b) => {
      const aContext = [...a.contexts][0];
      const bContext = [...b.contexts][0];
      if (aContext === undefined && bContext === undefined) return 0;
      if (aContext === undefined) return -1;
      if (bContext === undefined) return 1;
      return aContext.localeCompare(bContext);
    })
    .sort((a, b) => a.state - b.state);

/** Deterministic linear congruential generator so failures are reproducible. */
const createRandom = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

const CONTEXTS = [undefined, "home", "work", "errand", "Zed", "alpha"];
const PRIORITIES = [undefined, "A", "B", "C", "D", undefined];
const DUE_DATES = [undefined, "2000-01-01", "2999-12-31"];

const createTodos = (count: number): Todo[] => {
  const random = createRandom(20261020);
  const pick = <T>(values: T[]): T =>
    values[Math.floor(random() * values.length)];

  return Array.from({ length: count }, (_, index) => {
    const done = pick([false, true]);
    const priority = pick(PRIORITIES);
    const context = pick(CONTEXTS);
    const due = pick(DUE_DATES);
    const text = [
      done ? "x" : "",
      priority ? `(${priority})` : "",
      `todo ${index}`,
      context ? `@${context}` : "",
      due ? `due:${due}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    return new Todo(text);
  });
};

test("sortByImportance matches the reference four-sort algorithm", () => {
  const todos = createTodos(250);

  const actual = sortByImportance(todos);
  const expected = referenceSortByImportance(todos);

  expect(actual.map((todo) => todo.id)).toEqual(
    expected.map((todo) => todo.id),
  );

  // Sort input must not be mutated.
  expect(todos.map((todo) => todo.toString())).toEqual(
    createTodos(250).map((todo) => todo.toString()),
  );
});

test("sortByImportance is stable for equal keys", () => {
  const todos = Array.from(
    { length: 25 },
    (_, index) => new Todo(`same text ${index}`),
  );
  const shuffled = [...todos].reverse();

  const sorted = sortByImportance(shuffled);

  expect(sorted.map((todo) => todo.id)).toEqual(
    shuffled.map((todo) => todo.id),
  );
  expect(sortByImportance(todos).map((todo) => todo.id)).toEqual(
    todos.map((todo) => todo.id),
  );
});
