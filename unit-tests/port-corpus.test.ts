import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { format } from "date-fns";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import expectedJson from "../testdata/port/expected.json" with { type: "json" };
import {
  DEFAULT_RELOAD_DEBOUNCE_MS,
  DEFAULT_SAVE_DEBOUNCE_MS,
} from "../hooks/useTodoFileSync.ts";
import { sortByImportance } from "../logic/Todos.ts";
import { createIndexes } from "../logic/indexes.ts";
import {
  getReadLimits,
  type ReadLimits,
  TodoControlCharacterError,
  TodoFileTooLargeError,
  TodoLineCountLimitError,
  TodoLineLengthLimitError,
} from "../logic/limits.ts";
import { Todo } from "../logic/todo.ts";
import {
  readTodosFromFile,
  writeTodosToFile,
} from "../logic/todo-file-helpers.ts";
import { validateTodoFileContent } from "../logic/todo-file-validation.ts";
import { IndexType, TodoStateEnum } from "../types/enums.ts";
import { Runtime } from "../utils/runtime.ts";

/**
 * CP0 characterization of `todo.txt` behaviour over the committed corpus in
 * `testdata/port/`.
 *
 * The expected values are committed constants in `testdata/port/expected.json`
 * and were reviewed by hand; this file never regenerates them. See
 * `testdata/port/README.md` for the file-by-file rule checklist and the
 * PLAN.md §7 coverage table.
 */

const CORPUS_DIR = join(process.cwd(), "testdata", "port");
/** Local midday, so `startOfDay(new Date())` is unambiguous. */
const CLOCK = "2026-11-15T12:00:00";
const INVALID_RECURRENCE = "Invalid recurrence value; no new todo was created";
const OUT_OF_RANGE_RECURRENCE =
  "Recurrence is out of range; no new todo was created";

type TodoRecord = {
  text: string;
  state: "todo" | "done";
  priority: string | null;
  completionDate: string | null;
  creationDate: string | null;
  projects: string[];
  contexts: string[];
  tags: [string, string | string[]][];
  isDone: boolean;
  isHidden: boolean;
  isVisibleInOverview: boolean;
  isOverdue: boolean;
  toString: string;
  hash: string;
};

type ErrorRecord = {
  name: string;
  message: string;
  code?: string;
  lineNumber?: number;
  length?: number;
  maxLineChars?: number;
  lineCount?: number;
  maxReadTodos?: number;
  actualBytes?: number;
  maxBytes?: number;
  codePoint?: number;
};

type FileExpectation = {
  rawBytes: number;
  kind: "todos" | "error";
  todoCount?: number;
  serialized?: { sha256: string; bytes: number };
  /**
   * Input indexes of the todos in `sortByImportance` order at the pinned
   * clock. CP1 must reuse these instead of recomputing the order.
   */
  sortedIndexes?: number[];
  todos?: TodoRecord[];
  samples?: { index: number; todo: TodoRecord }[];
  error?: ErrorRecord;
};

type ExpectedCorpus = {
  clockLocal: string;
  readLimits: ReadLimits;
  files: Record<string, FileExpectation>;
};

const expected = expectedJson as unknown as ExpectedCorpus;

/** Distinctive text from each rejection fixture: errors must never echo it. */
const CONTENT_PROBES: Record<string, string> = {
  "bare-cr-eof.txt": "no newline at eof",
  "bare-cr-inside.txt": "carriage",
  "control-bel.txt": "bell",
  "control-c1.txt": "c1",
  "control-del.txt": "del",
  "control-esc.txt": "ansi",
  "control-nul.txt": "nul",
  "control-u2028.txt": "separator",
};

type ErrorConstructor = new (...args: never[]) => Error;

const ERROR_CLASSES: Record<string, ErrorConstructor> = {
  CONTROL_CHARACTER: TodoControlCharacterError,
  TOO_MANY_LINES: TodoLineCountLimitError,
  LINE_TOO_LONG: TodoLineLengthLimitError,
  FILE_TOO_LARGE: TodoFileTooLargeError,
};

const readCorpusFile = (name: string) => readFileSync(join(CORPUS_DIR, name));

/** The exact load path of `readTodosFromFile`, minus the filesystem. */
const parseTodos = (raw: Buffer): Todo[] =>
  validateTodoFileContent(raw.toString("utf8"), getReadLimits())
    .filter((line) => line.trim())
    .map((line) => new Todo(line));

/** The exact write path of `writeTodosToFile`, without the atomic replace. */
const serializeTodos = (todos: Todo[]): string =>
  todos.map((todo) => todo.toString()).join("\n") + "\n";

const sha256 = (value: string): string =>
  createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");

const dateOrNull = (date: Date | undefined): string | null =>
  date === undefined ? null : format(date, "yyyy-MM-dd");

const recordOf = (todo: Todo): TodoRecord => ({
  text: todo.text,
  state: todo.state === TodoStateEnum.done ? "done" : "todo",
  priority: todo.priority ?? null,
  completionDate: dateOrNull(todo.completionDate),
  creationDate: dateOrNull(todo.creationDate),
  projects: [...todo.projects],
  contexts: [...todo.contexts],
  tags: Object.entries(todo.tags).map(([key, value]) => [key, value]),
  isDone: todo.isDone(),
  isHidden: todo.isHidden(),
  isVisibleInOverview: todo.isVisibleInOverview(),
  isOverdue: todo.isOverdue(),
  toString: todo.toString(),
  hash: todo.getHash(),
});

const todosByName = (name: string): Todo[] => parseTodos(readCorpusFile(name));

/**
 * `sortByImportance` order expressed as indexes into the parsed input, plus
 * the sorted todos themselves. `isOverdue()` reads the pinned fake clock, so
 * the order is deterministic.
 */
const sortedWithIndexes = (
  name: string,
): { indexes: number[]; todos: Todo[] } => {
  const parsed = todosByName(name);
  const indexById = new Map(parsed.map((todo, index) => [todo.id, index]));
  const sorted = sortByImportance(parsed);
  return {
    indexes: sorted.map((todo) => indexById.get(todo.id)!),
    todos: sorted,
  };
};

/** The first todo whose text contains `fragment`. */
const containing = (todos: Todo[], fragment: string): Todo => {
  const todo = todos.find((candidate) => candidate.text.includes(fragment));
  if (!todo)
    throw new Error(`No corpus todo contains ${JSON.stringify(fragment)}`);
  return todo;
};

const withTagValue = (
  todos: Todo[],
  key: string,
  value: string,
): Todo | undefined =>
  todos.find((todo) => {
    const tag = todo.tags[key];
    return Array.isArray(tag) ? tag.includes(value) : tag === value;
  });

const withTempDir = async (fn: (dir: string) => Promise<void>) => {
  const dir = await Runtime.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Runtime.remove(dir, { recursive: true });
  }
};

const rejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the promise to reject");
};

const todoFiles = Object.entries(expected.files).filter(
  ([, file]) => file.kind === "todos",
);
const errorFiles = Object.entries(expected.files).filter(
  ([, file]) => file.kind === "error",
);

/**
 * The corpus expectations are the TypeScript oracle's output, so this file
 * pins `THAR_CORE=ts` for its whole run: since CP5 the app defaults to Rust,
 * and a Rust parse here would compare Rust against itself instead of the
 * reader the expectations were recorded from.
 */
const savedCoreMode = process.env.THAR_CORE;

beforeAll(() => {
  process.env.THAR_CORE = "ts";
  vi.useFakeTimers();
  vi.setSystemTime(new Date(CLOCK));
});

afterAll(() => {
  vi.useRealTimers();
  if (savedCoreMode === undefined) delete process.env.THAR_CORE;
  else process.env.THAR_CORE = savedCoreMode;
});

describe("corpus layout", () => {
  test("pins the clock and the read limits used for expectations", () => {
    expect(expected.clockLocal).toEqual(CLOCK);
    expect(expected.readLimits).toEqual(getReadLimits());
  });

  test("lists exactly the committed .txt fixtures", () => {
    const committed = readdirSync(CORPUS_DIR)
      .filter((name) => name.endsWith(".txt"))
      .sort();
    expect(committed).toEqual(Object.keys(expected.files).sort());
  });

  test("keeps byte-exact fixtures out of the LF-normalising root attributes", () => {
    const attributes = readFileSync(join(CORPUS_DIR, ".gitattributes"), "utf8");
    expect(attributes).toEqual("* -text\n");

    expect(readCorpusFile("crlf.txt").includes(Buffer.from("\r\n"))).toEqual(
      true,
    );
    expect(readCorpusFile("no-trailing-newline.txt").at(-1)).not.toEqual(0x0a);
    expect(readCorpusFile("empty.txt")).toHaveLength(0);
    expect(readCorpusFile("bare-cr-eof.txt").at(-1)).toEqual(0x0d);
  });
});

for (const [name, file] of todoFiles) {
  describe(name, () => {
    test("keeps the committed fixture bytes", () => {
      expect(readCorpusFile(name)).toHaveLength(file.rawBytes);
    });

    test("parses the expected number of todos", () => {
      expect(parseTodos(readCorpusFile(name))).toHaveLength(file.todoCount!);
    });

    test("serializes to the pinned bytes", () => {
      const serialized = serializeTodos(parseTodos(readCorpusFile(name)));
      expect(Buffer.byteLength(serialized, "utf8")).toEqual(
        file.serialized!.bytes,
      );
      expect(sha256(serialized)).toEqual(file.serialized!.sha256);
    });

    if (file.todos) {
      test("parses every field of every todo", () => {
        expect(parseTodos(readCorpusFile(name)).map(recordOf)).toEqual(
          file.todos,
        );
      });
    }

    if (file.sortedIndexes) {
      test("sorts in the pinned order", () => {
        expect(sortedWithIndexes(name).indexes).toEqual(file.sortedIndexes);
      });
    }

    if (file.samples) {
      test("matches the sampled records", () => {
        const todos = parseTodos(readCorpusFile(name));
        for (const sample of file.samples!) {
          expect(
            recordOf(todos[sample.index]),
            `index ${sample.index}`,
          ).toEqual(sample.todo);
        }
      });
    }
  });
}

for (const [name, file] of errorFiles) {
  const thrown = (): Error & Record<string, unknown> & { code: string } => {
    try {
      parseTodos(readCorpusFile(name));
    } catch (error) {
      return error as Error & Record<string, unknown> & { code: string };
    }
    throw new Error("Expected the corpus file to be rejected");
  };

  describe(name, () => {
    test("keeps the committed fixture bytes", () => {
      expect(readCorpusFile(name)).toHaveLength(file.rawBytes);
    });

    test("fails with the pinned error class and fields", () => {
      const expectedError = file.error!;
      const error = thrown();

      expect(error.name).toEqual(expectedError.name);
      expect(error).toBeInstanceOf(ERROR_CLASSES[expectedError.code!]);
      expect(error.code).toEqual(expectedError.code);
      for (const [field, value] of Object.entries(expectedError)) {
        if (field === "name" || field === "message") continue;
        expect(error[field], field).toEqual(value);
      }
    });

    test("reports the pinned message without leaking file content", () => {
      const probe = CONTENT_PROBES[name];
      // A rejection fixture without a probe would silently skip the leak check.
      expect(probe, `content probe for ${name}`).toBeTypeOf("string");
      expect(probe.length).toBeGreaterThan(0);

      const error = thrown();
      expect(error.message).toEqual(file.error!.message);
      expect(error.message).not.toContain(probe);
    });
  });
}

describe("leading dates", () => {
  test("an open todo consumes one valid leading creation date", () => {
    const todos = todosByName("leading-dates-open.txt");
    const single = containing(todos, "single leading date");

    expect(dateOrNull(single.creationDate)).toEqual("2023-05-04");
    expect(single.text).toEqual("single leading date is a creation date");
    expect(single.toString()).toEqual(
      "2023-05-04 single leading date is a creation date",
    );
  });

  test("two valid leading dates on an open todo stay in the text", () => {
    const ambiguous = containing(
      todosByName("leading-dates-open.txt"),
      "two valid leading dates",
    );

    expect(ambiguous.creationDate).toBeUndefined();
    expect(ambiguous.text).toEqual(
      "2023-05-04 2023-05-05 two valid leading dates stay literal",
    );
    expect(ambiguous.toString()).toEqual(ambiguous.text);
  });

  test("invalid leading dates stay in the text and set no date", () => {
    const todos = todosByName("leading-dates-open.txt");
    const cases: [string, string][] = [
      ["year zero", "0000-01-01 year zero is not a todo date"],
      ["five digit years", "10000-01-01 five digit years are not date tokens"],
      ["month thirteen", "2023-13-01 month thirteen is not a todo date"],
      ["not a leap year", "2023-02-29 2023 is not a leap year"],
      ["april has thirty days", "2023-04-31 april has thirty days"],
      ["day thirty two", "2023-01-32 day thirty two is not a todo date"],
      ["unpadded month", "2023-1-1 unpadded month and day are not date tokens"],
    ];

    for (const [fragment, text] of cases) {
      const todo = containing(todos, fragment);
      expect(todo.creationDate, fragment).toBeUndefined();
      expect(todo.text, fragment).toEqual(text);
      expect(todo.toString(), fragment).toEqual(text);
    }

    const leapDay = containing(todos, "leap day is a valid");
    expect(dateOrNull(leapDay.creationDate)).toEqual("2024-02-29");
    expect(leapDay.toString()).toEqual(
      "2024-02-29 leap day is a valid creation date",
    );
  });

  test("a date-only line exposes a creation date but keeps the literal", () => {
    const dateOnly = todosByName("leading-dates-open.txt").find(
      (todo) => todo.text === "2023-05-04",
    )!;

    expect(dateOrNull(dateOnly.creationDate)).toEqual("2023-05-04");
    expect(dateOnly.toString()).toEqual("2023-05-04");
  });

  test("done lines consume a completion date and an optional creation date", () => {
    const todos = todosByName("leading-dates-done.txt");

    const both = containing(todos, "completion and creation dates");
    expect(dateOrNull(both.completionDate)).toEqual("2023-05-06");
    expect(dateOrNull(both.creationDate)).toEqual("2023-05-04");
    expect(both.toString()).toEqual(
      "x 2023-05-06 2023-05-04 completion and creation dates",
    );

    const completionOnly = containing(todos, "only a completion date");
    expect(dateOrNull(completionOnly.completionDate)).toEqual("2023-05-06");
    expect(completionOnly.creationDate).toBeUndefined();

    const capital = containing(todos, "capital X");
    expect(capital.isDone()).toEqual(false);
    expect(capital.priority).toBeUndefined();

    expect(todos.find((todo) => todo.text === "x")!.isDone()).toEqual(false);

    const later = containing(todos, "dates later in the text");
    expect(later.completionDate).toBeUndefined();
    expect(later.creationDate).toBeUndefined();
    expect(later.text).toEqual(
      "completed later 2023-05-06 dates later in the text stay literal",
    );
  });

  test("invalid and body-less done dates stay literal without duplication", () => {
    const todos = todosByName("leading-dates-done-invalid.txt");

    // The completion date is valid, but the second date is not: both tokens
    // stay in `text`, so serialization must not prepend the completion date.
    const secondInvalid = containing(todos, "second date is invalid");
    expect(dateOrNull(secondInvalid.completionDate)).toEqual("2023-05-04");
    expect(secondInvalid.creationDate).toBeUndefined();
    expect(secondInvalid.text).toEqual(
      "2023-05-04 2023-02-29 second date is invalid so both stay literal",
    );
    expect(secondInvalid.toString()).toEqual(`x ${secondInvalid.text}`);

    // No body at all: both dates are literal and exposed as fields.
    const noBody = todos.find((todo) => todo.text === "2023-05-04 2023-05-05")!;
    expect(dateOrNull(noBody.completionDate)).toEqual("2023-05-04");
    expect(dateOrNull(noBody.creationDate)).toEqual("2023-05-05");
    expect(noBody.toString()).toEqual("x 2023-05-04 2023-05-05");

    const impossible = containing(todos, "impossible completion");
    expect(impossible.completionDate).toBeUndefined();
    expect(impossible.text).toEqual(
      "2023-02-29 impossible completion date stays literal",
    );
  });
});

describe("priorities", () => {
  test("accepts A..Z and rejects everything else", () => {
    const todos = todosByName("priorities.txt");

    expect(todos[0].priority).toEqual("A");
    expect(todos[1].priority).toEqual("Z");

    const lowercase = containing(todos, "lowercase is not a priority");
    expect(lowercase.priority).toBeUndefined();
    expect(lowercase.text).toEqual("(a) lowercase is not a priority");

    const twoLetters = containing(todos, "two letters is not a priority");
    expect(twoLetters.priority).toBeUndefined();
    expect(twoLetters.text).toEqual("(AB) two letters is not a priority");

    const bare = todos.find((todo) => todo.text === "(A)")!;
    expect(bare.priority).toBeUndefined();
    expect(bare.toString()).toEqual("(A)");
  });

  test("a priority with no body keeps an empty text and a trailing space", () => {
    const emptyBody = todosByName("priorities.txt").find(
      (todo) => todo.text === "",
    )!;

    expect(emptyBody.priority).toEqual("A");
    expect(emptyBody.toString()).toEqual("(A) ");
  });

  test("priorities combine with dates, tags and the done marker", () => {
    const todos = todosByName("priorities.txt");

    const withDate = containing(todos, "priority and creation date");
    expect(withDate.priority).toEqual("B");
    expect(dateOrNull(withDate.creationDate)).toEqual("2024-03-01");

    const done = containing(todos, "done with priority and completion date");
    expect(done.isDone()).toEqual(true);
    expect(done.priority).toEqual("A");
    expect(dateOrNull(done.completionDate)).toEqual("2024-03-02");
    expect(done.toString()).toEqual(
      "x (A) 2024-03-02 done with priority and completion date",
    );
  });
});

describe("projects and contexts", () => {
  const todos = () => todosByName("projects-contexts.txt");

  test("matches tag names only at a word boundary", () => {
    const xAtY = containing(todos(), "at sign after a word is not a context");
    expect([...xAtY.contexts]).toEqual([]);
    expect(xAtY.text).toEqual("x@y at sign after a word is not a context");

    const email = containing(todos(), "email shaped text");
    expect([...email.contexts]).toEqual([]);

    const explicit = containing(todos(), "explicit context");
    expect([...explicit.contexts]).toEqual(["example.com"]);
  });

  test("keeps leading, multiple and duplicate names once each", () => {
    const list = todos();

    expect([...list[0].projects]).toEqual(["alpha"]);
    expect([...list[1].contexts]).toEqual(["beta"]);
    expect([...containing(list, "two projects").projects]).toEqual([
      "alpha",
      "beta",
    ]);
    expect([
      ...containing(list, "duplicate project collapses").projects,
    ]).toEqual(["alpha"]);
    expect([
      ...containing(list, "duplicate context collapses").contexts,
    ]).toEqual(["alpha"]);
  });

  test("stops the name at the first unsupported character", () => {
    const list = todos();

    const names = containing(list, "names allow dots");
    expect([...names.projects]).toEqual(["proj.one", "proj-3"]);
    expect([...names.contexts]).toEqual(["ctx_two", "2024"]);

    const slash = containing(list, "slash ends the project name");
    expect([...slash.projects]).toEqual(["a"]);
    expect(slash.text).toContain("+a/b");

    const adjacent = containing(list, "adjacent plus");
    expect([...adjacent.projects]).toEqual(["a"]);

    expect([...containing(list, "comma ends the project").projects]).toEqual([
      "trailing",
    ]);
    expect([...containing(list, "period ends the context").contexts]).toEqual([
      "trailing.",
    ]);
    expect([...containing(list, "plus inside parentheses").projects]).toEqual(
      [],
    );
    expect([
      ...containing(list, "at sign inside parentheses").contexts,
    ]).toEqual([]);
  });
});

describe("tags", () => {
  const todos = () => todosByName("tags.txt");

  test("parses key:value pairs and keeps duplicate keys as arrays", () => {
    const list = todos();

    expect(containing(list, "single tag").tags).toEqual({ alpha: "one" });

    const duplicate = containing(list, "duplicate key becomes an array");
    expect(duplicate.tags).toEqual({ beta: ["one", "two"] });
    // Serialization joins array values with commas.
    expect(duplicate.toString()).toEqual(
      "duplicate key becomes an array beta:one,two",
    );
  });

  test("tag keys are case sensitive and limited to A-Za-z", () => {
    const list = todos();

    const upper = containing(list, "uppercase key is distinct");
    expect(upper.tags).toEqual({ Due: "2026-01-01" });
    expect(upper.isOverdue()).toEqual(false);

    const lower = containing(list, "lowercase due is a date tag");
    expect(lower.tags).toEqual({ due: "2026-01-01" });
    expect(lower.isOverdue()).toEqual(true);

    const digits = containing(list, "digits are not allowed");
    expect(digits.tags).toEqual({});
    expect(digits.text).toEqual("h1:1 digits are not allowed in tag keys");

    const underscore = containing(list, "underscores are not allowed");
    expect(underscore.tags).toEqual({});
    expect(underscore.text).toEqual(
      "a_b:1 underscores are not allowed in tag keys",
    );
  });

  test("a tag needs a value and may start a line", () => {
    const list = todos();

    const empty = containing(list, "a key with no value");
    expect(empty.tags).toEqual({});
    expect(empty.text).toEqual("empty: a key with no value is not a tag");

    const atStart = containing(list, "tag at the start of a line");
    expect(atStart.tags).toEqual({ due: "2025-01-01" });
    expect(atStart.text).toEqual("tag at the start of a line");
  });

  test("scans URL-shaped and punctuated values as tags", () => {
    const list = todos();

    const url = containing(list, "is scanned as a tag");
    expect(url.tags).toEqual({ http: "//example.com" });
    expect(url.text).toEqual("is scanned as a tag");
    expect(url.toString()).toEqual("is scanned as a tag http://example.com");

    expect(containing(list, "punctuation stays in the value").tags).toEqual({
      note: "hello,world!",
    });
    expect(containing(list, "equals signs stay in the value").tags).toEqual({
      eq: "a=b=c",
    });
  });

  test("tags are re-serialized after the text", () => {
    const afterDone = containing(todos(), "tag after a done marker");

    expect(afterDone.isDone()).toEqual(true);
    expect(afterDone.tags).toEqual({ task: "value" });
    expect(afterDone.toString()).toEqual(
      "x tag after a done marker task:value",
    );
  });
});

describe("due, threshold and hidden", () => {
  const todos = () => todosByName("due-threshold-hidden.txt");

  test("due is overdue on and after the due day only", () => {
    const list = todos();

    expect(containing(list, "due in the past").isOverdue()).toEqual(true);
    expect(containing(list, "due today").isOverdue()).toEqual(true);
    expect(containing(list, "due tomorrow").isOverdue()).toEqual(false);
    expect(containing(list, "invalid due").isOverdue()).toEqual(false);
    expect(containing(list, "uppercase Due").isOverdue()).toEqual(false);
    expect(containing(list, "no value means no due date").tags).toEqual({});
  });

  test("an array-valued due is not overdue", () => {
    const arrayDue = containing(todos(), "duplicate due is an array");

    expect(arrayDue.tags.due).toEqual(["2020-01-01", "2020-02-01"]);
    expect(arrayDue.isOverdue()).toEqual(false);
    expect(arrayDue.toString()).toContain("due:2020-01-01,2020-02-01");
  });

  test("h hides only a non-zero value", () => {
    const list = todos();

    expect(containing(list, "hidden by h one").isHidden()).toEqual(true);
    expect(containing(list, "hidden by h one").isVisibleInOverview()).toEqual(
      false,
    );
    expect(containing(list, "h zero does not hide").isHidden()).toEqual(false);
    expect(containing(list, "any non zero h hides").isHidden()).toEqual(true);

    const arrayHidden = containing(list, "duplicate h is an array");
    expect(arrayHidden.tags.h).toEqual(["1", "0"]);
    expect(arrayHidden.isHidden()).toEqual(true);
  });

  test("t hides only future thresholds", () => {
    const list = todos();

    expect(
      containing(list, "future threshold hides").isVisibleInOverview(),
    ).toEqual(false);
    expect(
      containing(list, "today threshold is visible").isVisibleInOverview(),
    ).toEqual(true);
    expect(
      containing(list, "past threshold is visible").isVisibleInOverview(),
    ).toEqual(true);

    // Feb 29 2027 does not exist. A lenient parser that clamped it to the
    // future would hide the todo, so the invalid value must be future-looking.
    const invalid = containing(list, "invalid threshold is visible");
    expect(invalid.tags.t).toEqual("2027-02-29");
    expect(invalid.isVisibleInOverview()).toEqual(true);

    expect(
      containing(list, "no value means visible").isVisibleInOverview(),
    ).toEqual(true);
  });

  test("hidden and overdue are independent", () => {
    const both = containing(todos(), "hidden and overdue at once");

    expect(both.isHidden()).toEqual(true);
    expect(both.isOverdue()).toEqual(true);
    expect(both.isVisibleInOverview()).toEqual(false);
  });
});

describe("recurrence", () => {
  const todos = () => todosByName("recurrence.txt");

  test("valid values plan the next due date from the completion time", () => {
    const expectations: [string, string][] = [
      ["1d", "2026-11-16"],
      ["2w", "2026-11-29"],
      ["3m", "2027-02-15"],
      ["1y", "2027-11-15"],
      ["+1d", "2026-11-16"],
    ];

    for (const [value, nextDue] of expectations) {
      const todo = withTagValue(todos(), "rec", value)!;
      expect(todo, value).toBeDefined();

      const { updated, recurring, recurrenceError } = todo.toggleState();
      expect(recurrenceError, value).toBeUndefined();
      expect(updated.isDone(), value).toEqual(true);

      expect(recurring, value).toBeDefined();
      expect(recurring!.isDone(), value).toEqual(false);
      expect(recurring!.completionDate, value).toBeUndefined();
      expect(recurring!.text, value).toEqual(todo.text);
      expect(recurring!.tags.rec, value).toEqual(value);
      expect(recurring!.tags.due, value).toEqual(nextDue);
    }
  });

  test("the next due date comes from the completion time, not the due date", () => {
    const list = todos();

    // Toggled at the pinned clock (2026-11-15T12:00:00): the copy is due
    // completion + amount, never existing due + amount.
    const cases: {
      fragment: string;
      due: string;
      fromCompletion: string;
      fromDue: string;
    }[] = [
      {
        fragment: "the due date does not move the next due date",
        due: "2026-11-01",
        fromCompletion: "2026-11-17", // 2026-11-15 + 2 days
        fromDue: "2026-11-03", // 2026-11-01 + 2 days
      },
      {
        fragment: "the month copy uses the completion time",
        due: "2026-12-31",
        fromCompletion: "2026-12-15", // 2026-11-15 + 1 month
        fromDue: "2027-01-31", // 2026-12-31 + 1 month
      },
    ];

    for (const { fragment, due, fromCompletion, fromDue } of cases) {
      const todo = containing(list, fragment);
      expect(todo.tags.due, fragment).toEqual(due);

      const { updated, recurring, recurrenceError } = todo.toggleState();
      expect(recurrenceError, fragment).toBeUndefined();
      expect(dateOrNull(updated.completionDate), fragment).toEqual(
        "2026-11-15",
      );

      expect(recurring, fragment).toBeDefined();
      expect(recurring!.isDone(), fragment).toEqual(false);
      expect(recurring!.completionDate, fragment).toBeUndefined();
      expect(recurring!.tags.due, fragment).toEqual(fromCompletion);
      expect(recurring!.tags.due, fragment).not.toEqual(fromDue);
    }
  });

  test("invalid and out-of-range values plan nothing", () => {
    const list = todos();

    for (const value of ["abc", "1D"]) {
      const result = withTagValue(list, "rec", value)!.toggleState();
      expect(result.recurring, value).toBeUndefined();
      expect(result.recurrenceError, value).toEqual(INVALID_RECURRENCE);
    }

    for (const value of ["0d", "10000d"]) {
      const result = withTagValue(list, "rec", value)!.toggleState();
      expect(result.recurring, value).toBeUndefined();
      expect(result.recurrenceError, value).toEqual(OUT_OF_RANGE_RECURRENCE);
    }
  });

  test("a duplicate rec becomes an array and is invalid", () => {
    const duplicate = containing(todos(), "duplicate rec becomes an array");

    expect(duplicate.tags.rec).toEqual(["1d", "2w"]);

    const result = duplicate.toggleState();
    expect(result.recurring).toBeUndefined();
    expect(result.recurrenceError).toEqual(INVALID_RECURRENCE);
  });
});

describe("unicode, tabs and blank lines", () => {
  test("keeps unicode, combining marks, CJK, RTL and emoji", () => {
    const todos = todosByName("unicode.txt");

    expect(todos).toHaveLength(8);
    expect(todos[3].text.startsWith("e\u0301")).toEqual(true);
    expect(todos[5].text).toContain("\u200d");
    expect(todos[2].text).toContain("עברית");
    expect(todos[1].text).toContain("日本語のタスク");

    const emoji = containing(todos, "emoji in text and value");
    expect(emoji.tags).toEqual({ party: "🎉" });
    expect(emoji.toString()).toEqual("🎉 emoji in text and value party:🎉");

    const done = containing(todos, "done with unicode and dates");
    expect(dateOrNull(done.completionDate)).toEqual("2024-05-01");
    expect(dateOrNull(done.creationDate)).toEqual("2024-04-30");
  });

  test("keeps inner tabs and trims the edges", () => {
    const todos = todosByName("tabs.txt");

    expect(todos[0].text).toEqual("tab\tinside\tline");
    expect(todos[0].toString()).toEqual("tab\tinside\tline");

    // A tab satisfies `x` and the priority separator.
    expect(todos[1].isDone()).toEqual(true);
    expect(todos[1].text).toEqual("tab after the done marker");
    expect(todos[3].priority).toEqual("A");
    expect(dateOrNull(todos[4].creationDate)).toEqual("2023-05-04");

    expect(todos[2].text).toEqual("leading tab is trimmed from the text");
    expect(todos[5].toString()).toEqual("trailing tab is trimmed");
  });

  test("blank and whitespace-only lines are returned as-is and dropped", () => {
    const lines = validateTodoFileContent(
      readCorpusFile("blank-lines.txt").toString("utf8"),
      getReadLimits(),
    );

    expect(lines).toEqual([
      "First todo",
      "",
      "Second todo after a blank line",
      "   ",
      "Third todo after a space-only line",
      "\t",
      "   \t  ",
      "Fourth todo after a tab-only line",
      "",
      "",
    ]);
    expect(parseTodos(readCorpusFile("blank-lines.txt"))).toHaveLength(4);
  });
});

describe("line endings", () => {
  test("CRLF is normalized to LF on save", () => {
    const raw = readCorpusFile("crlf.txt");
    expect(raw.toString("utf8")).toContain("\r\n");

    const serialized = serializeTodos(parseTodos(raw));
    expect(serialized).not.toContain("\r");
    expect(serialized).toEqual(
      [
        "First CRLF task @home",
        "x 2024-02-01 2024-01-25 Completed CRLF task +work due:2024-02-10",
        "(A) Priority CRLF task +proj @ctx",
        "CRLF task with unicode café",
      ].join("\n") + "\n",
    );
  });

  test("a missing final newline is restored on save", () => {
    const todos = parseTodos(readCorpusFile("no-trailing-newline.txt"));
    expect(todos).toHaveLength(3);

    const serialized = serializeTodos(todos);
    expect(serialized.endsWith("\n")).toEqual(true);
    expect(Buffer.byteLength(serialized, "utf8")).toEqual(
      expected.files["no-trailing-newline.txt"].serialized!.bytes,
    );
  });

  test("an empty file round-trips as a single newline", () => {
    expect(parseTodos(readCorpusFile("empty.txt"))).toEqual([]);
    expect(serializeTodos([])).toEqual("\n");
  });

  test("readTodosFromFile matches the pinned serialization", async () => {
    const todos = await readTodosFromFile(
      join(CORPUS_DIR, "real-world-lf.txt"),
    );

    expect(todos).toHaveLength(51);
    expect(sha256(serializeTodos(todos))).toEqual(
      expected.files["real-world-lf.txt"].serialized!.sha256,
    );
  });
});

describe("long-line-8192.txt", () => {
  test("pins the accepted legacy line length", () => {
    const [todo, ...rest] = todosByName("long-line-8192.txt");

    // The full record (text, hash, serialized bytes) is pinned in
    // `expected.json`; these are the parts that make the limit visible.
    expect(rest).toEqual([]);
    expect(todo.text).toHaveLength(8_192);
    expect(todo.toString().length).toEqual(8_192);
    expect(todo.tags).toEqual({});
    expect(todo.projects.size).toEqual(0);
    expect(todo.contexts.size).toEqual(0);
    expect(todo.isDone()).toEqual(false);
  });
});

describe("sort-order.txt", () => {
  const name = "sort-order.txt";

  test("orders by state, context, overdue, priority and keeps ties stable", () => {
    const { indexes, todos } = sortedWithIndexes(name);

    // The human-reviewed order; the per-file test pins the same value in
    // `expected.json` for CP1 to reuse.
    expect(indexes).toEqual([4, 1, 10, 11, 9, 8, 7, 6, 5, 0, 2, 3]);

    // Uncontextualised todos first, overdue before the same-context ties.
    expect(todos[0].text).toEqual("overdue without context");
    expect(todos.slice(0, 10).every((todo) => !todo.isDone())).toEqual(true);
    expect(todos.slice(10).every((todo) => todo.isDone())).toEqual(true);

    // Contexts in alphabetical order, uncontextualised first.
    expect([
      ...new Set(todos.map((todo) => [...todo.contexts][0] ?? "-")),
    ]).toEqual(["-", "alpha", "home", "work"]);

    // Inside @alpha: overdue first, then priority A, B, then unprioritised.
    expect(
      todos
        .filter((todo) => todo.contexts.has("alpha"))
        .map((todo) => todo.priority ?? "-"),
    ).toEqual(["-", "A", "B", "-"]);
    expect(
      todos
        .filter((todo) => todo.contexts.has("alpha"))
        .map((todo) => todo.isOverdue()),
    ).toEqual([true, false, false, false]);
  });

  test("duplicate lines keep their input order", () => {
    const parsed = todosByName(name);
    const duplicates = parsed.filter(
      (todo) => todo.text === "brain dump duplicate line",
    );
    expect(duplicates).toHaveLength(2);
    expect(duplicates[0].id).not.toEqual(duplicates[1].id);

    const sorted = sortByImportance(parsed).filter(
      (todo) => todo.text === "brain dump duplicate line",
    );
    expect(sorted.map((todo) => todo.id)).toEqual(
      duplicates.map((todo) => todo.id),
    );
  });
});

describe("invalid UTF-8 and a UTF-8 BOM", () => {
  test("invalid bytes decode to U+FFFD and grow on save", () => {
    const raw = readCorpusFile("invalid-utf8.txt");
    const text = raw.toString("utf8");

    expect(text).toContain("caf\uFFFD latin-1");
    expect(text).toContain("\uFFFD leading invalid byte");
    expect(text).toContain("truncated \uFFFD sequence");
    expect(text).toContain("plain ascii line is unchanged");

    const todos = todosByName("invalid-utf8.txt");
    expect(todos.map((todo) => todo.text)).toEqual([
      "caf\uFFFD latin-1 byte becomes a replacement character",
      "\uFFFD leading invalid byte stays in the text",
      "truncated \uFFFD sequence at the end",
      "plain ascii line is unchanged",
    ]);

    // U+FFFD is three UTF-8 bytes, so the lossy decode makes the file larger.
    const expectedFile = expected.files["invalid-utf8.txt"];
    expect(expectedFile.serialized!.bytes).toBeGreaterThan(
      expectedFile.rawBytes,
    );
    expect(sha256(serializeTodos(todos))).toEqual(
      expectedFile.serialized!.sha256,
    );
  });

  test("a leading BOM survives the raw line but is trimmed from the todo", () => {
    const raw = readCorpusFile("bom.txt");
    expect([...raw.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);

    // The BOM is part of the first line the validator returns...
    const lines = validateTodoFileContent(
      raw.toString("utf8"),
      getReadLimits(),
    );
    expect(lines[0]).toEqual("\uFEFFfirst todo after a BOM");

    // ...but `String#trim()` treats U+FEFF as whitespace, so both the loader's
    // blank-line filter (`line.trim()`) and the text trim drop it. The todo
    // therefore never serializes the BOM: saving loses it.
    const todos = todosByName("bom.txt");
    expect(todos.map((todo) => todo.text)).toEqual([
      "first todo after a BOM",
      "second todo",
    ]);
    expect(lines.filter((line) => line.trim())).toHaveLength(2);
    expect(serializeTodos(todos)).toEqual(
      "first todo after a BOM\nsecond todo\n",
    );

    const serialized = serializeTodos(todos);
    expect(serialized).not.toContain("\uFEFF");
    expect(Buffer.byteLength(serialized, "utf8")).toEqual(
      expected.files["bom.txt"].serialized!.bytes,
    );
  });
});

describe("write path", () => {
  test("round-trips real-world-lf.txt through writeTodosToFile", async () => {
    const name = "real-world-lf.txt";
    const expectedFile = expected.files[name];

    await withTempDir(async (dir) => {
      const filename = join(dir, name);
      const todos = await readTodosFromFile(join(CORPUS_DIR, name));
      await writeTodosToFile(todos, filename);

      const written = readFileSync(filename);
      expect(written.toString("utf8")).toEqual(serializeTodos(todos));
      expect(written).toHaveLength(expectedFile.serialized!.bytes);
      expect(sha256(written.toString("utf8"))).toEqual(
        expectedFile.serialized!.sha256,
      );

      const reloaded = await readTodosFromFile(filename);
      expect(reloaded.map(recordOf)).toEqual(expectedFile.todos);
    });
  });

  test("reloading tags.txt pins the duplicate-tag non-idempotence", async () => {
    const name = "tags.txt";
    const expectedFile = expected.files[name];

    await withTempDir(async (dir) => {
      const filename = join(dir, name);
      await writeTodosToFile(
        await readTodosFromFile(join(CORPUS_DIR, name)),
        filename,
      );

      const written = readFileSync(filename);
      expect(written).toHaveLength(expectedFile.serialized!.bytes);
      expect(sha256(written.toString("utf8"))).toEqual(
        expectedFile.serialized!.sha256,
      );

      // `beta:one beta:two` serializes as `beta:one,two`. Reparsing that
      // yields the scalar "one,two", not an array, so the in-memory shape is
      // not stable across a save. A Rust port that split comma values on read
      // would restore the array and must fail this pin.
      const reloaded = await readTodosFromFile(filename);
      const duplicate = containing(reloaded, "duplicate key becomes an array");
      expect(duplicate.tags).toEqual({ beta: "one,two" });
      expect(Array.isArray(duplicate.tags.beta)).toEqual(false);
      expect(duplicate.toString()).toEqual(
        "duplicate key becomes an array beta:one,two",
      );

      // After the first save the text is stable: a second save is byte-equal.
      await writeTodosToFile(reloaded, filename);
      expect(readFileSync(filename).equals(written)).toEqual(true);

      const expectedDuplicate = expectedFile.todos!.find(
        (record) => record.text === "duplicate key becomes an array",
      )!;
      expect(recordOf(duplicate)).toEqual({
        ...expectedDuplicate,
        tags: [["beta", "one,two"]],
        toString: "duplicate key becomes an array beta:one,two",
        hash: "duplicate key becomes an array beta:one,two",
      });
    });
  });
});

describe("large-10000.txt", () => {
  test("keeps the structural invariants of the generated file", () => {
    const todos = todosByName("large-10000.txt");

    expect(todos).toHaveLength(10_000);
    expect(new Set(todos.map((todo) => todo.id)).size).toEqual(10_000);
    expect(todos.filter((todo) => todo.isDone())).toHaveLength(1_000);
    expect(todos.filter((todo) => todo.isHidden())).toHaveLength(1_000);
    expect(todos.filter((todo) => todo.isOverdue())).toHaveLength(3_000);
    expect(todos.filter((todo) => todo.isVisibleInOverview())).toHaveLength(
      9_000,
    );
    expect(todos.filter((todo) => todo.projects.size > 0)).toHaveLength(6_000);
    expect(todos.filter((todo) => todo.contexts.size > 0)).toHaveLength(4_000);

    // Every generated line keeps a body, and tags are moved to the end.
    expect(todos.every((todo) => todo.text.length > 0)).toEqual(true);
    expect(todos.every((todo) => !/\s\w+:\S/.test(todo.text))).toEqual(true);
  });

  test("keeps the first and last serialized lines", () => {
    const todos = todosByName("large-10000.txt");
    const lines = serializeTodos(todos).trimEnd().split("\n");

    expect(lines).toHaveLength(10_000);
    expect(lines[0]).toEqual(
      "(A) 2024-01-01 Task 0 +proj0 @ctx0 due:2024-02-01",
    );
    expect(lines.at(-1)).toEqual("Note 9999 key:value9999");
  });
});

describe("row model", () => {
  test("keeps the uncategorized None header", () => {
    const todos = todosByName("blank-lines.txt");
    const entries = createIndexes(todos);

    expect(entries).toHaveLength(todos.length + 1);
    expect(entries[0]).toEqual({
      type: IndexType.context,
      todoCount: 4,
      contextName: "None",
    });
    expect(entries.slice(1).map((entry) => entry.type)).toEqual(
      todos.map(() => IndexType.todo),
    );
  });
});

describe("file sync cadence", () => {
  test("pins the save and reload debounce defaults", () => {
    // PLAN.md §7: 50 ms saves, 500 ms reloads. The read-only recovery after a
    // failed load is covered by todo-context-lifecycle.test.tsx.
    expect(DEFAULT_SAVE_DEBOUNCE_MS).toEqual(50);
    expect(DEFAULT_RELOAD_DEBOUNCE_MS).toEqual(500);
  });
});

describe("file limits", () => {
  test("rejects a 8193-character line", async () => {
    await withTempDir(async (dir) => {
      const filename = join(dir, "todos.txt");
      await Runtime.writeTextFile(filename, "a".repeat(8193) + "\n");
      const error = (await rejection(
        readTodosFromFile(filename),
      )) as TodoLineLengthLimitError;

      expect(error).toBeInstanceOf(TodoLineLengthLimitError);
      expect(error.code).toEqual("LINE_TOO_LONG");
      expect(error.lineNumber).toEqual(1);
      expect(error.length).toEqual(8193);
      expect(error.maxLineChars).toEqual(8192);
      expect(error.message).toEqual(
        "Todo file line 1 is 8193 characters; the limit is 8192. " +
          "Shorten the line or raise THAR_MAX_LINE_CHARS. Nothing was changed.",
      );
      expect(error.message).not.toContain("aaaa");
    });
  });

  test("rejects 10 001 lines through readTodosFromFile", async () => {
    await withTempDir(async (dir) => {
      const filename = join(dir, "todos.txt");
      await Runtime.writeTextFile(filename, "task\n".repeat(10_001));
      const error = (await rejection(
        readTodosFromFile(filename),
      )) as TodoLineCountLimitError;

      expect(error).toBeInstanceOf(TodoLineCountLimitError);
      expect(error.code).toEqual("TOO_MANY_LINES");
      expect(error.lineCount).toEqual(10_001);
      expect(error.maxReadTodos).toEqual(10_000);
      expect(error.message).toEqual(
        "Todo file has 10001 lines; the limit is 10000. " +
          "Trim the file or raise THAR_MAX_READ_TODOS. Nothing was changed.",
      );
      expect(error.message).not.toContain("task");
    });
  });

  test("rejects a file larger than 1 MiB through readTodosFromFile", async () => {
    await withTempDir(async (dir) => {
      const filename = join(dir, "todos.txt");
      await Runtime.writeTextFile(filename, "x".repeat(1024 * 1024 + 1));
      const error = (await rejection(
        readTodosFromFile(filename),
      )) as TodoFileTooLargeError;

      expect(error).toBeInstanceOf(TodoFileTooLargeError);
      expect(error.code).toEqual("FILE_TOO_LARGE");
      expect(error.actualBytes).toEqual(1024 * 1024 + 1);
      expect(error.maxBytes).toEqual(1024 * 1024);
      expect(error.message).toEqual(
        "Todo file is 1048577 bytes; the limit is 1048576 bytes. " +
          "Trim the file or raise THAR_MAX_FILE_BYTES. Nothing was changed.",
      );
      expect(error.message).not.toContain("xxxx");
    });
  });
});
