import { expect, test } from "vitest";

import { Todo } from "../logic/todo.ts";

test("addContext - adds context to todo without it", () => {
  const todo = new Todo("Buy groceries");
  const updated = todo.addContext("home");
  expect(updated.contexts.has("home")).toEqual(true);
  expect(updated.text.includes("@home")).toEqual(true);
});

test("addContext - does not duplicate existing context", () => {
  const todo = new Todo("Buy groceries @home");
  const updated = todo.addContext("home");
  expect(updated === todo).toEqual(true); // Same reference, no change
  expect(updated.text).toEqual("Buy groceries @home");
});

test("removeContext - removes context from todo", () => {
  const todo = new Todo("Buy groceries @home @work");
  const updated = todo.removeContext("home");
  expect(updated.contexts.has("home")).toEqual(false);
  expect(updated.contexts.has("work")).toEqual(true);
  expect(updated.text.includes("@home")).toEqual(false);
  expect(updated.text.includes("@work")).toEqual(true);
});

test("removeContext - does nothing if context not present", () => {
  const todo = new Todo("Buy groceries @work");
  const updated = todo.removeContext("home");
  expect(updated === todo).toEqual(true); // Same reference, no change
});

test("addProject - adds project to todo without it", () => {
  const todo = new Todo("Fix bug");
  const updated = todo.addProject("work");
  expect(updated.projects.has("work")).toEqual(true);
  expect(updated.text.includes("+work")).toEqual(true);
});

test("addProject - does not duplicate existing project", () => {
  const todo = new Todo("Fix bug +work");
  const updated = todo.addProject("work");
  expect(updated === todo).toEqual(true); // Same reference, no change
  expect(updated.text).toEqual("Fix bug +work");
});

test("removeProject - removes project from todo", () => {
  const todo = new Todo("Fix bug +work +personal");
  const updated = todo.removeProject("work");
  expect(updated.projects.has("work")).toEqual(false);
  expect(updated.projects.has("personal")).toEqual(true);
  expect(updated.text.includes("+work")).toEqual(false);
  expect(updated.text.includes("+personal")).toEqual(true);
});

test("removeProject - does nothing if project not present", () => {
  const todo = new Todo("Fix bug +personal");
  const updated = todo.removeProject("work");
  expect(updated === todo).toEqual(true); // Same reference, no change
});
