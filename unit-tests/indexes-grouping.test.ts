import { expect, test } from "vitest";

import {
  type ContextIndexEntry,
  createIndexes,
  type IndexEntry,
  type TodoIndexEntry,
} from "../logic/indexes.ts";
import { Todo } from "../logic/todo.ts";
import { filterHidden } from "../logic/Todos.ts";
import { IndexType } from "../types/enums.ts";

const createTodos = (...texts: string[]): Todo[] =>
  texts.map((text) => new Todo(text));

const contextHeaders = (entries: IndexEntry[]): ContextIndexEntry[] =>
  entries.filter(
    (entry): entry is ContextIndexEntry => entry.type === IndexType.context,
  );

const todoEntries = (entries: IndexEntry[]): TodoIndexEntry[] =>
  entries.filter(
    (entry): entry is TodoIndexEntry => entry.type === IndexType.todo,
  );

test("createIndexes returns no entries for no todos", () => {
  expect(createIndexes([])).toEqual([]);
});

test("createIndexes emits one header for a single context", () => {
  const entries = createIndexes(createTodos("one @home", "two @home"));

  expect(entries.length).toEqual(3);
  const headers = contextHeaders(entries);
  expect(headers.length).toEqual(1);
  expect(headers[0].contextName).toEqual("home");
  expect(headers[0].todoCount).toEqual(2);
  expect(todoEntries(entries).map((entry) => entry.number)).toEqual([1, 2]);
});

test("createIndexes emits a header per consecutive context group", () => {
  const entries = createIndexes(
    createTodos("one @home", "two @work", "three @work", "four @errand"),
  );

  const headers = contextHeaders(entries);
  expect(headers.map((header) => header.contextName)).toEqual([
    "home",
    "work",
    "errand",
  ]);
  expect(headers.map((header) => header.todoCount)).toEqual([1, 2, 1]);
  expect(todoEntries(entries).map((entry) => entry.number)).toEqual([
    1, 2, 3, 4,
  ]);
});

test("createIndexes emits a new header when a context repeats later", () => {
  const entries = createIndexes(
    createTodos("one @home", "two @work", "three @home"),
  );

  const headers = contextHeaders(entries);
  expect(headers.map((header) => header.contextName)).toEqual([
    "home",
    "work",
    "home",
  ]);
  expect(headers.map((header) => header.todoCount)).toEqual([1, 1, 1]);
  expect(todoEntries(entries).map((entry) => entry.number)).toEqual([1, 2, 3]);
});

test("createIndexes groups todos without a context under None", () => {
  const entries = createIndexes(
    createTodos("plain one", "plain two", "x done"),
  );

  const headers = contextHeaders(entries);
  expect(headers.length).toEqual(1);
  expect(headers[0].contextName).toEqual("None");
  expect(headers[0].todoCount).toEqual(3);
  expect(todoEntries(entries).map((entry) => entry.number)).toEqual([1, 2, 3]);
});

test("createIndexes reports the final count for every header", () => {
  const entries = createIndexes(
    createTodos("one @home", "two @home", "three @work", "four", "five"),
  );

  const headers = contextHeaders(entries);
  expect(headers.map((header) => header.contextName)).toEqual([
    "home",
    "work",
    "None",
  ]);
  expect(headers.map((header) => header.todoCount)).toEqual([2, 1, 2]);
});

test("createIndexes numbers todos consecutively after hidden filtering", () => {
  const todos = filterHidden(
    createTodos("one @home", "hidden h:1 @home", "three @work"),
  );

  const entries = createIndexes(todos);
  const numbers = todoEntries(entries).map((entry) => entry.number);

  expect(numbers).toEqual([1, 2]);
  expect(contextHeaders(entries).map((header) => header.todoCount)).toEqual([
    1, 1,
  ]);
});

test("identical todos get distinct ids, keys and numbers", () => {
  const entries = createIndexes(createTodos("Same text", "Same text"));
  const todos = todoEntries(entries);

  expect(todos.length).toEqual(2);
  expect(todos[0].todo.id === todos[1].todo.id).toEqual(false);
  expect(String(todos[0].todo.id) === String(todos[1].todo.id)).toEqual(false);
  expect(todos.map((entry) => entry.number)).toEqual([1, 2]);
});
