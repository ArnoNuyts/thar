import { expect, test } from "vitest";

import { createIndexes, IndexEntry } from "../logic/indexes.ts";
import {
  calculateScrollOffset,
  findTodoRow,
  getNavigableRow,
  guesstimateSelection,
  validateSelection,
} from "../logic/navigation.ts";
import { Todo } from "../logic/todo.ts";
import type { Todos } from "../logic/Todos.ts";
import { IndexType } from "../types/enums.ts";

const todosOf = (...texts: string[]): Todos =>
  texts.map((text) => new Todo(text));

const indexesFor = (todos: Todos): IndexEntry[] => createIndexes(todos);

const todoEntry = (todo: Todo, number: number): IndexEntry => ({
  type: IndexType.todo,
  todo,
  number,
});

const contextEntry = (contextName: string): IndexEntry => ({
  type: IndexType.context,
  contextName,
  todoCount: 0,
});

test("getNavigableRow: skips context headers in the direction of travel", () => {
  const [todo1, todo2] = todosOf("Todo 1", "Todo 2");
  const indexes = [
    contextEntry("A"),
    todoEntry(todo1, 1),
    contextEntry("B"),
    todoEntry(todo2, 2),
  ];

  expect(getNavigableRow(indexes, 1, 1)).toEqual(3);
  expect(getNavigableRow(indexes, 3, -1)).toEqual(1);
});

test("getNavigableRow: stays on first todo when a leading header is crossed", () => {
  const [todo1, todo2] = todosOf("Todo 1", "Todo 2");
  const indexes = [contextEntry("A"), todoEntry(todo1, 1), todoEntry(todo2, 2)];

  expect(getNavigableRow(indexes, 1, -1)).toEqual(1);
  expect(getNavigableRow(indexes, 1, -5)).toEqual(1);
});

test("getNavigableRow: stays on last todo when a trailing header is crossed", () => {
  const [todo1, todo2] = todosOf("Todo 1", "Todo 2");
  const indexes = [
    contextEntry("A"),
    todoEntry(todo1, 1),
    todoEntry(todo2, 2),
    contextEntry("B"),
  ];

  expect(getNavigableRow(indexes, 2, 1)).toEqual(2);
  expect(getNavigableRow(indexes, 2, 5)).toEqual(2);
});

test("getNavigableRow: clamps without wrapping past the list bounds", () => {
  const [todo1, todo2] = todosOf("Todo 1", "Todo 2");
  const indexes = [contextEntry("A"), todoEntry(todo1, 1), todoEntry(todo2, 2)];

  expect(getNavigableRow(indexes, 1, -3)).toEqual(1);
  expect(getNavigableRow(indexes, 2, 3)).toEqual(2);
});

test("guesstimateSelection: selects a newly added todo", () => {
  const [todo1, todo2] = todosOf("Todo 1", "Todo 2");
  const added = new Todo("Todo 3");
  const prevTodos = [todo1, todo2];
  const todos = [todo1, todo2, added];
  const indexes = indexesFor(todos);

  expect(guesstimateSelection(todos, prevTodos, indexes, todo1.id)).toEqual(
    added.id,
  );
});

test("guesstimateSelection: keeps an explicit selection of an added todo", () => {
  const [todo1, todo2] = todosOf("Todo 1", "Todo 2");
  const added = new Todo("Todo 3");
  const prevTodos = [todo1, todo2];
  const todos = [todo1, todo2, added];
  const indexes = indexesFor(todos);

  expect(guesstimateSelection(todos, prevTodos, indexes, added.id)).toEqual(
    undefined,
  );
});

test("guesstimateSelection: selects a modified todo when the cursor is elsewhere", () => {
  const [todo1, todo2] = todosOf("Todo 1", "Todo 2");
  const modified = todo1.setText("Todo 1 updated");
  const prevTodos = [todo1, todo2];
  const todos = [modified, todo2];
  const indexes = indexesFor(todos);

  expect(guesstimateSelection(todos, prevTodos, indexes, todo2.id)).toEqual(
    modified.id,
  );
});

test("guesstimateSelection: keeps a cursor that is modified but still visible", () => {
  const [todo1, todo2] = todosOf("Todo 1", "Todo 2");
  const modified = todo1.setText("Todo 1 updated");
  const prevTodos = [todo1, todo2];
  const todos = [modified, todo2];
  const indexes = indexesFor(todos);

  expect(guesstimateSelection(todos, prevTodos, indexes, modified.id)).toEqual(
    undefined,
  );
});

test("guesstimateSelection: does not guesstimate when every todo is new (reload)", () => {
  const prevTodos = todosOf("Todo 1", "Todo 2");
  const reloadedTodos = todosOf("Todo 1", "Todo 2");
  const indexes = indexesFor(reloadedTodos);

  expect(
    guesstimateSelection(reloadedTodos, prevTodos, indexes, prevTodos[0].id),
  ).toEqual(undefined);
});

test("guesstimateSelection: returns undefined when nothing changed", () => {
  const todos = todosOf("Todo 1", "Todo 2");
  const indexes = indexesFor(todos);

  expect(guesstimateSelection(todos, todos, indexes, todos[1].id)).toEqual(
    undefined,
  );
});

test("guesstimateSelection: returns undefined for a reordered list", () => {
  const [todo1, todo2] = todosOf("Todo 1", "Todo 2");
  const prevTodos = [todo1, todo2];
  const todos = [todo2, todo1];
  const indexes = indexesFor(todos);

  expect(guesstimateSelection(todos, prevTodos, indexes, todo2.id)).toEqual(
    undefined,
  );
});

test("validateSelection: keeps a valid cursor", () => {
  const todos = todosOf("Todo 1", "Todo 2");
  const indexes = indexesFor(todos);

  expect(validateSelection(todos[1].id, indexes, undefined, 0)).toEqual(
    todos[1].id,
  );
});

test("validateSelection: keeps a valid cursor through the lastIndex fast path", () => {
  const todos = todosOf("Todo 1", "Todo 2");
  const indexes = indexesFor(todos);
  const row = indexes.findIndex(
    (entry) => entry.type === IndexType.todo && entry.todo.id === todos[1].id,
  );

  expect(validateSelection(todos[1].id, indexes, undefined, row)).toEqual(
    todos[1].id,
  );
});

test("validateSelection: ignores a stale lastIndex pointing at another todo", () => {
  const todos = todosOf("Todo 1", "Todo 2");
  const indexes = indexesFor(todos);

  // The fast path must verify the row's id instead of trusting the position.
  expect(validateSelection(todos[0].id, indexes, undefined, 2)).toEqual(
    todos[0].id,
  );
});

test("findTodoRow: returns lastIndex when it holds the cursor", () => {
  const todos = todosOf("Todo 1", "Todo 2");
  const indexes = indexesFor(todos);

  expect(findTodoRow(indexes, todos[1].id, 2)).toEqual(2);
});

test("findTodoRow: scans when lastIndex points at a header", () => {
  const todos = todosOf("Todo 1", "Todo 2");
  const indexes = indexesFor(todos);

  expect(findTodoRow(indexes, todos[1].id, 0)).toEqual(2);
});

test("findTodoRow: returns -1 for missing ids", () => {
  const todos = todosOf("Todo 1");
  const indexes = indexesFor(todos);

  expect(findTodoRow(indexes, undefined, 0)).toEqual(-1);
  expect(findTodoRow(indexes, new Todo("Not visible").id, 1)).toEqual(-1);
});

test("validateSelection: restores the cursor by hash", () => {
  const [todo1, todo2] = todosOf("Todo 1", "Todo 2");
  const indexes = indexesFor([todo1, todo2]);

  expect(validateSelection(undefined, indexes, todo2.getHash(), 0)).toEqual(
    todo2.id,
  );
});

test("validateSelection: falls forward to the next todo from lastIndex", () => {
  const todos = todosOf("Todo A @A", "Todo B @B");
  const indexes = indexesFor(todos);

  // Row 0 is the first context header, not a todo.
  expect(validateSelection(undefined, indexes, undefined, 0)).toEqual(
    todos[0].id,
  );
});

test("validateSelection: falls backward when no todo follows lastIndex", () => {
  const todo1 = new Todo("Todo 1");
  const indexes: IndexEntry[] = [
    contextEntry("None"),
    todoEntry(todo1, 1),
    contextEntry("Trailing"),
  ];

  expect(
    validateSelection(undefined, indexes, undefined, indexes.length - 1),
  ).toEqual(todo1.id);
});

test("validateSelection: clamps an out-of-range lastIndex", () => {
  const todos = todosOf("Todo 1");
  const indexes = indexesFor(todos);

  expect(validateSelection(undefined, indexes, undefined, 999)).toEqual(
    todos[0].id,
  );
});

test("validateSelection: returns undefined for empty indexes", () => {
  expect(validateSelection(undefined, [], undefined, 0)).toEqual(undefined);
});

test("validateSelection: returns undefined when there are no todo entries", () => {
  const indexes = [contextEntry("None"), contextEntry("Other")];

  expect(validateSelection(undefined, indexes, "hash", 1)).toEqual(undefined);
});

test("calculateScrollOffset: keeps the offset when the range fits", () => {
  expect(calculateScrollOffset(5, { min: 5, max: 5 }, 0, 10, 30)).toEqual(0);
});

test("calculateScrollOffset: scrolls to show a range larger than the viewport", () => {
  expect(calculateScrollOffset(10, { min: 1, max: 20 }, 0, 10, 30)).toEqual(2);
});

test("calculateScrollOffset: scrolls up when the cursor is above the viewport", () => {
  expect(calculateScrollOffset(2, { min: 2, max: 2 }, 10, 10, 30)).toEqual(1);
});

test("calculateScrollOffset: scrolls down when the cursor is below the viewport", () => {
  expect(calculateScrollOffset(25, { min: 25, max: 25 }, 0, 10, 30)).toEqual(
    17,
  );
});

test("calculateScrollOffset: clamps at the start of the list", () => {
  expect(calculateScrollOffset(0, { min: 0, max: 0 }, 5, 10, 30)).toEqual(0);
});

test("calculateScrollOffset: clamps at the end of the list", () => {
  expect(calculateScrollOffset(29, { min: 29, max: 29 }, 0, 10, 30)).toEqual(
    20,
  );
});

test("calculateScrollOffset: clamps to keep the whole range visible", () => {
  expect(calculateScrollOffset(5, { min: 1, max: 5 }, 5, 10, 20)).toEqual(1);
});

test("calculateScrollOffset: handles a list shorter than the viewport", () => {
  expect(calculateScrollOffset(2, { min: 2, max: 2 }, 0, 10, 3)).toEqual(0);
});
