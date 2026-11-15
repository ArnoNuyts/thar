import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { parseRecordToTodoParts } from "../logic/core-wasm.ts";
import { getReadLimits, TodoFileValidationError } from "../logic/limits.ts";
import { Todo, type TodoParts } from "../logic/todo.ts";
import { validateTodoFileContent } from "../logic/todo-file-validation.ts";
import { recordFromTodo } from "../tools/port/parse.ts";
import { TodoStateEnum } from "../types/enums.ts";

/**
 * CP3b2c: `Todo.fromParts` rebuilds an exactly equivalent todo without a
 * second parse.
 *
 * Every parseable corpus line is replayed through the production projection
 * (`recordFromTodo`) and normalizer (`parseRecordToTodoParts`) before the
 * factory, so the proof covers the flags, duplicate tags, invalid leading
 * dates and every field the read path hands back.
 */

const CORPUS_DIR = join(process.cwd(), "testdata", "port");
const LIMITS = getReadLimits();

/** Rebuild one line the way the read path does. */
const rebuild = (line: string): Todo => {
  const parts = parseRecordToTodoParts(recordFromTodo(new Todo(line), 0));
  if (parts === undefined) {
    throw new Error(`record for ${JSON.stringify(line)} was rejected`);
  }
  return Todo.fromParts(parts);
};

/** The parsed fields a caller can observe on a todo. */
const view = (todo: Todo) => ({
  text: todo.text,
  state: todo.state,
  priority: todo.priority,
  completionDate: todo.completionDate?.getTime(),
  creationDate: todo.creationDate?.getTime(),
  projects: [...todo.projects],
  contexts: [...todo.contexts],
  tags: { ...todo.tags },
  datesInText: todo.datesInText,
  completionDateInText: todo.completionDateInText,
  isDone: todo.isDone(),
  isHidden: todo.isHidden(),
  isVisibleInOverview: todo.isVisibleInOverview(),
  isOverdue: todo.isOverdue(),
  toString: todo.toString(),
  hash: todo.getHash(),
});

const corpusLines = (): string[] => {
  const lines: string[] = [];
  for (const fixture of readdirSync(CORPUS_DIR).filter((name) =>
    name.endsWith(".txt"),
  )) {
    const text = readFileSync(join(CORPUS_DIR, fixture)).toString("utf8");
    let normalized: string[];
    try {
      normalized = validateTodoFileContent(text, LIMITS);
    } catch (error) {
      if (error instanceof TodoFileValidationError) continue;
      throw error;
    }
    lines.push(...normalized.filter((line) => line.trim()));
  }
  return lines;
};

describe("Todo.fromParts over the corpus", () => {
  test("rebuilds every parseable line byte-identically", () => {
    const lines = corpusLines();
    // The CP1 corpus has 10 185 parseable lines; a shrinking count means a
    // fixture disappeared or the loop silently skipped a file.
    expect(lines.length).toBeGreaterThan(10_000);

    for (const line of lines) {
      const parsed = new Todo(line);
      const rebuilt = rebuild(line);
      expect(rebuilt.toString(), line).toBe(parsed.toString());
      expect(view(rebuilt), line).toEqual(view(parsed));
    }
  });

  test("assigns a fresh id per rebuilt todo in load order", () => {
    const todos = ["one", "two", "three"].map(rebuild);
    expect(new Set(todos.map((todo) => todo.id)).size).toBe(3);
    expect(todos.map((todo) => todo.text)).toEqual(["one", "two", "three"]);
  });
});

describe("Todo.fromParts flags and tags", () => {
  test("keeps an array-valued duplicate tag", () => {
    const todo = rebuild("beta:one beta:two body");
    expect(todo.tags).toEqual({ beta: ["one", "two"] });
    expect(todo.toString()).toBe("body beta:one,two");
    // The tag array is owned by the todo: mutating the parts must not leak.
    expect(Array.isArray(todo.tags.beta)).toBe(true);
  });

  test("keeps both round-trip flags for a literal completion date", () => {
    // A valid completion date followed by an invalid creation date: both
    // tokens stay in `text`, and the completion date is also a field.
    const todo = rebuild("x 2023-05-04 2023-02-29 second date is invalid");
    expect(todo.datesInText).toBe(true);
    expect(todo.completionDateInText).toBe(true);
    expect(todo.completionDate?.getTime()).toBe(new Date(2023, 4, 4).getTime());
    expect(todo.creationDate).toBeUndefined();
    expect(todo.toString()).toBe(
      "x 2023-05-04 2023-02-29 second date is invalid",
    );
  });

  test("keeps an invalid completion date literal", () => {
    const line = "x 2023-02-29 impossible completion date stays literal";
    const todo = rebuild(line);
    expect(todo.datesInText).toBe(true);
    expect(todo.completionDateInText).toBe(false);
    expect(todo.completionDate).toBeUndefined();
    expect(todo.toString()).toBe(line);
  });

  test("keeps a leading date with no body in the text", () => {
    // The constructor consumes a date only when a body follows, so this line
    // exposes a creation date and still keeps the token literal.
    const todo = rebuild("2024-01-01");
    expect(todo.creationDate?.getTime()).toBe(new Date(2024, 0, 1).getTime());
    expect(todo.datesInText).toBe(true);
    expect(todo.toString()).toBe("2024-01-01");
  });

  test("copies the mutable parts instead of aliasing them", () => {
    const tags: { [key: string]: string | string[] } = {
      beta: ["one", "two"],
    };
    const projects = ["thar"];
    const parts: TodoParts = {
      text: "body",
      state: TodoStateEnum.todo,
      priority: "A",
      completionDate: undefined,
      creationDate: new Date(2024, 2, 1),
      projects,
      contexts: ["work"],
      tags,
      datesInText: false,
      completionDateInText: false,
    };
    const todo = Todo.fromParts(parts);

    (tags.beta as string[]).push("three");
    projects.push("other");
    parts.creationDate = new Date(1999, 0, 1);

    expect(todo.tags).toEqual({ beta: ["one", "two"] });
    expect([...todo.projects]).toEqual(["thar"]);
    expect(todo.creationDate?.getFullYear()).toBe(2024);
  });
});

describe("Todo.fromParts keeps the immutable setter semantics", () => {
  const original = () =>
    Todo.fromParts(
      parseRecordToTodoParts(
        recordFromTodo(
          new Todo(
            "x (A) 2024-03-02 2024-03-01 done +thar @work beta:one beta:two",
          ),
          0,
        ),
      )!,
    );

  test("a setter returns a new todo with the same id", () => {
    const todo = original();
    const priority = todo.setPriority("B");

    expect(priority).not.toBe(todo);
    expect(priority.id).toBe(todo.id);
    expect(priority.priority).toBe("B");
    expect(todo.priority).toBe("A");
    expect(priority.toString()).toContain("(B)");
    expect(todo.toString()).toContain("(A)");
  });

  test("toggleState clones without changing the receiver", () => {
    const todo = original();
    const { updated } = todo.toggleState();

    expect(updated).not.toBe(todo);
    expect(updated.id).toBe(todo.id);
    expect(updated.isDone()).toBe(false);
    expect(todo.isDone()).toBe(true);
    expect(todo.tags).toEqual({ beta: ["one", "two"] });
  });

  test("array-valued tags are deep-copied by a setter", () => {
    const todo = original();
    const changed = todo.setText("changed beta:one beta:two");
    expect(todo.text).toBe("done +thar @work");
    expect(changed.tags).toEqual({ beta: ["one", "two"] });
    expect(changed.tags.beta).not.toBe(todo.tags.beta);
  });
});
