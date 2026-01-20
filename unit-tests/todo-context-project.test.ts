import { assertEquals } from "@std/assert";
import { Todo } from "../logic/todo.ts";

Deno.test("addContext - adds context to todo without it", () => {
  const todo = new Todo("Buy groceries");
  const updated = todo.addContext("home");
  assertEquals(updated.contexts.has("home"), true);
  assertEquals(updated.text.includes("@home"), true);
});

Deno.test("addContext - does not duplicate existing context", () => {
  const todo = new Todo("Buy groceries @home");
  const updated = todo.addContext("home");
  assertEquals(updated === todo, true); // Same reference, no change
  assertEquals(updated.text, "Buy groceries @home");
});

Deno.test("removeContext - removes context from todo", () => {
  const todo = new Todo("Buy groceries @home @work");
  const updated = todo.removeContext("home");
  assertEquals(updated.contexts.has("home"), false);
  assertEquals(updated.contexts.has("work"), true);
  assertEquals(updated.text.includes("@home"), false);
  assertEquals(updated.text.includes("@work"), true);
});

Deno.test("removeContext - does nothing if context not present", () => {
  const todo = new Todo("Buy groceries @work");
  const updated = todo.removeContext("home");
  assertEquals(updated === todo, true); // Same reference, no change
});

Deno.test("addProject - adds project to todo without it", () => {
  const todo = new Todo("Fix bug");
  const updated = todo.addProject("work");
  assertEquals(updated.projects.has("work"), true);
  assertEquals(updated.text.includes("+work"), true);
});

Deno.test("addProject - does not duplicate existing project", () => {
  const todo = new Todo("Fix bug +work");
  const updated = todo.addProject("work");
  assertEquals(updated === todo, true); // Same reference, no change
  assertEquals(updated.text, "Fix bug +work");
});

Deno.test("removeProject - removes project from todo", () => {
  const todo = new Todo("Fix bug +work +personal");
  const updated = todo.removeProject("work");
  assertEquals(updated.projects.has("work"), false);
  assertEquals(updated.projects.has("personal"), true);
  assertEquals(updated.text.includes("+work"), false);
  assertEquals(updated.text.includes("+personal"), true);
});

Deno.test("removeProject - does nothing if project not present", () => {
  const todo = new Todo("Fix bug +personal");
  const updated = todo.removeProject("work");
  assertEquals(updated === todo, true); // Same reference, no change
});
