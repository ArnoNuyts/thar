import { assertEquals } from "@std/assert";
import { createIndexes, IndexEntry } from "../logic/indexes.ts";
import {
  calculateScrollOffset,
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

Deno.test("guesstimateSelection: selects a newly added todo", () => {
  const [todo1, todo2] = todosOf("Todo 1", "Todo 2");
  const added = new Todo("Todo 3");
  const prevTodos = [todo1, todo2];
  const todos = [todo1, todo2, added];
  const indexes = indexesFor(todos);

  assertEquals(
    guesstimateSelection(todos, prevTodos, indexes, todo1.id),
    added.id,
  );
});

Deno.test("guesstimateSelection: keeps an explicit selection of an added todo", () => {
  const [todo1, todo2] = todosOf("Todo 1", "Todo 2");
  const added = new Todo("Todo 3");
  const prevTodos = [todo1, todo2];
  const todos = [todo1, todo2, added];
  const indexes = indexesFor(todos);

  assertEquals(
    guesstimateSelection(todos, prevTodos, indexes, added.id),
    undefined,
  );
});

Deno.test("guesstimateSelection: selects a modified todo when the cursor is elsewhere", () => {
  const [todo1, todo2] = todosOf("Todo 1", "Todo 2");
  const modified = todo1.setText("Todo 1 updated");
  const prevTodos = [todo1, todo2];
  const todos = [modified, todo2];
  const indexes = indexesFor(todos);

  assertEquals(
    guesstimateSelection(todos, prevTodos, indexes, todo2.id),
    modified.id,
  );
});

Deno.test("guesstimateSelection: keeps a cursor that is modified but still visible", () => {
  const [todo1, todo2] = todosOf("Todo 1", "Todo 2");
  const modified = todo1.setText("Todo 1 updated");
  const prevTodos = [todo1, todo2];
  const todos = [modified, todo2];
  const indexes = indexesFor(todos);

  assertEquals(
    guesstimateSelection(todos, prevTodos, indexes, modified.id),
    undefined,
  );
});

Deno.test("guesstimateSelection: does not guesstimate when every todo is new (reload)", () => {
  const prevTodos = todosOf("Todo 1", "Todo 2");
  const reloadedTodos = todosOf("Todo 1", "Todo 2");
  const indexes = indexesFor(reloadedTodos);

  assertEquals(
    guesstimateSelection(
      reloadedTodos,
      prevTodos,
      indexes,
      prevTodos[0].id,
    ),
    undefined,
  );
});

Deno.test("guesstimateSelection: returns undefined when nothing changed", () => {
  const todos = todosOf("Todo 1", "Todo 2");
  const indexes = indexesFor(todos);

  assertEquals(
    guesstimateSelection(todos, todos, indexes, todos[1].id),
    undefined,
  );
});

Deno.test("guesstimateSelection: returns undefined for a reordered list", () => {
  const [todo1, todo2] = todosOf("Todo 1", "Todo 2");
  const prevTodos = [todo1, todo2];
  const todos = [todo2, todo1];
  const indexes = indexesFor(todos);

  assertEquals(
    guesstimateSelection(todos, prevTodos, indexes, todo2.id),
    undefined,
  );
});

Deno.test("validateSelection: keeps a valid cursor", () => {
  const todos = todosOf("Todo 1", "Todo 2");
  const indexes = indexesFor(todos);

  assertEquals(
    validateSelection(todos[1].id, indexes, undefined, 0),
    todos[1].id,
  );
});

Deno.test("validateSelection: restores the cursor by hash", () => {
  const [todo1, todo2] = todosOf("Todo 1", "Todo 2");
  const indexes = indexesFor([todo1, todo2]);

  assertEquals(
    validateSelection(undefined, indexes, todo2.getHash(), 0),
    todo2.id,
  );
});

Deno.test("validateSelection: falls forward to the next todo from lastIndex", () => {
  const todos = todosOf("Todo A @A", "Todo B @B");
  const indexes = indexesFor(todos);

  // Row 0 is the first context header, not a todo.
  assertEquals(
    validateSelection(undefined, indexes, undefined, 0),
    todos[0].id,
  );
});

Deno.test("validateSelection: falls backward when no todo follows lastIndex", () => {
  const todo1 = new Todo("Todo 1");
  const indexes: IndexEntry[] = [
    contextEntry("None"),
    todoEntry(todo1, 1),
    contextEntry("Trailing"),
  ];

  assertEquals(
    validateSelection(undefined, indexes, undefined, indexes.length - 1),
    todo1.id,
  );
});

Deno.test("validateSelection: clamps an out-of-range lastIndex", () => {
  const todos = todosOf("Todo 1");
  const indexes = indexesFor(todos);

  assertEquals(
    validateSelection(undefined, indexes, undefined, 999),
    todos[0].id,
  );
});

Deno.test("validateSelection: returns undefined for empty indexes", () => {
  assertEquals(validateSelection(undefined, [], undefined, 0), undefined);
});

Deno.test("validateSelection: returns undefined when there are no todo entries", () => {
  const indexes = [contextEntry("None"), contextEntry("Other")];

  assertEquals(validateSelection(undefined, indexes, "hash", 1), undefined);
});

Deno.test("calculateScrollOffset: keeps the offset when the range fits", () => {
  assertEquals(
    calculateScrollOffset(5, { min: 5, max: 5 }, 0, 10, 30),
    0,
  );
});

Deno.test("calculateScrollOffset: scrolls to show a range larger than the viewport", () => {
  assertEquals(
    calculateScrollOffset(10, { min: 1, max: 20 }, 0, 10, 30),
    2,
  );
});

Deno.test("calculateScrollOffset: scrolls up when the cursor is above the viewport", () => {
  assertEquals(
    calculateScrollOffset(2, { min: 2, max: 2 }, 10, 10, 30),
    1,
  );
});

Deno.test("calculateScrollOffset: scrolls down when the cursor is below the viewport", () => {
  assertEquals(
    calculateScrollOffset(25, { min: 25, max: 25 }, 0, 10, 30),
    17,
  );
});

Deno.test("calculateScrollOffset: clamps at the start of the list", () => {
  assertEquals(
    calculateScrollOffset(0, { min: 0, max: 0 }, 5, 10, 30),
    0,
  );
});

Deno.test("calculateScrollOffset: clamps at the end of the list", () => {
  assertEquals(
    calculateScrollOffset(29, { min: 29, max: 29 }, 0, 10, 30),
    20,
  );
});

Deno.test("calculateScrollOffset: clamps to keep the whole range visible", () => {
  assertEquals(
    calculateScrollOffset(5, { min: 1, max: 5 }, 5, 10, 20),
    1,
  );
});

Deno.test("calculateScrollOffset: handles a list shorter than the viewport", () => {
  assertEquals(
    calculateScrollOffset(2, { min: 2, max: 2 }, 0, 10, 3),
    0,
  );
});
