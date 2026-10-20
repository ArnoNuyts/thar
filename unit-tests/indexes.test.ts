import { assertEquals } from "@std/assert";
import { createIndexes } from "../logic/indexes.ts";
import { Todo } from "../logic/todo.ts";
import { IndexType } from "../types/enums.ts";

Deno.test("createIndexes preserves prior context count before uncategorized todo", () => {
  const indexes = createIndexes([
    new Todo("Context task @home"),
    new Todo("Plain task"),
  ]);

  assertEquals(indexes.length, 4);

  assertEquals(indexes[0].type, IndexType.context);
  if (indexes[0].type !== IndexType.context) {
    throw new Error("Expected first entry to be a context header");
  }

  assertEquals(indexes[0].contextName, "home");
  assertEquals(indexes[0].todoCount, 1);

  assertEquals(indexes[1].type, IndexType.todo);
  assertEquals(indexes[2].type, IndexType.context);
  if (indexes[2].type !== IndexType.context) {
    throw new Error("Expected uncategorized todo to start a None header");
  }

  assertEquals(indexes[2].contextName, "None");
  assertEquals(indexes[2].todoCount, 1);

  assertEquals(indexes[3].type, IndexType.todo);
});
