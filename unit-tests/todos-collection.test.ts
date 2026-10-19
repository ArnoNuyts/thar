import { assert, assertEquals, assertFalse } from "@std/assert";
import { Todo } from "../logic/todo.ts";
import type { Todos } from "../logic/Todos.ts";

Deno.test("todos collections do not leak a Todos subclass", () => {
  const todos: Todos = [new Todo("one"), new Todo("two")];

  const filtered = todos.filter((todo) => todo.text === "one");
  assert(Array.isArray(filtered));
  assertEquals(Object.getPrototypeOf(filtered), Array.prototype);
  assertFalse("sortByImportance" in filtered);
  assertFalse("filterHidden" in filtered);

  const mapped = todos.map((todo) => todo.text);
  assert(Array.isArray(mapped));
  assertEquals(Object.getPrototypeOf(mapped), Array.prototype);
  assertFalse("sortByImportance" in mapped);
  assertEquals(mapped, ["one", "two"]);

  const sliced = todos.slice(0, 1);
  assert(Array.isArray(sliced));
  assertEquals(Object.getPrototypeOf(sliced), Array.prototype);
  assertFalse("sortByImportance" in sliced);
});
