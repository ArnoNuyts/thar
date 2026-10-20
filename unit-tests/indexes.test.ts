import { expect, test } from "vitest";

import { createIndexes } from "../logic/indexes.ts";
import { Todo } from "../logic/todo.ts";
import { IndexType } from "../types/enums.ts";

test("createIndexes preserves prior context count before uncategorized todo", () => {
  const indexes = createIndexes([
    new Todo("Context task @home"),
    new Todo("Plain task"),
  ]);

  expect(indexes.length).toEqual(4);

  expect(indexes[0].type).toEqual(IndexType.context);
  if (indexes[0].type !== IndexType.context) {
    throw new Error("Expected first entry to be a context header");
  }

  expect(indexes[0].contextName).toEqual("home");
  expect(indexes[0].todoCount).toEqual(1);

  expect(indexes[1].type).toEqual(IndexType.todo);
  expect(indexes[2].type).toEqual(IndexType.context);
  if (indexes[2].type !== IndexType.context) {
    throw new Error("Expected uncategorized todo to start a None header");
  }

  expect(indexes[2].contextName).toEqual("None");
  expect(indexes[2].todoCount).toEqual(1);

  expect(indexes[3].type).toEqual(IndexType.todo);
});
