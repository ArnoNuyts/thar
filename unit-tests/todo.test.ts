import { expect, test } from "vitest";
import {
  format,
  formatDate,
  lightFormat,
  startOfTomorrow,
  startOfYesterday,
} from "date-fns";

import { Todo } from "../logic/todo.ts"; // Adjust the path as needed
import { TodoStateEnum } from "../types/enums.ts";
import { UpperCaseLetter } from "../types/types.ts";

test("Todo constructor - sets text correctly", () => {
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

    expect(
      todo.text,
      `Input "${input}" should have exactly the text: ${expected}`,
    ).toEqual(expected);
  }
});

test("Todo constructor - sets state correctly", () => {
  const testCases = [
    { input: "todo", expected: TodoStateEnum.todo },
    { input: "x Completed", expected: TodoStateEnum.done },
    { input: "(B) Todo", expected: TodoStateEnum.todo },
    { input: "x (A) Completed", expected: TodoStateEnum.done },
  ];

  for (const { input, expected } of testCases) {
    const todo = new Todo(input);

    expect(
      todo.state,
      `Input "${input}" should have exactly the state: ${expected}`,
    ).toEqual(expected);
  }
});

test("Todo constructor - sets priority correctly", () => {
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

    expect(
      todo.priority,
      `Input "${input}" should have exactly the priority: ${expected}`,
    ).toEqual(expected);
  }
});

test("Todo constructor - sets completionDate correctly", () => {
  const testCases = [
    {
      input: "x 2024-06-02 2024-06-01 Happy path",
      expected: new Date("2024-06-02T00:00:00.000Z"),
    },
    {
      input: "x 2024-06-02 completion without creation date",
      expected: new Date("2024-06-02T00:00:00.000Z"),
    },
    {
      input: "2024-06-02 No completion date, not completed",
      expected: undefined,
    },
  ];

  for (const { input, expected } of testCases) {
    const todo = new Todo(input);

    expect(
      todo.completionDate
        ? format(todo.completionDate, "yyyy-MM-dd")
        : undefined,
      `Input "${input}" should have exactly the date: ${
        expected ? format(expected, "yyyy-MM-dd") : "undefined"
      }`,
    ).toEqual(expected ? format(expected, "yyyy-MM-dd") : undefined);
  }
});

test("Todo constructor - parses completion date without a creation date", () => {
  const testCases = [
    {
      input: "x 2024-01-01 buy milk",
      expectedCompletionDate: "2024-01-01",
      expectedCreationDate: undefined,
      expectedState: TodoStateEnum.done,
    },
    {
      input: "x 2024-01-02 2024-01-01 buy milk",
      expectedCompletionDate: "2024-01-02",
      expectedCreationDate: "2024-01-01",
      expectedState: TodoStateEnum.done,
    },
    {
      input: "2024-01-01 buy milk",
      expectedCompletionDate: undefined,
      expectedCreationDate: "2024-01-01",
      expectedState: TodoStateEnum.todo,
    },
  ];

  for (const {
    input,
    expectedCompletionDate,
    expectedCreationDate,
    expectedState,
  } of testCases) {
    const todo = new Todo(input);

    expect(
      todo.completionDate
        ? format(todo.completionDate, "yyyy-MM-dd")
        : undefined,
      `Input "${input}" should have completion date: ${expectedCompletionDate}`,
    ).toEqual(expectedCompletionDate);
    expect(
      todo.creationDate ? format(todo.creationDate, "yyyy-MM-dd") : undefined,
      `Input "${input}" should have creation date: ${expectedCreationDate}`,
    ).toEqual(expectedCreationDate);
    expect(
      todo.state,
      `Input "${input}" should have state: ${expectedState}`,
    ).toEqual(expectedState);
  }
});

test("Todo constructor - keeps creation date empty with completion date only", () => {
  const input = "x 2024-06-01 Buy groceries";
  const todo = new Todo(input);
  expect(
    todo.completionDate ? format(todo.completionDate, "yyyy-MM-dd") : undefined,
  ).toEqual("2024-06-01");
  expect(todo.creationDate).toEqual(undefined);
});

test("Todo constructor - sets creationDate correctly", () => {
  const input = "2024-06-01 Buy groceries";
  const todo = new Todo(input);
  expect(
    todo.creationDate ? format(todo.creationDate, "yyyy-MM-dd") : undefined,
  ).toEqual("2024-06-01");
});

// Test for `projects` extraction
test("Todo constructor - extracts projects correctly", () => {
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

    expect(
      Array.from(todo.contexts),
      `Input "${input}" should have exactly the contexts: ${expected.join(
        ", ",
      )}`,
    ).toEqual(expected);
  }
});

// Test for `contexts` extraction
test("Todo constructor - extracts contexts correctly", () => {
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

    expect(
      Array.from(todo.projects),
      `Input "${input}" should have exactly the contexts: ${expected.join(
        ", ",
      )}`,
    ).toEqual(expected);
  }
});

// Test for `tags` extraction
test("Todo constructor - extracts tags correctly", () => {
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

    expect(
      todo.tags,
      `Input "${input}" should have exactly the tags: ${JSON.stringify(
        expected,
      )}`,
    ).toEqual(expected as unknown);
  }
});

test("Todo constructor - parses multiple distinct tags", () => {
  const todo = new Todo("a rec:1d due:2024-01-01");

  expect(todo.tags).toEqual({ rec: "1d", due: "2024-01-01" });
});

test("Todo setText - is idempotent when reparsing the same tags", () => {
  const todo = new Todo("a rec:1d").setText("a rec:1d");

  expect(todo.tags).toEqual({ rec: "1d" });
  expect(todo.text).toEqual("a");
});

test("Todo setText - replaces tags with those in the supplied text", () => {
  const todo = new Todo("a rec:1d").setText("a");

  expect(todo.tags).toEqual({});
  expect(todo.text).toEqual("a");
});

test("Todo project and context edits preserve programmatic tags", () => {
  const withProject = new Todo("a").setRecurrence("1d").addProject("p");
  expect(withProject.tags.rec).toEqual("1d");
  expect(Array.from(withProject.projects)).toEqual(["p"]);

  const withContext = new Todo("a").setRecurrence("1d").addContext("c");
  expect(withContext.tags.rec).toEqual("1d");
  expect(Array.from(withContext.contexts)).toEqual(["c"]);

  const withoutProject = new Todo("a +p")
    .setRecurrence("1d")
    .removeProject("p");
  expect(withoutProject.tags.rec).toEqual("1d");
  expect(Array.from(withoutProject.projects)).toEqual([]);

  const withoutContext = new Todo("a @c")
    .setRecurrence("1d")
    .removeContext("c");
  expect(withoutContext.tags.rec).toEqual("1d");
  expect(Array.from(withoutContext.contexts)).toEqual([]);

  const withDue = new Todo("a").setDue(new Date("2024-01-01")).addProject("p");
  expect(withDue.tags.due).toEqual("2024-01-01");
});

test("isDone - returns correctly", () => {
  const testCases = [
    { input: "x Done", expected: true },
    { input: "Todo", expected: false },
  ];

  for (const { input, expected } of testCases) {
    const todo = new Todo(input);

    expect(todo.isDone()).toEqual(expected);
  }
});

test("isHidden - returns correctly", () => {
  const testCases = [
    { input: "Hidden h:1", expected: true },
    { input: "Hidden h:2", expected: true },
    { input: "Visible", expected: false },
    { input: "Visible h:0", expected: false },
  ];

  for (const { input, expected } of testCases) {
    const todo = new Todo(input);

    expect(todo.isHidden(), input).toEqual(expected);
  }
});

test("isOverdue - returns correctly", () => {
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
    { input: "Malformed due:not-a-date", expected: false },
  ];

  for (const { input, expected } of testCases) {
    const todo = new Todo(input);

    expect(todo.isOverdue(), input).toEqual(expected);
  }
});

test("isPassedThreshold - returns correctly", () => {
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
    { input: "Malformed t:not-a-date", expected: true },
  ];

  for (const { input, expected } of testCases) {
    const todo = new Todo(input);

    expect(todo.isPassedThreshold(), input).toEqual(expected);
  }
});

test("toggleState - sets state correctly", () => {
  const testCases = [
    { input: "todo", expected: TodoStateEnum.done },
    { input: "x Completed", expected: TodoStateEnum.todo },
  ];

  for (const { input, expected } of testCases) {
    const todo = new Todo(input);
    const { updated } = todo.toggleState();

    expect(
      updated.state,
      `Input "${input}" should have exactly the state: ${expected}`,
    ).toEqual(expected);
  }
});

test("toggleHidden - sets hidden correctly", () => {
  const testCases = [
    { input: "todo", expected: true },
    { input: "todo h:1", expected: false },
    { input: "todo h:0", expected: true },
    { input: "todo h:2", expected: false },
  ];

  for (const { input, expected } of testCases) {
    const todo = new Todo(input);
    const updated = todo.toggleHidden();

    expect(
      updated.isHidden(),
      `Input "${input}" should be: ${expected}`,
    ).toEqual(expected);
  }
});

test("setPriority - sets priority correctly", () => {
  const testCases = [
    { text: "todo", input: "A" as UpperCaseLetter, expected: "A" },
    { text: "(A) todo", input: "A" as UpperCaseLetter, expected: "A" },
    { text: "(A) todo", input: "B" as UpperCaseLetter, expected: "B" },
  ];

  for (const { text, input, expected } of testCases) {
    const todo = new Todo(text);
    const updated = todo.setPriority(input);

    expect(updated.priority, `Input "${input}" should be: ${expected}`).toEqual(
      expected,
    );
  }
});

test("setDue - sets correctly", () => {
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

    expect(updated.tags.due, `Input "${input}" should be: ${expected}`).toEqual(
      expected,
    );
  }
});

test("setThreshold - sets correctly", () => {
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

    expect(updated.tags.t, `Input "${input}" should be: ${expected}`).toEqual(
      expected,
    );
  }
});

test("Todo toString - puts completion date before creation date", () => {
  const creationDate = new Date("2023-01-01");
  const completionDate = new Date("2023-01-02");

  let todo = new Todo("Test task");
  todo = todo.setCreationDate(creationDate);
  todo = todo.setCompletionDate(completionDate);
  todo = todo.setState(TodoStateEnum.done);

  const str = todo.toString();

  const parts = str.split(" ");
  expect(parts[0]).toEqual("x");
  expect(parts[1]).toEqual("2023-01-02"); // Completion date should be first
  expect(parts[2]).toEqual("2023-01-01"); // Creation date should be second
});

test("setRecurrence - sets correctly", () => {
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

    expect(updated.tags.rec, `Input "${input}" should be: ${expected}`).toEqual(
      expected,
    );
  }
});

test("removeRecurrence - removes correctly", () => {
  const testCases = [
    { text: "todo rec:1d", expectedHasRec: false },
    { text: "todo rec:2w", expectedHasRec: false },
    { text: "todo", expectedHasRec: false },
  ];

  for (const { text, expectedHasRec } of testCases) {
    const todo = new Todo(text);
    const updated = todo.removeRecurrence();

    expect(
      updated.tags.rec !== undefined,
      `After removing recurrence, todo "${text}" should have rec: ${expectedHasRec}`,
    ).toEqual(expectedHasRec);
  }
});

test("removeRecurrence - preserves other tags", () => {
  const todo = new Todo("todo rec:1d due:2024-01-01 t:2024-01-01");
  const updated = todo.removeRecurrence();

  expect(updated.tags.rec).toEqual(undefined);
  expect(updated.tags.due).toEqual("2024-01-01");
  expect(updated.tags.t).toEqual("2024-01-01");
});

test("Todo constructor - trims leading and trailing whitespace", () => {
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

    expect(
      todo.text,
      `Input "${input}" should have trimmed text: "${expected}", got: "${todo.text}"`,
    ).toEqual(expected);
  }
});

test("Todo setText - trims leading and trailing whitespace", () => {
  const todo = new Todo("initial");

  const testCases = [
    { input: "  leading", expected: "leading" },
    { input: "trailing  ", expected: "trailing" },
    { input: "  both  ", expected: "both" },
    { input: "no spaces", expected: "no spaces" },
  ];

  for (const { input, expected } of testCases) {
    const updated = todo.setText(input);

    expect(
      updated.text,
      `setText("${input}") should result in trimmed text: "${expected}", got: "${updated.text}"`,
    ).toEqual(expected);
  }
});
