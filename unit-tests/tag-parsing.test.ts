import { expect, test } from "vitest";

import { Todo } from "../logic/todo.ts";

const tagLine = (count: number) =>
  `task ${Array.from({ length: count }, (_, index) => `ka:v${index}`).join(" ")}`;

test("tag parsing stays linear for 40k and 60k tags", () => {
  for (const count of [40_000, 60_000]) {
    const line = tagLine(count);
    const start = performance.now();
    const todo = new Todo(line);
    const elapsed = performance.now() - start;

    expect(todo.text).toEqual("task");
    expect(todo.tags.ka).toBeInstanceOf(Array);
    expect((todo.tags.ka as string[]).length).toEqual(count);
    // Generous ceiling: the quadratic parser took seconds at this size.
    expect(elapsed).toBeLessThan(2_000);
  }
});

test("tag parsing keeps duplicate values in first-seen order", () => {
  const todo = new Todo("a tag:one tag:two tag:two other:three");

  expect(todo.tags).toEqual({
    tag: ["one", "two", "two"],
    other: "three",
  });
  expect(Object.keys(todo.tags)).toEqual(["tag", "other"]);
  expect(todo.text).toEqual("a");
});

test("tag parsing removes every tag token and trims surrounding whitespace", () => {
  const todo = new Todo("tag:one   task   tag:two");

  expect(todo.tags).toEqual({ tag: ["one", "two"] });
  expect(todo.text).toEqual("task");
});

test("tag parsing keeps preserveTags semantics", () => {
  const preserved = new Todo("a rec:1d").setText("b", { preserveTags: true });
  expect(preserved.tags).toEqual({ rec: "1d" });
  expect(preserved.text).toEqual("b");

  const replaced = new Todo("a rec:1d").setText("b");
  expect(replaced.tags).toEqual({});
  expect(replaced.text).toEqual("b");
});

test("a 2000-character line with many tags parses quickly", () => {
  const line = tagLine(400).slice(0, 2_000);
  const start = performance.now();
  const todo = new Todo(line);
  const elapsed = performance.now() - start;

  expect(todo.text.startsWith("task")).toEqual(true);
  expect(elapsed).toBeLessThan(250);
});
