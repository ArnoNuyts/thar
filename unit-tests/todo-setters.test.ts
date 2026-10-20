import { expect, test } from "vitest";
import { format } from "date-fns";

import { Todo } from "../logic/todo.ts";
import { TodoStateEnum } from "../types/enums.ts";
import { UpperCaseLetter } from "../types/types.ts";

// Includes projects, contexts, scalar tags, an array-valued tag, and every
// tag manipulated by a setter so each case starts from the same rich state.
const FIXTURE =
  "task +project @context rec:1d due:2024-01-01 t:2024-01-01 multi:one multi:two h:1";

const date = new Date(2024, 5, 15);

function makeTodo(): Todo {
  return new Todo(FIXTURE);
}

function snapshot(todo: Todo) {
  return {
    text: todo.text,
    state: todo.state,
    priority: todo.priority,
    completionDate: todo.completionDate?.getTime(),
    creationDate: todo.creationDate?.getTime(),
    projects: [...todo.projects],
    contexts: [...todo.contexts],
    tags: structuredClone(todo.tags),
    string: todo.toString(),
  };
}

type SetterCase = {
  name: string;
  apply: (todo: Todo) => Todo;
  verify: (updated: Todo) => void;
};

const setterCases: SetterCase[] = [
  {
    name: "setText",
    apply: (todo) =>
      todo.setText("renamed +project @context", { preserveTags: true }),
    verify: (updated) => {
      expect(updated.text).toEqual("renamed +project @context");
    },
  },
  {
    name: "setPriority",
    apply: (todo) => todo.setPriority("A" as UpperCaseLetter),
    verify: (updated) => expect(updated.priority).toEqual("A"),
  },
  {
    name: "setCreationDate",
    apply: (todo) => todo.setCreationDate(date),
    verify: (updated) => expect(updated.creationDate).toEqual(date),
  },
  {
    name: "setCompletionDate",
    apply: (todo) => todo.setCompletionDate(date),
    verify: (updated) => expect(updated.completionDate).toEqual(date),
  },
  {
    name: "setState",
    apply: (todo) => todo.setState(TodoStateEnum.done),
    verify: (updated) => expect(updated.state).toEqual(TodoStateEnum.done),
  },
  {
    name: "setRecurrence",
    apply: (todo) => todo.setRecurrence("2w"),
    verify: (updated) => expect(updated.tags.rec).toEqual("2w"),
  },
  {
    name: "removeRecurrence",
    apply: (todo) => todo.removeRecurrence(),
    verify: (updated) => expect(updated.tags.rec).toEqual(undefined),
  },
  {
    name: "setDue",
    apply: (todo) => todo.setDue(date),
    verify: (updated) =>
      expect(updated.tags.due).toEqual(format(date, "yyyy-MM-dd")),
  },
  {
    name: "removeDue",
    apply: (todo) => todo.removeDue(),
    verify: (updated) => expect(updated.tags.due).toEqual(undefined),
  },
  {
    name: "setThreshold",
    apply: (todo) => todo.setThreshold(date),
    verify: (updated) =>
      expect(updated.tags.t).toEqual(format(date, "yyyy-MM-dd")),
  },
  {
    name: "removeThreshold",
    apply: (todo) => todo.removeThreshold(),
    verify: (updated) => expect(updated.tags.t).toEqual(undefined),
  },
  {
    name: "toggleHidden",
    apply: (todo) => todo.toggleHidden(),
    verify: (updated) => expect(updated.isHidden()).toEqual(false),
  },
];

for (const { name, apply, verify } of setterCases) {
  test(`${name} - returns a new todo, preserves id, and leaves the original untouched`, () => {
    const original = makeTodo();
    const before = snapshot(original);

    const updated = apply(original);

    expect(updated).not.toBe(original);
    expect(updated.id).toEqual(original.id);
    expect(snapshot(original)).toEqual(before);
    verify(updated);
  });

  test(`${name} - returned todo has independent mutable collections`, () => {
    const original = makeTodo();
    const updated = apply(original);

    expect(updated.projects).not.toBe(original.projects);
    expect(updated.contexts).not.toBe(original.contexts);
    expect(updated.tags).not.toBe(original.tags);
    expect(updated.tags.multi).not.toBe(original.tags.multi);

    // Mutating the receiver after a setter must not leak into the result.
    original.projects.add("original-only");
    original.contexts.add("original-only");
    (original.tags.multi as string[]).push("original-only");

    expect([...updated.projects]).toEqual(["project"]);
    expect([...updated.contexts]).toEqual(["context"]);
    expect(updated.tags.multi).toEqual(["one", "two"]);

    // Mutating the result must not leak back into the receiver.
    updated.projects.add("updated-only");
    updated.contexts.add("updated-only");
    (updated.tags.multi as string[]).push("updated-only");

    expect([...original.projects]).toEqual(["project", "original-only"]);
    expect([...original.contexts]).toEqual(["context", "original-only"]);
    expect(original.tags.multi).toEqual(["one", "two", "original-only"]);
  });
}

test("chained setters do not share mutable collections", () => {
  const base = makeTodo();
  const first = base.setPriority("A" as UpperCaseLetter);
  const second = first.setRecurrence("2w");

  expect(first.projects).not.toBe(second.projects);
  expect(first.contexts).not.toBe(second.contexts);
  expect(first.tags).not.toBe(second.tags);
  expect(first.tags.multi).not.toBe(second.tags.multi);

  first.projects.add("first-only");
  first.contexts.add("first-only");
  (first.tags.multi as string[]).push("first-only");

  expect([...second.projects]).toEqual(["project"]);
  expect([...second.contexts]).toEqual(["context"]);
  expect(second.tags.multi).toEqual(["one", "two"]);

  second.projects.add("second-only");
  second.contexts.add("second-only");
  (second.tags.multi as string[]).push("second-only");

  expect([...first.projects]).toEqual(["project", "first-only"]);
  expect([...first.contexts]).toEqual(["context", "first-only"]);
  expect(first.tags.multi).toEqual(["one", "two", "first-only"]);

  expect([...base.projects]).toEqual(["project"]);
  expect([...base.contexts]).toEqual(["context"]);
  expect(base.tags.multi).toEqual(["one", "two"]);
});

test("addProject and addContext still return this when already present", () => {
  const todo = new Todo("task +project @context");

  expect(todo.addProject("project")).toEqual(todo);
  expect(todo.addContext("context")).toEqual(todo);
});
