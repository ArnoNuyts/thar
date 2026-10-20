import { assertEquals } from "@std/assert";
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

Deno.test("createIndexes returns no entries for no todos", () => {
  assertEquals(createIndexes([]), []);
});

Deno.test("createIndexes emits one header for a single context", () => {
  const entries = createIndexes(createTodos("one @home", "two @home"));

  assertEquals(entries.length, 3);
  const headers = contextHeaders(entries);
  assertEquals(headers.length, 1);
  assertEquals(headers[0].contextName, "home");
  assertEquals(headers[0].todoCount, 2);
  assertEquals(
    todoEntries(entries).map((entry) => entry.number),
    [1, 2],
  );
});

Deno.test("createIndexes emits a header per consecutive context group", () => {
  const entries = createIndexes(
    createTodos("one @home", "two @work", "three @work", "four @errand"),
  );

  const headers = contextHeaders(entries);
  assertEquals(
    headers.map((header) => header.contextName),
    ["home", "work", "errand"],
  );
  assertEquals(
    headers.map((header) => header.todoCount),
    [1, 2, 1],
  );
  assertEquals(
    todoEntries(entries).map((entry) => entry.number),
    [1, 2, 3, 4],
  );
});

Deno.test("createIndexes emits a new header when a context repeats later", () => {
  const entries = createIndexes(
    createTodos("one @home", "two @work", "three @home"),
  );

  const headers = contextHeaders(entries);
  assertEquals(
    headers.map((header) => header.contextName),
    ["home", "work", "home"],
  );
  assertEquals(
    headers.map((header) => header.todoCount),
    [1, 1, 1],
  );
  assertEquals(
    todoEntries(entries).map((entry) => entry.number),
    [1, 2, 3],
  );
});

Deno.test("createIndexes groups todos without a context under None", () => {
  const entries = createIndexes(
    createTodos("plain one", "plain two", "x done"),
  );

  const headers = contextHeaders(entries);
  assertEquals(headers.length, 1);
  assertEquals(headers[0].contextName, "None");
  assertEquals(headers[0].todoCount, 3);
  assertEquals(
    todoEntries(entries).map((entry) => entry.number),
    [1, 2, 3],
  );
});

Deno.test("createIndexes reports the final count for every header", () => {
  const entries = createIndexes(
    createTodos("one @home", "two @home", "three @work", "four", "five"),
  );

  const headers = contextHeaders(entries);
  assertEquals(
    headers.map((header) => header.contextName),
    ["home", "work", "None"],
  );
  assertEquals(
    headers.map((header) => header.todoCount),
    [2, 1, 2],
  );
});

Deno.test("createIndexes numbers todos consecutively after hidden filtering", () => {
  const todos = filterHidden(
    createTodos("one @home", "hidden h:1 @home", "three @work"),
  );

  const entries = createIndexes(todos);
  const numbers = todoEntries(entries).map((entry) => entry.number);

  assertEquals(numbers, [1, 2]);
  assertEquals(
    contextHeaders(entries).map((header) => header.todoCount),
    [1, 1],
  );
});

Deno.test("identical todos get distinct ids, keys and numbers", () => {
  const entries = createIndexes(createTodos("Same text", "Same text"));
  const todos = todoEntries(entries);

  assertEquals(todos.length, 2);
  assertEquals(todos[0].todo.id === todos[1].todo.id, false);
  assertEquals(String(todos[0].todo.id) === String(todos[1].todo.id), false);
  assertEquals(
    todos.map((entry) => entry.number),
    [1, 2],
  );
});
