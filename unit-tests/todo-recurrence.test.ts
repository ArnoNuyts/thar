import { assertEquals } from "@std/assert";
import { Todo } from "../logic/todo.ts";

Deno.test("setRecurrence - sets correctly", () => {
  const testCases = [
    { text: "todo", input: "1d", expected: "1d" },
    {
      text: "todo rec:2w",
      input: "1d",
      expected: "1d",
    },
  ];

  for (const { text, input, expected } of testCases) {
    const todo = new Todo(text);
    todo.setRecurrence(input);

    assertEquals(
      todo.tags.rec,
      expected,
      `Input "${input}" should be: ${expected}`,
    );
  }
});

const formatDate = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

Deno.test("toggleState - daily recurrence", () => {
  const todo = new Todo("todo rec:1d");
  const newTodo = todo.toggleState();

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);

  assertEquals(newTodo?.tags.due, formatDate(tomorrow));
});

Deno.test("toggleState - weekly recurrence", () => {
  const todo = new Todo("todo rec:1w");
  const newTodo = todo.toggleState();

  const nextWeek = new Date();
  nextWeek.setDate(nextWeek.getDate() + 7);

  assertEquals(newTodo?.tags.due, formatDate(nextWeek));
});

Deno.test("toggleState - monthly recurrence", () => {
  const todo = new Todo("todo rec:1m");
  const newTodo = todo.toggleState();

  const nextMonth = new Date();
  nextMonth.setMonth(nextMonth.getMonth() + 1);

  assertEquals(newTodo!.tags.due, formatDate(nextMonth));
});

Deno.test("toggleState - yearly recurrence", () => {
  const todo = new Todo("todo rec:1y");
  const newTodo = todo.toggleState();

  const nextYear = new Date();
  nextYear.setFullYear(nextYear.getFullYear() + 1);

  assertEquals(newTodo?.tags.due, formatDate(nextYear));
});
