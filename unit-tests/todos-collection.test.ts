import { expect, test } from "vitest";

import { Todo } from "../logic/todo.ts";
import type { Todos } from "../logic/Todos.ts";

test("todos collections do not leak a Todos subclass", () => {
  const todos: Todos = [new Todo("one"), new Todo("two")];

  const filtered = todos.filter((todo) => todo.text === "one");
  expect(Array.isArray(filtered)).toBeTruthy();
  expect(Object.getPrototypeOf(filtered)).toEqual(Array.prototype);
  expect("sortByImportance" in filtered).toBe(false);
  expect("filterHidden" in filtered).toBe(false);

  const mapped = todos.map((todo) => todo.text);
  expect(Array.isArray(mapped)).toBeTruthy();
  expect(Object.getPrototypeOf(mapped)).toEqual(Array.prototype);
  expect("sortByImportance" in mapped).toBe(false);
  expect(mapped).toEqual(["one", "two"]);

  const sliced = todos.slice(0, 1);
  expect(Array.isArray(sliced)).toBeTruthy();
  expect(Object.getPrototypeOf(sliced)).toEqual(Array.prototype);
  expect("sortByImportance" in sliced).toBe(false);
});
