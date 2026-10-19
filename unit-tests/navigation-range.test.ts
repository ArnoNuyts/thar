import { assertEquals } from "@std/assert";
import { IndexEntry } from "../logic/indexes.ts";
import { getSelectionRangeRows } from "../logic/selection.ts";
import { Todo } from "../logic/todo.ts";
import { IndexType } from "../types/enums.ts";

const todoEntry = (todo: Todo): IndexEntry => ({
  type: IndexType.todo,
  todo,
});

const contextEntry = (contextName: string): IndexEntry => ({
  type: IndexType.context,
  contextName,
  todoCount: 0,
});

const createIndexesFixture = (todos: Todo[]): IndexEntry[] => [
  contextEntry("None"),
  ...todos.map(todoEntry),
];

Deno.test("getSelectionRangeRows: no range falls back to the cursor row", () => {
  const todos = Array.from({ length: 3 }, (_, i) => new Todo(`Todo ${i}`));
  const indexes = createIndexesFixture(todos);

  assertEquals(getSelectionRangeRows(indexes, new Set(), 2), {
    min: 2,
    max: 2,
  });
});

Deno.test("getSelectionRangeRows: range before the cursor spans from range start to cursor", () => {
  const todos = Array.from({ length: 5 }, (_, i) => new Todo(`Todo ${i}`));
  const indexes = createIndexesFixture(todos);
  const rangeIds = new Set([todos[0].id, todos[1].id]);

  // Todos are at indexes 1 and 2; cursor is at index 4.
  assertEquals(getSelectionRangeRows(indexes, rangeIds, 4), {
    min: 1,
    max: 4,
  });
});

Deno.test("getSelectionRangeRows: range after the cursor spans from cursor to range end", () => {
  const todos = Array.from({ length: 5 }, (_, i) => new Todo(`Todo ${i}`));
  const indexes = createIndexesFixture(todos);
  const rangeIds = new Set([todos[3].id, todos[4].id]);

  // Cursor is at index 1; range ends at index 5.
  assertEquals(getSelectionRangeRows(indexes, rangeIds, 1), {
    min: 1,
    max: 5,
  });
});

Deno.test("getSelectionRangeRows: range spanning the cursor covers both ends", () => {
  const todos = Array.from({ length: 5 }, (_, i) => new Todo(`Todo ${i}`));
  const indexes = createIndexesFixture(todos);
  const rangeIds = new Set([todos[0].id, todos[4].id]);

  // Range endpoints at indexes 1 and 5, cursor in the middle at index 3.
  assertEquals(getSelectionRangeRows(indexes, rangeIds, 3), {
    min: 1,
    max: 5,
  });
});

Deno.test("getSelectionRangeRows: range with no visible rows falls back to the cursor row", () => {
  const todos = Array.from({ length: 3 }, (_, i) => new Todo(`Todo ${i}`));
  const indexes = createIndexesFixture(todos);
  const hiddenTodo = new Todo("Hidden");

  assertEquals(getSelectionRangeRows(indexes, new Set([hiddenTodo.id]), 2), {
    min: 2,
    max: 2,
  });
});

Deno.test("getSelectionRangeRows: empty indexes fall back to the cursor row", () => {
  const hiddenTodo = new Todo("Hidden");

  assertEquals(getSelectionRangeRows([], new Set([hiddenTodo.id]), 7), {
    min: 7,
    max: 7,
  });
});

Deno.test("getSelectionRangeRows: context entries are ignored when calculating rows", () => {
  const todos = Array.from({ length: 3 }, (_, i) => new Todo(`Todo ${i}`));
  const indexes: IndexEntry[] = [
    contextEntry("A"),
    todoEntry(todos[0]),
    contextEntry("B"),
    todoEntry(todos[1]),
    todoEntry(todos[2]),
  ];
  const rangeIds = new Set([todos[0].id, todos[2].id]);

  assertEquals(getSelectionRangeRows(indexes, rangeIds, 3), {
    min: 1,
    max: 4,
  });
});
