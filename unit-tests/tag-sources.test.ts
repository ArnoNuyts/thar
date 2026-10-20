import { expect, test } from "vitest";

import { Todo } from "../logic/todo.ts";
import { collectTagSources } from "../logic/tag-sources.ts";

test("tag-sources: collects unique sorted projects and contexts", () => {
  const todos = [
    new Todo("Task one +zeta +alpha @office @home"),
    new Todo("Task two +alpha @work"),
    new Todo("Task three"),
  ];

  expect(collectTagSources(todos)).toEqual({
    projects: ["alpha", "zeta"],
    contexts: ["home", "office", "work"],
  });
});

test("tag-sources: returns empty lists for no todos", () => {
  expect(collectTagSources([])).toEqual({
    projects: [],
    contexts: [],
  });
});
