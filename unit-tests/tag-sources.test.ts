import { assertEquals } from "@std/assert";
import { Todo } from "../logic/todo.ts";
import { Todos } from "../logic/Todos.ts";
import { collectTagSources } from "../logic/tag-sources.ts";

Deno.test("tag-sources: collects unique sorted projects and contexts", () => {
  const todos = new Todos(
    new Todo("Task one +zeta +alpha @office @home"),
    new Todo("Task two +alpha @work"),
    new Todo("Task three"),
  );

  assertEquals(collectTagSources(todos), {
    projects: ["alpha", "zeta"],
    contexts: ["home", "office", "work"],
  });
});

Deno.test("tag-sources: returns empty lists for no todos", () => {
  assertEquals(collectTagSources(new Todos()), {
    projects: [],
    contexts: [],
  });
});
