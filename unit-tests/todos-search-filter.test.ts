import { expect, test } from "vitest";

import { Todo } from "../logic/todo.ts";
import {
  filterBySearch,
  filterHidden,
  sortByImportance,
} from "../logic/Todos.ts";

const createTodos = (...texts: string[]): Todo[] =>
  texts.map((text) => new Todo(text));

const textsOf = (todos: Todo[]): string[] =>
  todos.map((todo) => todo.toString());

test("filterBySearch matches text and preserves order", () => {
  const todos = createTodos("buy milk", "walk dog", "milk chocolate");

  expect(textsOf(filterBySearch(todos, "milk"))).toEqual([
    "buy milk",
    "milk chocolate",
  ]);
});

test("filterBySearch matches text case-insensitively", () => {
  const todos = createTodos("Buy Milk", "walk dog");

  expect(textsOf(filterBySearch(todos, "MILK"))).toEqual(["Buy Milk"]);
  expect(textsOf(filterBySearch(todos, "milk"))).toEqual(["Buy Milk"]);
});

test("filterBySearch matches a @context", () => {
  const todos = createTodos("buy milk @home", "buy milk @work", "walk dog");

  expect(textsOf(filterBySearch(todos, "@home"))).toEqual(["buy milk @home"]);
  expect(textsOf(filterBySearch(todos, "@work"))).toEqual(["buy milk @work"]);
});

test("filterBySearch matches a +project", () => {
  const todos = createTodos("fix bug +work", "fix bug +side", "walk dog");

  expect(textsOf(filterBySearch(todos, "+work"))).toEqual(["fix bug +work"]);
  expect(textsOf(filterBySearch(todos, "+side"))).toEqual(["fix bug +side"]);
});

test("filterBySearch strips a leading @ or + before matching tags", () => {
  // Cross-prefix queries exercise the normalization path: "@work" is not in
  // the text of a todo tagged "+work", so only the normalized project match
  // can succeed (and vice versa for "+home" against "@home").
  const todos = createTodos("fix bug +work", "buy milk @home");

  expect(textsOf(filterBySearch(todos, "@work"))).toEqual(["fix bug +work"]);
  expect(textsOf(filterBySearch(todos, "+home"))).toEqual(["buy milk @home"]);
});

test("filterBySearch requires every term to match (AND)", () => {
  const todos = createTodos(
    "buy milk",
    "buy bread",
    "milk tea",
    "buy milk @home",
  );

  expect(textsOf(filterBySearch(todos, "buy milk"))).toEqual([
    "buy milk",
    "buy milk @home",
  ]);
  expect(textsOf(filterBySearch(todos, "buy milk @home"))).toEqual([
    "buy milk @home",
  ]);
});

test("filterBySearch returns no todos when nothing matches", () => {
  const todos = createTodos("buy milk @home", "walk dog +side");

  expect(filterBySearch(todos, "zzz")).toEqual([]);
});

test("filterBySearch returns the input array for an empty or whitespace query", () => {
  const todos = createTodos("buy milk @home", "walk dog +side");

  expect(filterBySearch(todos, "")).toBe(todos);
  expect(filterBySearch(todos, "   ")).toBe(todos);
});

test("filterBySearch composes with sortByImportance and filterHidden", () => {
  const todos = createTodos(
    "write report @work",
    "write report @home h:1",
    "x write report",
    "unrelated @work",
  );

  const visible = filterHidden(sortByImportance(todos));
  const results = filterBySearch(visible, "report");

  // The hidden matching todo is removed before search, and the remaining
  // matches keep the importance order (open before done).
  expect(textsOf(results)).toEqual(["write report @work", "x write report"]);
  expect(textsOf(visible)).toEqual([
    "write report @work",
    "unrelated @work",
    "x write report",
  ]);
});
