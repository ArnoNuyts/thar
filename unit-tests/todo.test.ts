import {
  format,
  formatDate,
  lightFormat,
  startOfTomorrow,
  startOfYesterday,
} from "date-fns";
import { assertEquals } from "@std/assert";
import { Todo } from "../logic/todo.ts"; // Adjust the path as needed
import { TodoStateEnum } from "../types/enums.ts";
import { UpperCaseLetter } from "../types/types.ts";

Deno.test("Todo constructor - sets text correctly", () => {
  const testCases = [
    { input: "x Completed", expected: "Completed" },
    { input: "(B) With prio", expected: "With prio" },
    { input: "x (A) Completed with prio", expected: "Completed with prio" },
    { input: "todo", expected: "todo" },
    { input: "with @context", expected: "with @context" },
    { input: "with @multiple @context", expected: "with @multiple @context" },
    { input: "with +project", expected: "with +project" },
    { input: "with +multiple +project", expected: "with +multiple +project" },
    { input: "with +multiple +project", expected: "with +multiple +project" },
    { input: "2024-06-02 With creation date", expected: "With creation date" },
    { input: "With tags:yeah", expected: "With" },
    {
      input: "x 2024-06-02 2024-06-02 With complition and creation date",
      expected: "With complition and creation date",
    },
    {
      input: "x    excessive space before",
      expected: "excessive space before",
    },
    {
      input: "x excessive space after    ",
      expected: "excessive space after",
    },
  ];

  for (const { input, expected } of testCases) {
    const todo = new Todo(input);

    assertEquals(
      todo.text,
      expected,
      `Input "${input}" should have exactly the text: ${expected}`,
    );
  }
});

Deno.test("Todo constructor - sets state correctly", () => {
  const testCases = [
    { input: "todo", expected: TodoStateEnum.todo },
    { input: "x Completed", expected: TodoStateEnum.done },
    { input: "(B) Todo", expected: TodoStateEnum.todo },
    { input: "x (A) Completed", expected: TodoStateEnum.done },
  ];

  for (const { input, expected } of testCases) {
    const todo = new Todo(input);

    assertEquals(
      todo.state,
      expected,
      `Input "${input}" should have exactly the state: ${expected}`,
    );
  }
});

Deno.test("Todo constructor - sets priority correctly", () => {
  const testCases = [
    { input: "x (A) Completed", expected: "A" },
    { input: "(B) Todo", expected: "B" },
    { input: "(C) 2024-06-02 Todo", expected: "C" },
    { input: "2024-06-02 Todo", expected: undefined },
    { input: "x Completed", expected: undefined },
    { input: "todo", expected: undefined },
  ];

  for (const { input, expected } of testCases) {
    const todo = new Todo(input);

    assertEquals(
      todo.priority,
      expected,
      `Input "${input}" should have exactly the priority: ${expected}`,
    );
  }
});

Deno.test("Todo constructor - sets completionDate correctly", () => {
  const testCases = [
    {
      input: "x 2024-06-02 2024-06-01 Happy path",
      expected: new Date("2024-06-02T00:00:00.000Z"),
    },
    { input: "x 2024-06-02 No completion date", expected: undefined },
    {
      input: "2024-06-02 No completion date, not completed",
      expected: undefined,
    },
  ];

  for (const { input, expected } of testCases) {
    const todo = new Todo(input);

    assertEquals(
      todo.completionDate
        ? format(todo.completionDate, "yyyy-MM-dd")
        : undefined,
      expected ? format(expected, "yyyy-MM-dd") : undefined,
      `Input "${input}" should have exactly the date: ${
        expected ? format(expected, "yyyy-MM-dd") : "undefined"
      }`,
    );
  }
});

// Test for `completionDate`
Deno.test("Todo constructor - sets completionDate correctly", () => {
  const testCases = [
    {
      input: "x 2024-06-02 2024-06-01 Buy groceries",
      expected: new Date("2024-06-02T00:00:00.000Z"),
    },
    { input: "x 2024-06-02 Buy groceries", expected: undefined },
  ];

  for (const { input, expected } of testCases) {
    const todo = new Todo(input);

    assertEquals(
      todo.completionDate
        ? format(todo.completionDate, "yyyy-MM-dd")
        : undefined,
      expected ? format(expected, "yyyy-MM-dd") : undefined,
      `Input "${input}" should have exactly the date: ${
        expected ? format(expected, "yyyy-MM-dd") : "undefined"
      }`,
    );
  }
});

Deno.test("Todo constructor - keeps completion date empty", () => {
  const input = "x 2024-06-01 Buy groceries";
  const todo = new Todo(input);
  assertEquals(todo.completionDate, undefined);
});

Deno.test("Todo constructor - sets creationDate correctly", () => {
  const input = "2024-06-01 Buy groceries";
  const todo = new Todo(input);
  assertEquals(
    todo.creationDate ? format(todo.creationDate, "yyyy-MM-dd") : undefined,
    "2024-06-01",
  );
});

// Test for `projects` extraction
Deno.test("Todo constructor - extracts projects correctly", () => {
  const testCases = [
    { input: "Buy groceries @home", expected: ["home"] },
    { input: "Fix the car @garage @tools", expected: ["garage", "tools"] },
    { input: "Read book", expected: [] }, // No contexts
    { input: "Add important feature @v0.1", expected: ["v0.1"] },
    { input: "Something with a @dash-of-salt", expected: ["dash-of-salt"] },
    { input: "Todo @snake_case", expected: ["snake_case"] },
    { input: "Todo @camelCase", expected: ["camelCase"] },
    { input: "Todo @StartWithUppercase", expected: ["StartWithUppercase"] },
    { input: "@ContextAtStart", expected: ["ContextAtStart"] },
  ];

  for (const { input, expected } of testCases) {
    const todo = new Todo(input);

    assertEquals(
      Array.from(todo.contexts),
      expected,
      `Input "${input}" should have exactly the contexts: ${
        expected.join(", ")
      }`,
    );
  }
});

// Test for `contexts` extraction
Deno.test("Todo constructor - extracts contexts correctly", () => {
  const testCases = [
    { input: "Buy groceries +home", expected: ["home"] },
    { input: "Fix the car +garage +tools", expected: ["garage", "tools"] },
    { input: "No contexts", expected: [] },
    { input: "Add important feature +v0.1", expected: ["v0.1"] },
    { input: "Something with a +dash-of-salt", expected: ["dash-of-salt"] },
    { input: "Todo +snake_case", expected: ["snake_case"] },
    { input: "Todo +camelCase", expected: ["camelCase"] },
    { input: "Todo +StartWithUppercase", expected: ["StartWithUppercase"] },
    { input: "+ProjectAtStart", expected: ["ProjectAtStart"] },
  ];

  for (const { input, expected } of testCases) {
    const todo = new Todo(input);

    assertEquals(
      Array.from(todo.projects),
      expected,
      `Input "${input}" should have exactly the contexts: ${
        expected.join(", ")
      }`,
    );
  }
});

// Test for `tags` extraction
Deno.test("Todo constructor - extracts tags correctly", () => {
  const testCases = [
    { input: "Todo h:1", expected: { h: "1" } },
    { input: "Todo due:2024-01-01", expected: { due: "2024-01-01" } },
    { input: "Todo t:2024-01-01", expected: { t: "2024-01-01" } },
    {
      input: "Todo multiple:t1 tags:t2",
      expected: { multiple: "t1", tags: "t2" },
    },
    {
      input: "Array of tags tag:one tag:two",
      expected: { tag: ["one", "two"] },
    },
    {
      input: "Array of tags tag:one tag:two tag:three",
      expected: { tag: ["one", "two", "three"] },
    },
  ];

  for (const { input, expected } of testCases) {
    const todo = new Todo(input);

    assertEquals(
      todo.tags,
      expected as unknown,
      `Input "${input}" should have exactly the tags: ${
        JSON.stringify(expected)
      }`,
    );
  }
});

Deno.test("isDone - returns correctly", () => {
  const testCases = [
    { input: "x Done", expected: true },
    { input: "Todo", expected: false },
  ];

  for (const { input, expected } of testCases) {
    const todo = new Todo(input);

    assertEquals(
      todo.isDone(),
      expected,
    );
  }
});

Deno.test("isHidden - returns correctly", () => {
  const testCases = [
    { input: "Hidden h:1", expected: true },
    { input: "Hidden h:2", expected: true },
    { input: "Visible", expected: false },
    { input: "Visible h:0", expected: false },
  ];

  for (const { input, expected } of testCases) {
    const todo = new Todo(input);

    assertEquals(
      todo.isHidden(),
      expected,
      input,
    );
  }
});

Deno.test("isOverdue - returns correctly", () => {
  const testCases = [
    { input: "In the past due:1999-01-01", expected: true },
    { input: "In the future due:3000-01-01", expected: false },
    {
      input: `Today due:${lightFormat(new Date(), "yyyy-MM-dd")}`,
      expected: true,
    },
    {
      input: `Tomorrow due:${lightFormat(startOfTomorrow(), "yyyy-MM-dd")}`,
      expected: false,
    },
    {
      input: `Yesterday due:${lightFormat(startOfYesterday(), "yyyy-MM-dd")}`,
      expected: true,
    },
    { input: "No due date", expected: false },
  ];

  for (const { input, expected } of testCases) {
    const todo = new Todo(input);

    assertEquals(
      todo.isOverdue(),
      expected,
      input,
    );
  }
});

Deno.test("isPassedThreshold - returns correctly", () => {
  const testCases = [
    { input: "In the past t:1999-01-01", expected: true },
    { input: "In the future t:3000-01-01", expected: false },
    {
      input: `Tomorrow t:${formatDate(startOfTomorrow(), "yyyy-MM-dd")}`,
      expected: false,
    },
    {
      input: `Yesterday t:${formatDate(startOfYesterday(), "yyyy-MM-dd")}`,
      expected: true,
    },
    { input: "No threshold date", expected: true },
  ];

  for (const { input, expected } of testCases) {
    const todo = new Todo(input);

    assertEquals(
      todo.isPassedThreshold(),
      expected,
      input,
    );
  }
});

Deno.test("toggleState - sets state correctly", () => {
  const testCases = [
    { input: "todo", expected: TodoStateEnum.done },
    { input: "x Completed", expected: TodoStateEnum.todo },
  ];

  for (const { input, expected } of testCases) {
    const todo = new Todo(input);
    const { updated } = todo.toggleState();

    assertEquals(
      updated.state,
      expected,
      `Input "${input}" should have exactly the state: ${expected}`,
    );
  }
});

Deno.test("toggleHidden - sets hidden correctly", () => {
  const testCases = [
    { input: "todo", expected: true },
    { input: "todo h:1", expected: false },
    { input: "todo h:0", expected: true },
    { input: "todo h:2", expected: false },
  ];

  for (const { input, expected } of testCases) {
    const todo = new Todo(input);
    const updated = todo.toggleHidden();

    assertEquals(
      updated.isHidden(),
      expected,
      `Input "${input}" should be: ${expected}`,
    );
  }
});

Deno.test("setPriority - sets priority correctly", () => {
  const testCases = [
    { text: "todo", input: "A" as UpperCaseLetter, expected: "A" },
    { text: "(A) todo", input: "A" as UpperCaseLetter, expected: "A" },
    { text: "(A) todo", input: "B" as UpperCaseLetter, expected: "B" },
  ];

  for (const { text, input, expected } of testCases) {
    const todo = new Todo(text);
    const updated = todo.setPriority(input);

    assertEquals(
      updated.priority,
      expected,
      `Input "${input}" should be: ${expected}`,
    );
  }
});

Deno.test("setDue - sets correctly", () => {
  const testCases = [
    { text: "todo", input: new Date("1999-01-01"), expected: "1999-01-01" },
    {
      text: "todo due:3000-03-03",
      input: new Date("1999-01-01"),
      expected: "1999-01-01",
    },
  ];

  for (const { text, input, expected } of testCases) {
    const todo = new Todo(text);
    const updated = todo.setDue(input);

    assertEquals(
      updated.tags.due,
      expected,
      `Input "${input}" should be: ${expected}`,
    );
  }
});

Deno.test("setThreshold - sets correctly", () => {
  const testCases = [
    { text: "todo", input: new Date("1999-01-01"), expected: "1999-01-01" },
    {
      text: "todo due:3000-03-03",
      input: new Date("1999-01-01"),
      expected: "1999-01-01",
    },
  ];

  for (const { text, input, expected } of testCases) {
    const todo = new Todo(text);
    const updated = todo.setThreshold(input);

    assertEquals(
      updated.tags.t,
      expected,
      `Input "${input}" should be: ${expected}`,
    );
  }
});

Deno.test("Todo toString - puts completion date before creation date", () => {
  const creationDate = new Date("2023-01-01");
  const completionDate = new Date("2023-01-02");

  let todo = new Todo("Test task");
  todo = todo.setCreationDate(creationDate);
  todo = todo.setCompletionDate(completionDate);
  todo = todo.setState(TodoStateEnum.done);

  const str = todo.toString();

  const parts = str.split(" ");
  assertEquals(parts[0], "x");
  assertEquals(parts[1], "2023-01-02"); // Completion date should be first
  assertEquals(parts[2], "2023-01-01"); // Creation date should be second
});

Deno.test("setRecurrence - sets correctly", () => {
  const testCases = [
    { text: "todo", input: "1d", expected: "1d" },
    { text: "todo", input: "2w", expected: "2w" },
    { text: "todo", input: "3m", expected: "3m" },
    { text: "todo", input: "1y", expected: "1y" },
    { text: "todo rec:1d", input: "2w", expected: "2w" },
  ];

  for (const { text, input, expected } of testCases) {
    const todo = new Todo(text);
    const updated = todo.setRecurrence(input);

    assertEquals(
      updated.tags.rec,
      expected,
      `Input "${input}" should be: ${expected}`,
    );
  }
});

Deno.test("removeRecurrence - removes correctly", () => {
  const testCases = [
    { text: "todo rec:1d", expectedHasRec: false },
    { text: "todo rec:2w", expectedHasRec: false },
    { text: "todo", expectedHasRec: false },
  ];

  for (const { text, expectedHasRec } of testCases) {
    const todo = new Todo(text);
    const updated = todo.removeRecurrence();

    assertEquals(
      updated.tags.rec !== undefined,
      expectedHasRec,
      `After removing recurrence, todo "${text}" should have rec: ${expectedHasRec}`,
    );
  }
});

Deno.test("removeRecurrence - preserves other tags", () => {
  const todo = new Todo("todo rec:1d due:2024-01-01 t:2024-01-01");
  const updated = todo.removeRecurrence();

  assertEquals(updated.tags.rec, undefined);
  assertEquals(updated.tags.due, "2024-01-01");
  assertEquals(updated.tags.t, "2024-01-01");
});

Deno.test("Todo constructor - trims leading and trailing whitespace", () => {
  const testCases = [
    {
      input: "x    excessive space before",
      expected: "excessive space before",
    },
    { input: "x excessive space after    ", expected: "excessive space after" },
    { input: "  leading spaces", expected: "leading spaces" },
    { input: "trailing spaces  ", expected: "trailing spaces" },
    { input: "  both sides  ", expected: "both sides" },
    { input: "\ttab before", expected: "tab before" },
    { input: "tab after\t", expected: "tab after" },
    { input: "  \t  mixed whitespace  \t  ", expected: "mixed whitespace" },
    { input: "no extra spaces", expected: "no extra spaces" },
    { input: "(A)   priority with spaces", expected: "priority with spaces" },
    {
      input: "2024-06-02   creation date with spaces",
      expected: "creation date with spaces",
    },
  ];

  for (const { input, expected } of testCases) {
    const todo = new Todo(input);

    assertEquals(
      todo.text,
      expected,
      `Input "${input}" should have trimmed text: "${expected}", got: "${todo.text}"`,
    );
  }
});

Deno.test("Todo setText - trims leading and trailing whitespace", () => {
  const todo = new Todo("initial");

  const testCases = [
    { input: "  leading", expected: "leading" },
    { input: "trailing  ", expected: "trailing" },
    { input: "  both  ", expected: "both" },
    { input: "no spaces", expected: "no spaces" },
  ];

  for (const { input, expected } of testCases) {
    const updated = todo.setText(input);

    assertEquals(
      updated.text,
      expected,
      `setText("${input}") should result in trimmed text: "${expected}", got: "${updated.text}"`,
    );
  }
});
