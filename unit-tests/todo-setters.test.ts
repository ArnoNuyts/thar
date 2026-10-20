import { format } from "date-fns";
import { assertEquals, assertNotStrictEquals } from "@std/assert";
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
      assertEquals(updated.text, "renamed +project @context");
    },
  },
  {
    name: "setPriority",
    apply: (todo) => todo.setPriority("A" as UpperCaseLetter),
    verify: (updated) => assertEquals(updated.priority, "A"),
  },
  {
    name: "setCreationDate",
    apply: (todo) => todo.setCreationDate(date),
    verify: (updated) => assertEquals(updated.creationDate, date),
  },
  {
    name: "setCompletionDate",
    apply: (todo) => todo.setCompletionDate(date),
    verify: (updated) => assertEquals(updated.completionDate, date),
  },
  {
    name: "setState",
    apply: (todo) => todo.setState(TodoStateEnum.done),
    verify: (updated) => assertEquals(updated.state, TodoStateEnum.done),
  },
  {
    name: "setRecurrence",
    apply: (todo) => todo.setRecurrence("2w"),
    verify: (updated) => assertEquals(updated.tags.rec, "2w"),
  },
  {
    name: "removeRecurrence",
    apply: (todo) => todo.removeRecurrence(),
    verify: (updated) => assertEquals(updated.tags.rec, undefined),
  },
  {
    name: "setDue",
    apply: (todo) => todo.setDue(date),
    verify: (updated) =>
      assertEquals(updated.tags.due, format(date, "yyyy-MM-dd")),
  },
  {
    name: "removeDue",
    apply: (todo) => todo.removeDue(),
    verify: (updated) => assertEquals(updated.tags.due, undefined),
  },
  {
    name: "setThreshold",
    apply: (todo) => todo.setThreshold(date),
    verify: (updated) =>
      assertEquals(updated.tags.t, format(date, "yyyy-MM-dd")),
  },
  {
    name: "removeThreshold",
    apply: (todo) => todo.removeThreshold(),
    verify: (updated) => assertEquals(updated.tags.t, undefined),
  },
  {
    name: "toggleHidden",
    apply: (todo) => todo.toggleHidden(),
    verify: (updated) => assertEquals(updated.isHidden(), false),
  },
];

for (const { name, apply, verify } of setterCases) {
  Deno.test(`${name} - returns a new todo, preserves id, and leaves the original untouched`, () => {
    const original = makeTodo();
    const before = snapshot(original);

    const updated = apply(original);

    assertNotStrictEquals(updated, original);
    assertEquals(updated.id, original.id);
    assertEquals(snapshot(original), before);
    verify(updated);
  });

  Deno.test(`${name} - returned todo has independent mutable collections`, () => {
    const original = makeTodo();
    const updated = apply(original);

    assertNotStrictEquals(updated.projects, original.projects);
    assertNotStrictEquals(updated.contexts, original.contexts);
    assertNotStrictEquals(updated.tags, original.tags);
    assertNotStrictEquals(updated.tags.multi, original.tags.multi);

    // Mutating the receiver after a setter must not leak into the result.
    original.projects.add("original-only");
    original.contexts.add("original-only");
    (original.tags.multi as string[]).push("original-only");

    assertEquals([...updated.projects], ["project"]);
    assertEquals([...updated.contexts], ["context"]);
    assertEquals(updated.tags.multi, ["one", "two"]);

    // Mutating the result must not leak back into the receiver.
    updated.projects.add("updated-only");
    updated.contexts.add("updated-only");
    (updated.tags.multi as string[]).push("updated-only");

    assertEquals([...original.projects], ["project", "original-only"]);
    assertEquals([...original.contexts], ["context", "original-only"]);
    assertEquals(original.tags.multi, ["one", "two", "original-only"]);
  });
}

Deno.test("chained setters do not share mutable collections", () => {
  const base = makeTodo();
  const first = base.setPriority("A" as UpperCaseLetter);
  const second = first.setRecurrence("2w");

  assertNotStrictEquals(first.projects, second.projects);
  assertNotStrictEquals(first.contexts, second.contexts);
  assertNotStrictEquals(first.tags, second.tags);
  assertNotStrictEquals(first.tags.multi, second.tags.multi);

  first.projects.add("first-only");
  first.contexts.add("first-only");
  (first.tags.multi as string[]).push("first-only");

  assertEquals([...second.projects], ["project"]);
  assertEquals([...second.contexts], ["context"]);
  assertEquals(second.tags.multi, ["one", "two"]);

  second.projects.add("second-only");
  second.contexts.add("second-only");
  (second.tags.multi as string[]).push("second-only");

  assertEquals([...first.projects], ["project", "first-only"]);
  assertEquals([...first.contexts], ["context", "first-only"]);
  assertEquals(first.tags.multi, ["one", "two", "first-only"]);

  assertEquals([...base.projects], ["project"]);
  assertEquals([...base.contexts], ["context"]);
  assertEquals(base.tags.multi, ["one", "two"]);
});

Deno.test("addProject and addContext still return this when already present", () => {
  const todo = new Todo("task +project @context");

  assertEquals(todo.addProject("project"), todo);
  assertEquals(todo.addContext("context"), todo);
});
