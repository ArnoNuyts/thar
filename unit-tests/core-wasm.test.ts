import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  buildRowsWithCore,
  getCoreMode,
  parseFileWithCore,
  resetCoreBridgeForTests,
  serializeTodosWithCore,
  setCollatorLocaleForTests,
  setRowBuilderForTests,
  setSerializerForTests,
} from "../logic/core-wasm.ts";
import { formatDateTag } from "../logic/dates.ts";
import { createIndexes } from "../logic/indexes.ts";
import {
  TodoControlCharacterError,
  TodoFileTooLargeError,
  TodoFileValidationError,
  TodoLineCountLimitError,
  TodoLineLengthLimitError,
} from "../logic/limits.ts";
import {
  filterBySearch,
  filterHidden,
  sortByImportance,
} from "../logic/Todos.ts";
import { Todo } from "../logic/todo.ts";
import {
  readTodosFromFile,
  serializeTodosForWrite,
} from "../logic/todo-file-helpers.ts";
import { IndexType } from "../types/enums.ts";
import {
  defaultCollatorLocale,
  isEnglishCollator,
} from "../utils/collation-locale.ts";
import { Runtime } from "../utils/runtime.ts";
import { restoreRuntimeMocks } from "./test-utils.ts";

/**
 * CP5: the Rust bridge is the default core.
 *
 * The main Node test matrix must not require Rust or a built
 * `crates/thar-wasm/pkg/`, so these tests drive the real loader with a tiny
 * CommonJS test double written into a temp directory and named by
 * `THAR_CORE_WASM`. When the real package happens to exist (the Rust WASM CI
 * job and a developer checkout) extra tests run against it.
 */

const ENV_KEYS = [
  "THAR_CORE",
  "THAR_CORE_WASM",
  "THAR_MAX_FILE_BYTES",
  "THAR_MAX_READ_TODOS",
  "THAR_MAX_LINE_CHARS",
] as const;

const savedEnv = new Map<string, string | undefined>();

const setEnv = (key: (typeof ENV_KEYS)[number], value: string | undefined) => {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
  resetCoreBridgeForTests();
  restoreRuntimeMocks();
  vi.restoreAllMocks();
});

/** Write a CommonJS package (or a broken one) and point the loader at it. */
const fakePackage = async (
  dir: string,
  body: string,
  name = "thar_wasm.cjs",
): Promise<string> => {
  const path = join(dir, name);
  await Runtime.writeTextFile(path, body);
  setEnv("THAR_CORE_WASM", path);
  resetCoreBridgeForTests();
  // The adapter's row path refuses non-English host collators. Every fake in
  // this file behaves as if it ran on the pinned en-US order, so the suite
  // stays host-locale independent; guard tests override this explicitly.
  setCollatorLocaleForTests("en-US");
  return path;
};

const envelopePackage = (envelope: unknown, name?: string) => {
  const json = JSON.stringify(envelope);
  return async (dir: string) =>
    fakePackage(
      dir,
      `const envelope = ${JSON.stringify(json)};
module.exports = {
  coreVersion: () => "0.1.0-test",
  parseFile: () => envelope,
  parseFileWithLimits: () => envelope,
};
`,
      name,
    );
};

const record = (line: string, fields: Record<string, unknown> = {}) => ({
  text: line,
  state: "todo",
  priority: null,
  completionDate: null,
  creationDate: null,
  projects: [],
  contexts: [],
  tags: [],
  isDone: false,
  isHidden: false,
  isVisibleInOverview: true,
  isOverdue: false,
  toString: line,
  hash: line,
  ...fields,
});

const withTempDir = async (fn: (dir: string) => Promise<void>) => {
  const dir = await Runtime.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Runtime.remove(dir, { recursive: true });
  }
};

describe("WASM adapter fallback", () => {
  test("a missing package resolves to undefined and never throws", async () => {
    await withTempDir(async (dir) => {
      const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
      setEnv("THAR_CORE_WASM", join(dir, "not-built", "thar_wasm.js"));
      resetCoreBridgeForTests();

      expect(() => parseFileWithCore("one", "2026-11-15")).not.toThrow();
      expect(parseFileWithCore("one", "2026-11-15")).toBeUndefined();
      // Logged at debug level, once per process.
      expect(debug).toHaveBeenCalledTimes(1);
      expect(debug.mock.calls[0]?.[0]).toContain("WASM package not built");
    });
  });

  test("a package that throws on load is ignored", async () => {
    await withTempDir(async (dir) => {
      const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
      await fakePackage(dir, 'throw new Error("load failure");\n');

      expect(parseFileWithCore("one", "2026-11-15")).toBeUndefined();
      expect(debug).toHaveBeenCalledTimes(1);
      expect(debug.mock.calls[0]?.[0]).toContain("unloadable WASM package");
    });
  });

  test("a malformed envelope is ignored", async () => {
    await withTempDir(async (dir) => {
      const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
      await fakePackage(
        dir,
        'module.exports = { coreVersion: () => "x", parseFile: () => "{}", parseFileWithLimits: () => "{}" };\n',
      );

      expect(parseFileWithCore("one", "2026-11-15")).toBeUndefined();
      expect(debug.mock.calls.at(-1)?.[0]).toContain("malformed parseFile");
    });
  });

  test("an invalid envelope never echoes its text on debug", async () => {
    await withTempDir(async (dir) => {
      // Node's `JSON.parse` message quotes the input; a todo line is its own
      // hash, so a snippet would leak content.
      const secret = "SECRET-todo-text-9f43";
      await fakePackage(
        dir,
        `module.exports = {
  coreVersion: () => "0.2.0-test",
  parseFile: () => '{"ok":true,"todos":[${secret}',
  parseFileWithLimits: () => '{"ok":true,"todos":[${secret}',
};
`,
      );
      const debug = vi.spyOn(console, "debug").mockImplementation(() => {});

      expect(parseFileWithCore(`${secret}\n`, "2026-11-15")).toBeUndefined();

      const logged = debug.mock.calls.map((call) => String(call[0])).join("\n");
      expect(logged).toContain("SyntaxError");
      expect(logged).not.toContain(secret);
    });
  });

  test("an unrelated working directory cannot plant a package", async () => {
    const dir = await Runtime.makeTempDir();
    const originalCwd = process.cwd();
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    try {
      const planted = join(dir, "crates", "thar-wasm", "pkg", "thar_wasm.js");
      mkdirSync(dirname(planted), { recursive: true });
      const plantedEnvelope = JSON.stringify(
        JSON.stringify({
          ok: true,
          todos: [record("planted-cwd-marker")],
        }),
      );
      await Runtime.writeTextFile(
        planted,
        `module.exports = {
  coreVersion: () => "planted",
  parseFile: () => ${plantedEnvelope},
  parseFileWithLimits: () => ${plantedEnvelope},
};
`,
      );

      setEnv("THAR_CORE_WASM", undefined);
      resetCoreBridgeForTests();
      process.chdir(dir);

      const parsed = parseFileWithCore("one", "2026-11-15");
      expect(JSON.stringify(parsed ?? null)).not.toContain(
        "planted-cwd-marker",
      );

      if (!existsSync(REAL_PACKAGE)) {
        expect(parsed).toBeUndefined();
        expect(debug.mock.calls[0]?.[0]).toContain("WASM package not built");
      }
    } finally {
      process.chdir(originalCwd);
      await Runtime.remove(dir, { recursive: true });
    }
  });

  test("maps the ok envelope with every contract field", async () => {
    await withTempDir(async (dir) => {
      await envelopePackage({
        ok: true,
        todos: [
          record("alpha:one single tag", {
            tags: [["alpha", "one"]],
            toString: "single tag alpha:one",
            hash: "single tag alpha:one",
          }),
        ],
      })(dir);

      const parsed = parseFileWithCore("alpha:one single tag\n", "2026-11-15");

      expect(parsed).toEqual({
        ok: true,
        todos: [
          {
            ...record("alpha:one single tag", {
              tags: [["alpha", "one"]],
              toString: "single tag alpha:one",
              hash: "single tag alpha:one",
            }),
          },
        ],
      });
    });
  });

  test("forwards the effective read limits to parseFileWithLimits", async () => {
    await withTempDir(async (dir) => {
      const calls = join(dir, "limits.json");
      await fakePackage(
        dir,
        `const fs = require("node:fs");
module.exports = {
  coreVersion: () => "0.2.0-test",
  parseFile: () => "{}",
  parseFileWithLimits: (_text, today, maxFileBytes, maxReadTodos, maxLineChars) => {
    fs.writeFileSync(${JSON.stringify(calls)}, JSON.stringify({ today, maxFileBytes, maxReadTodos, maxLineChars }));
    return "{}";
  },
};
`,
      );

      parseFileWithCore("one", "2026-11-15", {
        maxFileBytes: 1_024,
        maxReadTodos: 2,
        maxLineChars: 3,
      });

      expect(JSON.parse(readFileSync(calls, "utf8"))).toEqual({
        today: "2026-11-15",
        maxFileBytes: 1_024,
        maxReadTodos: 2,
        maxLineChars: 3,
      });
    });
  });

  test("a rejected envelope keeps the bounded error fields", async () => {
    await withTempDir(async (dir) => {
      const error = {
        name: "TodoControlCharacterError",
        code: "CONTROL_CHARACTER",
        lineNumber: 2,
        codePoint: 0,
        message: "Todo file line 2 contains a control character.",
      };
      await envelopePackage({ ok: false, error })(dir);

      expect(parseFileWithCore("\u0000\n", "2026-11-15")).toEqual({
        ok: false,
        error,
      });
    });
  });
});

describe("THAR_CORE default (CP5)", () => {
  test("unset selects rust and THAR_CORE=ts is the escape hatch", () => {
    setEnv("THAR_CORE", undefined);
    expect(getCoreMode()).toBe("rust");

    setEnv("THAR_CORE", "rust");
    expect(getCoreMode()).toBe("rust");

    setEnv("THAR_CORE", "ts");
    expect(getCoreMode()).toBe("ts");

    // An empty value is treated as unset: the default applies.
    setEnv("THAR_CORE", "");
    expect(getCoreMode()).toBe("rust");
  });

  test("an unknown value keeps the rust default and logs once, without echoing it", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});

    setEnv("THAR_CORE", "SECRET-mode-value");
    expect(getCoreMode()).toBe("rust");
    expect(getCoreMode()).toBe("rust");
    expect(debug).toHaveBeenCalledTimes(1);
    const logged = String(debug.mock.calls[0]?.[0]);
    expect(logged).toContain("unrecognized THAR_CORE value");
    expect(logged).not.toContain("SECRET");
  });

  test("the ts escape hatch and the rust default parse the same file", async () => {
    await withTempDir(async (dir) => {
      const filename = join(dir, "todo.txt");
      await Runtime.writeTextFile(
        filename,
        "x 2024-03-02 alpha:one done +p @c\nopen due:2026-11-14\n",
      );

      setEnv("THAR_CORE", "ts");
      expect(getCoreMode()).toBe("ts");
      const ts = await readTodosFromFile(filename);

      // No package built in this process: the TS fallback must still work, and
      // it must not change the list.
      setEnv("THAR_CORE", undefined);
      setEnv("THAR_CORE_WASM", join(dir, "missing", "thar_wasm.js"));
      resetCoreBridgeForTests();
      vi.spyOn(console, "debug").mockImplementation(() => {});
      const rust = await readTodosFromFile(filename);

      expect(rust.map((todo) => todo.toString())).toEqual(
        ts.map((todo) => todo.toString()),
      );
    });
  });

  test("the rust default parses through the package when one is present", async () => {
    await withTempDir(async (dir) => {
      const filename = join(dir, "todo.txt");
      const text = "one @work\nx 2024-03-02 done\n";
      await Runtime.writeTextFile(filename, text);

      const expected = ["one @work", "x 2024-03-02 done"].map(
        (line) => new Todo(line),
      );
      await fakePackage(
        dir,
        `const todos = ${JSON.stringify(
          expected.map((todo, id) => ({
            text: todo.text,
            state: todo.isDone() ? "done" : "todo",
            priority: todo.priority ?? null,
            completionDate:
              todo.completionDate === undefined
                ? null
                : formatDateTag(todo.completionDate),
            creationDate:
              todo.creationDate === undefined
                ? null
                : formatDateTag(todo.creationDate),
            projects: [...todo.projects],
            contexts: [...todo.contexts],
            tags: Object.entries(todo.tags),
            isDone: todo.isDone(),
            isHidden: todo.isHidden(),
            isVisibleInOverview: todo.isVisibleInOverview(),
            isOverdue: todo.isOverdue(),
            toString: todo.toString(),
            hash: todo.getHash(),
            datesInText: todo.datesInText,
            completionDateInText: todo.completionDateInText,
            id,
          })),
        )};
module.exports = {
  coreVersion: () => "0.3.0-test",
  parseFile: () => JSON.stringify({ ok: true, todos }),
  parseFileWithLimits: () => JSON.stringify({ ok: true, todos }),
};
`,
      );
      setEnv("THAR_CORE", undefined);
      resetCoreBridgeForTests();
      const debug = vi.spyOn(console, "debug").mockImplementation(() => {});

      const todos = await readTodosFromFile(filename);

      expect(todos.map((todo) => todo.toString())).toEqual(
        expected.map((todo) => todo.toString()),
      );
      // A real answer, not the fallback: no diagnostic line at all.
      expect(debug).not.toHaveBeenCalled();
    });
  });
});

/**
 * CP3b2a: the gated `buildRows` adapter.
 *
 * The real WASM export lands in CP3b1, so most tests inject a fake through
 * `setRowBuilderForTests`. One test drives a fake CommonJS package through the
 * real loader to prove feature detection as well.
 */
describe("buildRowsWithCore", () => {
  const TODAY = "2026-11-15";

  const contextRow = (contextName: string, todoCount: number) => ({
    type: "context",
    contextName,
    todoCount,
  });
  const todoRow = (index: number, number: number) => ({
    type: "todo",
    index,
    number,
  });
  const rowEnvelope = (rows: unknown): string =>
    JSON.stringify({ ok: true, rows });

  interface Request {
    todos: {
      text: string;
      tags: [string, string | string[]][];
      datesInText?: boolean;
      completionDateInText?: boolean;
    }[];
    searchViews: { text: string; contexts: string[]; projects: string[] }[];
    terms: string[];
    showHidden: boolean;
    today: string;
  }

  /** A fake builder that records the parsed request and returns `respond`. */
  const captureBuilder = (respond: (input: Request) => string) => {
    const inputs: Request[] = [];
    setRowBuilderForTests((raw) => {
      const input = JSON.parse(raw) as Request;
      inputs.push(input);
      return respond(input);
    });
    return inputs;
  };

  const tsIndexes = (todos: Todo[]) =>
    createIndexes(filterBySearch(filterHidden(sortByImportance(todos)), ""));

  test("THAR_CORE=ts never calls the core, the default does", () => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    const todos = [new Todo("one @home"), new Todo("two")];
    const builder = vi.fn(() => rowEnvelope([]));
    setRowBuilderForTests(builder);

    setEnv("THAR_CORE", "ts");
    expect(buildRowsWithCore(todos, "", false, TODAY)).toBeUndefined();
    expect(builder).not.toHaveBeenCalled();

    // Unset, empty and an unknown value all take the rust default.
    for (const value of [undefined, "", "wasm"]) {
      setEnv("THAR_CORE", value);
      // `rows: []` for a non-empty list is gated by the TypeScript pipeline,
      // so the builder is called but its empty answer is not trusted here.
      expect(buildRowsWithCore(todos, "", false, TODAY)).toBeDefined();
    }
    expect(builder).toHaveBeenCalled();
  });

  test("rust mode without the package falls back with one bounded log", async () => {
    await withTempDir(async (dir) => {
      const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
      setEnv("THAR_CORE", "rust");
      setEnv("THAR_CORE_WASM", join(dir, "not-built", "thar_wasm.js"));
      resetCoreBridgeForTests();

      expect(
        buildRowsWithCore([new Todo("one")], "", false, TODAY),
      ).toBeUndefined();
      // A second call does not log again.
      expect(
        buildRowsWithCore([new Todo("one")], "", false, TODAY),
      ).toBeUndefined();

      expect(debug).toHaveBeenCalledTimes(1);
      expect(debug.mock.calls[0]?.[0]).toContain("WASM package not built");
    });
  });

  test("rust mode without the buildRows export falls back with one log", async () => {
    await withTempDir(async (dir) => {
      const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
      await fakePackage(
        dir,
        'module.exports = { coreVersion: () => "0.2.0-test", parseFile: () => "{}", parseFileWithLimits: () => "{}" };\n',
      );
      setEnv("THAR_CORE", "rust");

      const todos = [new Todo("one")];
      expect(buildRowsWithCore(todos, "", false, TODAY)).toBeUndefined();
      expect(buildRowsWithCore(todos, "", false, TODAY)).toBeUndefined();

      expect(debug).toHaveBeenCalledTimes(1);
      expect(debug.mock.calls[0]?.[0]).toContain("buildRows is not exported");
      // The TypeScript fallback is untouched by the adapter.
      expect(tsIndexes(todos).length).toBeGreaterThan(0);
    });
  });

  test("a package that exports buildRows is detected and used", async () => {
    await withTempDir(async (dir) => {
      await fakePackage(
        dir,
        `module.exports = {
  coreVersion: () => "0.3.0-test",
  parseFile: () => '{"ok":true,"todos":[]}',
  parseFileWithLimits: () => '{"ok":true,"todos":[]}',
  buildRows: (input) => {
    const request = JSON.parse(input);
    const rows = [{ type: "context", contextName: "None", todoCount: request.todos.length }];
    request.todos.forEach((_, index) =>
      rows.push({ type: "todo", index, number: index + 1 }),
    );
    return JSON.stringify({ ok: true, rows });
  },
};
`,
      );
      setEnv("THAR_CORE", "rust");

      const todos = [new Todo("one"), new Todo("two")];
      const entries = buildRowsWithCore(todos, "", false, TODAY);

      expect(entries?.map((entry) => entry.type)).toEqual([
        IndexType.context,
        IndexType.todo,
        IndexType.todo,
      ]);
      if (entries?.[0]?.type === IndexType.context) {
        expect(entries[0].contextName).toBe("None");
        expect(entries[0].todoCount).toBe(2);
      }
      if (entries?.[1]?.type === IndexType.todo) {
        expect(entries[1].todo).toBe(todos[0]);
        expect(entries[1].number).toBe(1);
      }
      if (entries?.[2]?.type === IndexType.todo) {
        expect(entries[2].todo).toBe(todos[1]);
        expect(entries[2].number).toBe(2);
      }
    });
  });

  test("a non-en host locale falls back before calling the package", async () => {
    await withTempDir(async (dir) => {
      const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
      await fakePackage(
        dir,
        `module.exports = {
  coreVersion: () => "0.3.0-test",
  parseFile: () => '{"ok":true,"todos":[]}',
  parseFileWithLimits: () => '{"ok":true,"todos":[]}',
  buildRows: () => { throw new Error("must not be called"); },
};
`,
      );
      setEnv("THAR_CORE", "rust");
      // After `fakePackage`, which resets the bridge.
      setCollatorLocaleForTests("da-DK");

      expect(
        buildRowsWithCore([new Todo("one")], "", false, TODAY),
      ).toBeUndefined();
      expect(debug).toHaveBeenCalledTimes(1);
      expect(String(debug.mock.calls[0]?.[0])).toContain(
        "locale da-DK, rust rows need en-US",
      );
    });
  });

  test("the en-US collation guard passes and the package is used", async () => {
    await withTempDir(async (dir) => {
      const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
      await fakePackage(
        dir,
        `module.exports = {
  coreVersion: () => "0.3.0-test",
  parseFile: () => '{"ok":true,"todos":[]}',
  parseFileWithLimits: () => '{"ok":true,"todos":[]}',
  buildRows: (input) => {
    const request = JSON.parse(input);
    const rows = [{ type: "context", contextName: "None", todoCount: request.todos.length }];
    request.todos.forEach((_, index) =>
      rows.push({ type: "todo", index, number: index + 1 }),
    );
    return JSON.stringify({ ok: true, rows });
  },
};
`,
      );
      setEnv("THAR_CORE", "rust");
      setCollatorLocaleForTests("en-US");

      const entries = buildRowsWithCore(
        [new Todo("one"), new Todo("two")],
        "",
        false,
        TODAY,
      );
      expect(entries?.map((entry) => entry.type)).toEqual([
        IndexType.context,
        IndexType.todo,
        IndexType.todo,
      ]);
      expect(debug).not.toHaveBeenCalled();
    });
  });

  test("only English default locales are en-US equivalents", () => {
    for (const locale of ["en-US", "en", "en-GB", "EN_us"]) {
      expect(isEnglishCollator(locale), locale).toBe(true);
    }
    for (const locale of ["da-DK", "de-DE", "sv-SE", "fr", ""]) {
      expect(isEnglishCollator(locale), locale).toBe(false);
    }
  });

  test("maps rows back to the original Todo objects and headers", () => {
    setEnv("THAR_CORE", "rust");
    const todos = [
      new Todo("beta @work"),
      new Todo("alpha @work"),
      new Todo("plain"),
    ];
    captureBuilder(() =>
      rowEnvelope([
        contextRow("work", 2),
        todoRow(1, 1),
        todoRow(0, 2),
        contextRow("None", 1),
        todoRow(2, 3),
      ]),
    );

    const entries = buildRowsWithCore(todos, "", false, TODAY);
    expect(entries).toHaveLength(5);
    expect(entries?.[0]).toEqual({
      type: IndexType.context,
      contextName: "work",
      todoCount: 2,
    });
    // Object identity, not a copy: selection state keys on `Todo.id`.
    expect(entries?.[1]).toEqual({
      type: IndexType.todo,
      todo: todos[1],
      number: 1,
    });
    expect(entries?.[2]).toEqual({
      type: IndexType.todo,
      todo: todos[0],
      number: 2,
    });
    expect(entries?.[4]).toEqual({
      type: IndexType.todo,
      todo: todos[2],
      number: 3,
    });
  });

  test("sends structured records, host-normalized views and terms", () => {
    setEnv("THAR_CORE", "rust");
    // `aΣ.Α` keeps an internal sigma (the dot is Case_Ignorable, so the next
    // cased letter makes it non-final) while `ΜΆΪΟΣ` ends in a final sigma.
    // Both folds are JavaScript's, not Rust's per-character mapping.
    const todo = new Todo("aΣ.Α ΜΆΪΟΣ beta:one beta:two +Thar @Work");
    const inputs = captureBuilder(() =>
      rowEnvelope([contextRow("Work", 1), todoRow(0, 1)]),
    );

    expect(buildRowsWithCore([todo], "MILK @Work", true, TODAY)).toHaveLength(
      2,
    );

    const input = inputs[0];
    expect(input).toBeDefined();
    if (!input) return;
    // Duplicate tag keys stay an array: a `toString()` round-trip would have
    // produced the single value `["beta", "one,two"]` here.
    expect(input.todos[0]?.tags).toContainEqual(["beta", ["one", "two"]]);
    expect(input.todos[0]?.text).toBe("aΣ.Α ΜΆΪΟΣ +Thar @Work");
    expect(input.searchViews[0]?.text).toBe("aσ.α μάϊος +thar @work");
    expect(input.searchViews[0]?.contexts).toEqual(["work"]);
    expect(input.searchViews[0]?.projects).toEqual(["thar"]);
    // The document uses the name the Rust decoder requires, never a `views`
    // alias: a package built from `crates/thar-wasm` rejects the wrong key.
    expect(Object.keys(input)).toContain("searchViews");
    expect(Object.keys(input)).not.toContain("views");
    expect(input.terms).toEqual(["milk", "@work"]);
    expect(input.showHidden).toBe(true);
    expect(input.today).toBe(TODAY);
  });

  test("sends the real round-trip flags for ambiguous and consumed dates", () => {
    setEnv("THAR_CORE", "rust");
    // Both shapes live in one source line each: an invalid trailing date keeps
    // both flags set, a fully valid done line consumes them.
    const ambiguous = new Todo("x 2024-03-02 2024-13-01 body kept literal");
    const consumed = new Todo("x 2024-03-02 2024-03-01 body");
    expect(ambiguous.datesInText).toBe(true);
    expect(ambiguous.completionDateInText).toBe(true);
    expect(consumed.datesInText).toBe(false);
    expect(consumed.completionDateInText).toBe(false);

    const inputs = captureBuilder(() =>
      rowEnvelope([contextRow("None", 2), todoRow(0, 1), todoRow(1, 2)]),
    );

    expect(
      buildRowsWithCore([ambiguous, consumed], "", false, TODAY),
    ).toHaveLength(3);

    const input = inputs[0];
    expect(input).toBeDefined();
    if (!input) return;
    expect(input.todos[0]).toMatchObject({
      datesInText: true,
      completionDateInText: true,
    });
    expect(input.todos[1]).toMatchObject({
      datesInText: false,
      completionDateInText: false,
    });
    // CP4 rebuilds an exact Todo from these records; a lost flag would
    // duplicate a date on the next write.
    expect(ambiguous.toString()).toBe(
      "x 2024-03-02 2024-13-01 body kept literal",
    );
  });

  test("a typed rejection logs its code, not a malformed envelope", () => {
    setEnv("THAR_CORE", "rust");
    const secret = "SECRET-rejection-body";
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    setRowBuilderForTests(() =>
      JSON.stringify({
        ok: false,
        error: {
          name: "TodoBuildRowsError",
          code: "VIEW_COUNT_MISMATCH",
          message: secret,
        },
      }),
    );

    expect(
      buildRowsWithCore([new Todo("one")], "", false, TODAY),
    ).toBeUndefined();

    expect(debug).toHaveBeenCalledTimes(1);
    const logged = debug.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain(
      "buildRows rejected (TodoBuildRowsError/VIEW_COUNT_MISMATCH)",
    );
    expect(logged).not.toContain("malformed");
    expect(logged).not.toContain(secret);
  });

  test("an empty rust result is replaced by the TS rows and logged", () => {
    setEnv("THAR_CORE", "rust");
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const source = [
      new Todo("beta one @work"),
      new Todo("alpha two @work"),
      new Todo("gamma plain"),
    ];
    setRowBuilderForTests(() => rowEnvelope([]));

    const entries = buildRowsWithCore(source, "", false, TODAY);
    const expected = tsIndexes(source);

    // The gate returns the TypeScript result, so the caller does not recompute
    // it and never renders an empty list for a non-empty todo list.
    expect(entries).toEqual(expected);
    expect(entries?.map((entry) => entry.type)).toEqual([
      IndexType.context,
      IndexType.todo,
      IndexType.context,
      IndexType.todo,
      IndexType.todo,
    ]);

    expect(debug).toHaveBeenCalledTimes(1);
    expect(String(debug.mock.calls[0]?.[0])).toContain("rows empty, ts=5");
  });

  test("an empty result with an empty TS pipeline is accepted silently", () => {
    setEnv("THAR_CORE", "rust");
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const inputs = captureBuilder(() => rowEnvelope([]));

    // A query that genuinely matches nothing.
    expect(
      buildRowsWithCore(
        [new Todo("one @work"), new Todo("two")],
        "zzz",
        false,
        TODAY,
      ),
    ).toEqual([]);
    // Everything hidden by the overview rules.
    expect(
      buildRowsWithCore([new Todo("hidden h:1")], "", false, TODAY),
    ).toEqual([]);
    // Both are legitimate, so the builder ran and nothing was logged.
    expect(inputs).toHaveLength(2);
    expect(debug).not.toHaveBeenCalled();
  });

  test("a failing or inconsistent builder falls back and logs once", () => {
    setEnv("THAR_CORE", "rust");
    const secret = "SECRET-TODO-alpha-77";
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const todos = [new Todo(secret)];

    const failures: (() => string)[] = [
      () => {
        throw new Error(`${secret} exploded`);
      },
      () => "not json",
      () => JSON.stringify({ ok: false }),
      () => JSON.stringify({ ok: true }),
      () => rowEnvelope([todoRow(0, 1)]), // todo before any header
      () => rowEnvelope([contextRow("None", 2), todoRow(0, 1)]), // count
      () => rowEnvelope([contextRow("None", 1), todoRow(1, 1)]), // bad index
      () => rowEnvelope([contextRow("None", 2), todoRow(0, 1), todoRow(0, 2)]),
      () => rowEnvelope([contextRow("None", 2), todoRow(0, 2), todoRow(0, 1)]),
      () =>
        rowEnvelope([
          contextRow("None", 1),
          todoRow(0, 1),
          contextRow("None", 1),
        ]),
      () =>
        rowEnvelope([{ type: "context", contextName: "None", todoCount: "1" }]),
      () => rowEnvelope([{ type: "other" }]),
      // A header that does not name the todo's first context.
      () => rowEnvelope([contextRow("wrong", 1), todoRow(0, 1)]),
    ];

    for (const fail of failures) {
      setRowBuilderForTests(fail);
      expect(buildRowsWithCore(todos, "", false, TODAY)).toBeUndefined();
    }

    expect(debug).toHaveBeenCalledTimes(1);
    const logged = debug.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("buildRows");
    expect(logged).not.toContain(secret);
    expect(logged).not.toContain("exploded");
  });

  test("a thrown error does not leak the request body", () => {
    setEnv("THAR_CORE", "rust");
    const secret = "SECRET-TODO-beta-88";
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    setRowBuilderForTests(() => {
      throw new SyntaxError(`JSON.parse failed near ${secret}`);
    });

    expect(
      buildRowsWithCore([new Todo(secret)], "", false, TODAY),
    ).toBeUndefined();

    const logged = debug.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("SyntaxError");
    expect(logged).not.toContain(secret);
  });

  test("the row input is memoized per todo array, per query only terms change", () => {
    setEnv("THAR_CORE", "rust");
    const todos = [new Todo("one")];
    const inputs = captureBuilder(() =>
      rowEnvelope([contextRow("None", 1), todoRow(0, 1)]),
    );

    buildRowsWithCore(todos, "first", false, TODAY);
    buildRowsWithCore(todos, "second word", false, TODAY);

    expect(inputs).toHaveLength(2);
    expect(inputs[0]?.terms).toEqual(["first"]);
    expect(inputs[1]?.terms).toEqual(["second", "word"]);
    // A new array rebuilds the records.
    buildRowsWithCore([...todos], "third", false, TODAY);
    expect(inputs).toHaveLength(3);
    expect(inputs[2]?.terms).toEqual(["third"]);
  });
});

/**
 * CP4: the gated `serializeFile` adapter.
 *
 * As with the row builder, most tests inject a fake through
 * `setSerializerForTests`; two drive a fake CommonJS package through the real
 * loader to prove feature detection.
 */
describe("serializeTodosWithCore", () => {
  const ok = (text: string) => JSON.stringify({ ok: true, text });

  test("THAR_CORE=ts never calls the core, the default does", () => {
    const serializer = vi.fn(() => ok("x\n"));
    setSerializerForTests(serializer);

    setEnv("THAR_CORE", "ts");
    expect(serializeTodosWithCore([new Todo("one")])).toBeUndefined();
    expect(serializer).not.toHaveBeenCalled();

    setEnv("THAR_CORE", undefined);
    expect(serializeTodosWithCore([new Todo("one")])).toEqual({
      ok: true,
      text: "x\n",
    });
    expect(serializer).toHaveBeenCalledTimes(1);
  });

  test("sends the structured records with tags and both round-trip flags", () => {
    setEnv("THAR_CORE", "rust");
    const todo = new Todo(
      "x 2024-03-02 2024-13-01 body kept literal beta:one beta:two @work",
    );
    const inputs: { todos: Record<string, unknown>[] }[] = [];
    setSerializerForTests((raw) => {
      inputs.push(JSON.parse(raw) as { todos: Record<string, unknown>[] });
      return ok("line\n");
    });

    expect(serializeTodosWithCore([todo])).toEqual({
      ok: true,
      text: "line\n",
    });

    const record = inputs[0]?.todos[0];
    expect(record).toBeDefined();
    expect(record).toMatchObject({ state: "done", datesInText: true });
    expect(record?.completionDateInText).toBe(true);
    expect(record?.contexts).toEqual(["work"]);
    // A `toString()` round-trip would collapse this into "one,two".
    expect(record?.tags).toContainEqual(["beta", ["one", "two"]]);
    // The request document uses the key the Rust decoder requires.
    expect(Object.keys(inputs[0] ?? {})).toContain("todos");
  });

  test("a rejection falls back with its code, once per process", () => {
    setEnv("THAR_CORE", "rust");
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const todos = [new Todo("one")];

    // The TypeScript guard already accepted this list. A Rust-only rejection
    // is a divergence, so the adapter falls back instead of throwing.
    setSerializerForTests(() =>
      JSON.stringify({
        ok: false,
        error: {
          name: "TodoControlCharacterError",
          code: "UNSAFE_CONTROL_CHARACTER",
          message: "content-free",
          index: 3,
          codePoint: 0x1b,
        },
      }),
    );
    expect(serializeTodosWithCore(todos)).toBeUndefined();
    expect(serializeTodosWithCore(todos)).toBeUndefined();
    expect(debug).toHaveBeenCalledTimes(1);
    expect(String(debug.mock.calls[0]?.[0])).toContain(
      "serializeFile rejected (UNSAFE_CONTROL_CHARACTER)",
    );
  });

  test("a package without the export falls back with one log", async () => {
    await withTempDir(async (dir) => {
      const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
      await fakePackage(
        dir,
        'module.exports = { coreVersion: () => "0.4.0-test", parseFile: () => "{}", parseFileWithLimits: () => "{}" };\n',
      );
      setEnv("THAR_CORE", "rust");

      expect(serializeTodosWithCore([new Todo("one")])).toBeUndefined();
      expect(serializeTodosWithCore([new Todo("one")])).toBeUndefined();

      expect(debug).toHaveBeenCalledTimes(1);
      expect(String(debug.mock.calls[0]?.[0])).toContain(
        "serializeFile is missing or not a function",
      );
    });
  });

  test("a package that exports serializeFile is detected and used", async () => {
    await withTempDir(async (dir) => {
      const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
      await fakePackage(
        dir,
        `module.exports = {
  coreVersion: () => "0.4.0-test",
  parseFile: () => '{"ok":true,"todos":[]}',
  parseFileWithLimits: () => '{"ok":true,"todos":[]}',
  serializeFile: (input) => {
    const request = JSON.parse(input);
    return JSON.stringify({
      ok: true,
      text: request.todos.map((todo) => todo.text).join("\\n") + "\\n",
    });
  },
};
`,
      );
      setEnv("THAR_CORE", "rust");

      expect(
        serializeTodosWithCore([new Todo("one"), new Todo("two")]),
      ).toEqual({ ok: true, text: "one\ntwo\n" });
      expect(debug).not.toHaveBeenCalled();
    });
  });
});

/**
 * CP3b2c: the wired `THAR_CORE=rust` read path.
 *
 * The fake package returns the records a real `parseFile` would return for the
 * same file (built here from the TypeScript `Todo` objects, independently of
 * `coreTodoRecord`), so these tests prove the reconstruction, the error
 * mapping and every fallback without a `pkg/` build. The real package is
 * exercised by the tests after `REAL_PACKAGE` below.
 */
describe("THAR_CORE=rust read path", () => {
  const TS_LINES = [
    "x (A) 2024-03-02 2024-03-01 done beta:one beta:two @work +thar",
    "plain task",
    "2023-04-31 april has thirty days",
    "x 2023-02-29 impossible completion date stays literal",
    "(B) priority café 🚀",
    "due:2026-11-14 open",
  ];

  /** The record `thar-wasm` emits for one already-parsed todo. */
  const rustRecord = (todo: Todo, id: number) => ({
    text: todo.text,
    state: todo.isDone() ? "done" : "todo",
    priority: todo.priority ?? null,
    completionDate:
      todo.completionDate === undefined
        ? null
        : formatDateTag(todo.completionDate),
    creationDate:
      todo.creationDate === undefined ? null : formatDateTag(todo.creationDate),
    projects: [...todo.projects],
    contexts: [...todo.contexts],
    tags: Object.entries(todo.tags).map(([key, value]) => [key, value]),
    isDone: todo.isDone(),
    isHidden: todo.isHidden(),
    isVisibleInOverview: todo.isVisibleInOverview(),
    isOverdue: todo.isOverdue(),
    toString: todo.toString(),
    hash: todo.getHash(),
    datesInText: todo.datesInText,
    completionDateInText: todo.completionDateInText,
    id,
  });

  const rustEnvelope = (todos: readonly Todo[]) =>
    JSON.stringify({
      ok: true,
      todos: todos.map((todo, id) => rustRecord(todo, id)),
    });

  // `require` caches by path, so each fixed envelope gets its own file name.
  let packageCount = 0;

  /** A package that answers every parse with one fixed JSON envelope. */
  const recordingPackage = async (dir: string, response: string) => {
    packageCount++;
    return fakePackage(
      dir,
      `const response = ${JSON.stringify(response)};
module.exports = {
  coreVersion: () => "0.3.0-test",
  parseFile: () => response,
  parseFileWithLimits: () => response,
};
`,
      `thar_wasm_${packageCount}.cjs`,
    );
  };

  /** Write `text`, then read it through the TS reader as the oracle. */
  const writeAndReadTs = async (dir: string, name: string, text: string) => {
    const filename = join(dir, name);
    await Runtime.writeTextFile(filename, text);
    setEnv("THAR_CORE", "ts");
    const todos = await readTodosFromFile(filename);
    return { filename, todos };
  };

  const view = (todos: readonly Todo[]) =>
    todos.map((todo) => ({
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
    }));

  test("rebuilds the same todos, fields and order as the TypeScript reader", async () => {
    await withTempDir(async (dir) => {
      const debug = vi.spyOn(console, "debug").mockImplementation(() => {});

      const cases: { name: string; text: string }[] = [
        { name: "crlf.txt", text: `${TS_LINES.join("\r\n")}\r\n` },
        { name: "no-newline.txt", text: TS_LINES.join("\n") },
        {
          name: "blank-lines.txt",
          text: `\n${TS_LINES[0]}\n  \n\t${TS_LINES[1]}\n`,
        },
        { name: "empty.txt", text: "" },
      ];

      for (const item of cases) {
        const { filename, todos: expected } = await writeAndReadTs(
          dir,
          item.name,
          item.text,
        );
        await recordingPackage(dir, rustEnvelope(expected));

        setEnv("THAR_CORE", "rust");
        const actual = await readTodosFromFile(filename);

        expect(actual.map((todo) => todo.toString())).toEqual(
          expected.map((todo) => todo.toString()),
        );
        expect(view(actual)).toEqual(view(expected));
        expect(actual.every((todo) => todo instanceof Todo)).toBe(true);
        expect(new Set(actual.map((todo) => todo.id)).size).toBe(actual.length);
      }
      expect(debug).not.toHaveBeenCalled();
    });
  });

  test("keeps the real Todo instances mutable and immutable by contract", async () => {
    await withTempDir(async (dir) => {
      vi.spyOn(console, "debug").mockImplementation(() => {});
      const { filename, todos } = await writeAndReadTs(
        dir,
        "todo.txt",
        `${TS_LINES.join("\n")}\n`,
      );
      await recordingPackage(dir, rustEnvelope(todos));

      setEnv("THAR_CORE", "rust");
      const actual = await readTodosFromFile(filename);
      const first = actual[0];
      const second = actual[1];

      const reprioritised = first.setPriority("C");
      expect(reprioritised).not.toBe(first);
      expect(reprioritised.id).toBe(first.id);
      expect(first.priority).toBe("A");
      expect(reprioritised.priority).toBe("C");

      const toggled = second.toggleState();
      expect(toggled.updated).not.toBe(second);
      expect(second.isDone()).toBe(false);
      expect(toggled.updated.isDone()).toBe(true);

      const due = second.setDue(new Date(2026, 10, 20));
      expect(second.tags.due).toBeUndefined();
      expect(due.tags.due).toBe("2026-11-20");
    });
  });

  test("maps each Rust rejection to the same TypeScript error", async () => {
    await withTempDir(async (dir) => {
      vi.spyOn(console, "debug").mockImplementation(() => {});
      const { filename } = await writeAndReadTs(dir, "todo.txt", "one\n");

      const cases: TodoFileValidationError[] = [
        new TodoFileTooLargeError(2_000, 1_024),
        new TodoLineCountLimitError(3, 2),
        new TodoLineLengthLimitError(2, 5, 4),
        new TodoControlCharacterError(2, 0),
      ];

      for (const expected of cases) {
        // `Error#message` is non-enumerable, so the wire error copies the
        // enumerable own fields (name, code, line/length/…) and adds it.
        const fields: Record<string, unknown> = Object.fromEntries(
          Object.entries(expected),
        );
        const error = { ...fields, message: expected.message };
        await recordingPackage(dir, JSON.stringify({ ok: false, error }));

        setEnv("THAR_CORE", "rust");
        let thrown: unknown;
        try {
          await readTodosFromFile(filename);
        } catch (error) {
          thrown = error;
        }

        expect(thrown, expected.code).toBeInstanceOf(expected.constructor);
        expect(thrown).toMatchObject({
          name: expected.name,
          code: expected.code,
          message: expected.message,
        });
        for (const [key, value] of Object.entries(fields)) {
          if (key === "name" || key === "code") continue;
          expect((thrown as Record<string, unknown>)[key]).toBe(value);
        }
      }
    });
  });

  test("falls back once, content-free, on every unexpected record", async () => {
    await withTempDir(async (dir) => {
      const secret = "SECRET-TOKEN-never-log-me";
      const { filename, todos } = await writeAndReadTs(
        dir,
        "todo.txt",
        `${secret}\nsecond\n`,
      );
      const baseRecords = todos.map((todo, id) => rustRecord(todo, id));

      const variants: { name: string; response: unknown; reason: string }[] = [
        {
          name: "wrong-count",
          response: { ok: true, todos: baseRecords.slice(0, 1) },
          reason: "1 record(s) for 2 line(s)",
        },
        {
          name: "wrong-order",
          response: {
            ok: true,
            todos: [baseRecords[1], baseRecords[0]],
          },
          reason: "load id",
        },
        {
          name: "bad-date",
          response: {
            ok: true,
            todos: [
              { ...baseRecords[0], creationDate: "2024-13-01" },
              baseRecords[1],
            ],
          },
          reason: "malformed",
        },
        {
          name: "wrong-projects",
          response: {
            ok: true,
            todos: [
              { ...baseRecords[0], projects: ["different"] },
              baseRecords[1],
            ],
          },
          reason: "inconsistent projects/contexts",
        },
        {
          name: "missing-flags",
          response: {
            ok: true,
            todos: [
              (({ datesInText: _dropped, ...rest }) => rest)(baseRecords[0]),
              baseRecords[1],
            ],
          },
          reason: "malformed",
        },
        {
          name: "wrong-text",
          response: {
            ok: true,
            todos: [{ ...baseRecords[0], text: "different" }, baseRecords[1]],
          },
          reason: "does not round-trip",
        },
        {
          name: "unmappable-rejection",
          response: {
            ok: false,
            error: {
              name: "TodoControlCharacterError",
              code: "CONTROL_CHARACTER",
              lineNumber: 1,
              codePoint: 0,
              // A bounded message the TypeScript class would never produce.
              message: "bounded",
            },
          },
          reason: "",
        },
        {
          name: "malformed-envelope",
          response: {},
          reason: "malformed parseFile",
        },
      ];

      for (const variant of variants) {
        const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
        await recordingPackage(dir, JSON.stringify(variant.response));
        setEnv("THAR_CORE", "rust");
        resetCoreBridgeForTests();

        const actual = await readTodosFromFile(filename);

        // Every fallback keeps the TypeScript result.
        expect(
          actual.map((todo) => todo.toString()),
          variant.name,
        ).toEqual(todos.map((todo) => todo.toString()));
        expect(debug, variant.name).toHaveBeenCalledTimes(1);
        const logged = String(debug.mock.calls[0]?.[0]);
        expect(logged, variant.name).toContain("thar core:");
        if (variant.reason.length > 0) {
          expect(logged, variant.name).toContain(variant.reason);
        }
        expect(logged, variant.name).not.toContain(secret);
        debug.mockRestore();
      }
    });
  });

  test("a wrong rejection message falls back and still throws the real error", async () => {
    await withTempDir(async (dir) => {
      const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
      const filename = join(dir, "nul.txt");
      await Runtime.writeTextFile(filename, "one\n\u0000two\n");
      await recordingPackage(
        dir,
        JSON.stringify({
          ok: false,
          error: {
            name: "TodoControlCharacterError",
            code: "CONTROL_CHARACTER",
            lineNumber: 2,
            codePoint: 0,
            message: "a package with a stale message",
          },
        }),
      );

      setEnv("THAR_CORE", "rust");
      let thrown: unknown;
      try {
        await readTodosFromFile(filename);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(TodoControlCharacterError);
      expect(thrown).toMatchObject({
        code: "CONTROL_CHARACTER",
        lineNumber: 2,
        codePoint: 0,
        message:
          "Todo file line 2 contains the control character U+0000. " +
          "Remove control characters from the file. Nothing was changed.",
      });
      expect(debug).toHaveBeenCalledTimes(1);
      expect(String(debug.mock.calls[0]?.[0])).not.toContain("one");
    });
  });

  test("a missing package falls back to TypeScript with one log", async () => {
    await withTempDir(async (dir) => {
      const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
      const { filename, todos } = await writeAndReadTs(
        dir,
        "todo.txt",
        "one\ntwo\n",
      );

      setEnv("THAR_CORE", "rust");
      setEnv("THAR_CORE_WASM", join(dir, "not-built", "thar_wasm.js"));
      resetCoreBridgeForTests();
      const actual = await readTodosFromFile(filename);

      expect(actual.map((todo) => todo.toString())).toEqual(
        todos.map((todo) => todo.toString()),
      );
      expect(debug).toHaveBeenCalledTimes(1);
      expect(String(debug.mock.calls[0]?.[0])).toContain(
        "WASM package not built",
      );
    });
  });

  test("THAR_CORE=ts never loads the package", async () => {
    await withTempDir(async (dir) => {
      const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
      const { filename, todos } = await writeAndReadTs(
        dir,
        "todo.txt",
        "one\ntwo\n",
      );
      // A path that does not exist: loading it in ts mode would log.
      setEnv("THAR_CORE_WASM", join(dir, "never", "thar_wasm.js"));

      setEnv("THAR_CORE", "ts");
      resetCoreBridgeForTests();
      const actual = await readTodosFromFile(filename);
      expect(actual.map((todo) => todo.toString())).toEqual(
        todos.map((todo) => todo.toString()),
      );
      expect(debug).not.toHaveBeenCalled();
    });
  });

  test("parses the file exactly once", async () => {
    await withTempDir(async (dir) => {
      const counter = join(dir, "calls.txt");
      const filename = join(dir, "todo.txt");
      await Runtime.writeTextFile(filename, "one\ntwo\n");
      const todos = ["one", "two"].map((line) => new Todo(line));

      const response = rustEnvelope(todos);
      await fakePackage(
        dir,
        `const fs = require("node:fs");
const response = ${JSON.stringify(response)};
module.exports = {
  coreVersion: () => "0.3.0-test",
  parseFile: () => response,
  parseFileWithLimits: () => {
    fs.appendFileSync(${JSON.stringify(counter)}, "x");
    return response;
  },
};
`,
      );
      vi.spyOn(console, "debug").mockImplementation(() => {});

      setEnv("THAR_CORE", "rust");
      const actual = await readTodosFromFile(filename);

      expect(actual.map((todo) => todo.toString())).toEqual(
        todos.map((todo) => todo.toString()),
      );
      // Exactly one parse: the wired read path, no second Rust parse.
      expect(readFileSync(counter, "utf8")).toBe("x");
    });
  });

  test("invalid UTF-8 decodes lossily on both sides", async () => {
    await withTempDir(async (dir) => {
      vi.spyOn(console, "debug").mockImplementation(() => {});
      const filename = join(dir, "invalid-utf8.txt");
      writeFileSync(filename, Buffer.from([0x66, 0xff, 0x6f, 0x0a, 0x62]));

      setEnv("THAR_CORE", "ts");
      const expected = await readTodosFromFile(filename);
      await recordingPackage(dir, rustEnvelope(expected));

      setEnv("THAR_CORE", "rust");
      const actual = await readTodosFromFile(filename);

      expect(actual.map((todo) => todo.toString())).toEqual(
        expected.map((todo) => todo.toString()),
      );
      expect(actual.map((todo) => todo.text)).toEqual(
        expected.map((todo) => todo.text),
      );
    });
  });

  test("over-limit files report the same error in both modes", async () => {
    await withTempDir(async (dir) => {
      const limits = {
        maxFileBytes: 1_024,
        maxReadTodos: 2,
        maxLineChars: 4,
      };
      const filename = join(dir, "todo.txt");
      await Runtime.writeTextFile(filename, "too long\none\n");

      setEnv("THAR_CORE", "ts");
      const tsError = await readTodosFromFile(filename, limits).catch(
        (error: unknown) => error,
      );

      // The fake package enforces the same limits and returns the real
      // `thar-wasm` error envelope, including the message.
      await fakePackage(
        dir,
        `const fail = (name, code, fields, message) => JSON.stringify({
  ok: false,
  error: { name, code, ...fields, message },
});
module.exports = {
  coreVersion: () => "0.3.0-test",
  parseFile: () => fail("TodoLineLengthLimitError", "LINE_TOO_LONG", {
    lineNumber: 1,
    length: 8,
    maxLineChars: 4,
  }, "Todo file line 1 is 8 characters; the limit is 4. Shorten the line or raise THAR_MAX_LINE_CHARS. Nothing was changed."),
  parseFileWithLimits: () => fail("TodoLineLengthLimitError", "LINE_TOO_LONG", {
    lineNumber: 1,
    length: 8,
    maxLineChars: 4,
  }, "Todo file line 1 is 8 characters; the limit is 4. Shorten the line or raise THAR_MAX_LINE_CHARS. Nothing was changed."),
};
`,
      );
      setEnv("THAR_CORE", "rust");
      vi.spyOn(console, "debug").mockImplementation(() => {});
      const rustError = await readTodosFromFile(filename, limits).catch(
        (error: unknown) => error,
      );

      expect(rustError).toBeInstanceOf(TodoLineLengthLimitError);
      expect(rustError).toMatchObject({
        name: (tsError as TodoFileValidationError).name,
        code: (tsError as TodoFileValidationError).code,
        message: (tsError as TodoFileValidationError).message,
        lineNumber: 1,
        length: 8,
        maxLineChars: 4,
      });
    });
  });

  test("the TypeScript validator is still the judge for a rejected file", async () => {
    await withTempDir(async (dir) => {
      const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
      const filename = join(dir, "nul.txt");
      await Runtime.writeTextFile(filename, "one\n\u0000two\n");
      await recordingPackage(dir, JSON.stringify({ ok: true, todos: [] }));
      setEnv("THAR_CORE", "rust");

      let thrown: unknown;
      try {
        await readTodosFromFile(filename);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(TodoControlCharacterError);
      expect(thrown).toMatchObject({ lineNumber: 2, codePoint: 0 });
      expect(debug).toHaveBeenCalledTimes(1);
    });
  });
});

const REAL_PACKAGE = join(
  process.cwd(),
  "crates",
  "thar-wasm",
  "pkg",
  "thar_wasm.js",
);

test.skipIf(!existsSync(REAL_PACKAGE))(
  "the built package parses the corpus through the adapter",
  () => {
    setEnv("THAR_CORE_WASM", undefined);
    resetCoreBridgeForTests();

    const parsed = parseFileWithCore(
      "x (A) 2024-03-02 2024-03-01 done alpha:one beta:one beta:two\n",
      "2026-11-15",
    );

    expect(parsed?.ok).toBe(true);
    if (parsed?.ok !== true) return;
    expect(parsed.todos).toHaveLength(1);
    expect(parsed.todos[0]?.state).toBe("done");
    expect(parsed.todos[0]?.priority).toBe("A");
    expect(parsed.todos[0]?.tags).toEqual([
      ["alpha", "one"],
      ["beta", ["one", "two"]],
    ]);
  },
);

/**
 * CP3b2c: the wired read path against the **real** package the wasm CI job
 * just built.
 *
 * The fake-package tests above prove the reconstruction and the mapping; this
 * proves the record field names and the flag/id additions match
 * `crates/thar-wasm`. Skipped in the Node matrix, where `pkg/` does not exist.
 */
test.skipIf(!existsSync(REAL_PACKAGE))(
  "the built package parses through the wired rust read path",
  async () => {
    setEnv("THAR_CORE", "rust");
    setEnv("THAR_CORE_WASM", undefined);
    resetCoreBridgeForTests();
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});

    const text =
      "x (A) 2024-03-02 2024-03-01 done beta:one beta:two @work +thar\r\n" +
      "plain task\r\n" +
      "\r\n" +
      "2023-04-31 april has thirty days\r\n" +
      "x 2023-02-29 impossible completion date stays literal\r\n" +
      "x 2023-05-04 2023-02-29 second date is invalid\r\n" +
      "2024-01-01";

    const dir = await Runtime.makeTempDir();
    try {
      const rustFile = join(dir, "rust.txt");
      const tsFile = join(dir, "ts.txt");
      await Runtime.writeTextFile(rustFile, text);
      await Runtime.writeTextFile(tsFile, text);

      const rust = await readTodosFromFile(rustFile);
      setEnv("THAR_CORE", "ts");
      resetCoreBridgeForTests();
      const ts = await readTodosFromFile(tsFile);

      expect(rust.map((todo) => todo.toString())).toEqual(
        ts.map((todo) => todo.toString()),
      );
      expect(rust.map((todo) => todo.text)).toEqual(
        ts.map((todo) => todo.text),
      );
      expect(rust.map((todo) => todo.datesInText)).toEqual(
        ts.map((todo) => todo.datesInText),
      );
      expect(rust.map((todo) => todo.completionDateInText)).toEqual(
        ts.map((todo) => todo.completionDateInText),
      );
      expect(rust.map((todo) => todo.tags)).toEqual(
        ts.map((todo) => todo.tags),
      );
      expect(debug).not.toHaveBeenCalled();
    } finally {
      await Runtime.remove(dir, { recursive: true });
    }
  },
);

test.skipIf(!existsSync(REAL_PACKAGE))(
  "the built package maps read errors to the TypeScript error",
  async () => {
    setEnv("THAR_CORE_WASM", undefined);
    resetCoreBridgeForTests();
    const dir = await Runtime.makeTempDir();
    try {
      const nulFile = join(dir, "nul.txt");
      await Runtime.writeTextFile(nulFile, "one\n\u0000two\n");

      setEnv("THAR_CORE", "ts");
      resetCoreBridgeForTests();
      const tsError = await readTodosFromFile(nulFile).catch(
        (error: unknown) => error,
      );

      setEnv("THAR_CORE", "rust");
      resetCoreBridgeForTests();
      vi.spyOn(console, "debug").mockImplementation(() => {});
      const rustError = await readTodosFromFile(nulFile).catch(
        (error: unknown) => error,
      );

      expect(rustError).toBeInstanceOf(TodoControlCharacterError);
      expect(rustError).toMatchObject({
        name: (tsError as TodoControlCharacterError).name,
        code: (tsError as TodoControlCharacterError).code,
        message: (tsError as TodoControlCharacterError).message,
        lineNumber: 2,
        codePoint: 0,
      });

      // An over-long line maps the same way, with the effective limits.
      const longFile = join(dir, "long.txt");
      await Runtime.writeTextFile(longFile, "too long\n");
      const limits = {
        maxFileBytes: 1_024,
        maxReadTodos: 10,
        maxLineChars: 4,
      };
      setEnv("THAR_CORE", "ts");
      resetCoreBridgeForTests();
      const tsLong = await readTodosFromFile(longFile, limits).catch(
        (error: unknown) => error,
      );
      setEnv("THAR_CORE", "rust");
      resetCoreBridgeForTests();
      const rustLong = await readTodosFromFile(longFile, limits).catch(
        (error: unknown) => error,
      );

      expect(rustLong).toBeInstanceOf(TodoLineLengthLimitError);
      expect(rustLong).toMatchObject({
        name: (tsLong as TodoLineLengthLimitError).name,
        code: (tsLong as TodoLineLengthLimitError).code,
        message: (tsLong as TodoLineLengthLimitError).message,
        lineNumber: 1,
        length: 8,
        maxLineChars: 4,
      });
    } finally {
      await Runtime.remove(dir, { recursive: true });
    }
  },
);

/**
 * CP4: the serializer against the **real** package the wasm CI job just built.
 *
 * The rest of this file drives a fake through the loader or a seam; this proves
 * the request field names, the flags and the guard envelope match
 * `crates/thar-wasm`. Skipped in the Node matrix, where `pkg/` does not exist.
 */
test.skipIf(!existsSync(REAL_PACKAGE))(
  "the built package serializes through the real loader",
  () => {
    setEnv("THAR_CORE", "rust");
    setEnv("THAR_CORE_WASM", undefined);
    resetCoreBridgeForTests();
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});

    const todos = [
      new Todo("(A) one @work due:2026-01-01 beta:one beta:two"),
      new Todo("x 2024-03-02 2024-03-01 done"),
      // The dates stayed literal, so serialization must not prepend them.
      new Todo("x 2024-03-02 2024-13-01 kept literal"),
      new Todo("tab\there"),
    ];

    expect(serializeTodosWithCore(todos)).toEqual({
      ok: true,
      text: serializeTodosForWrite(todos),
    });
    expect(debug).not.toHaveBeenCalled();

    // The write-time guard is the Rust envelope. The adapter reports its code
    // once and falls back; the TypeScript guard is what names line and code
    // point for the user, so a Rust-only rejection never blocks a save.
    expect(
      serializeTodosWithCore([new Todo("safe"), new Todo("nul\u0000")]),
    ).toBeUndefined();
    expect(debug).toHaveBeenCalledTimes(1);
    expect(String(debug.mock.calls[0]?.[0])).toContain(
      "serializeFile rejected (UNSAFE_CONTROL_CHARACTER)",
    );
  },
);

/**
 * CP3b2b: the rows path against the **real** package the wasm CI job just
 * built. The rest of this file drives a fake through the loader or a seam; this
 * is the only test that proves the request field names and the response shape
 * match `crates/thar-wasm` (a `views`-only regression is rejected with
 * `INVALID_INPUT` and falls back, so `entries` would be `undefined` here).
 *
 * Skipped in the Node matrix, where `pkg/` does not exist, and on a host whose
 * default collator is not English, because the TypeScript oracle used below
 * sorts with the host locale while the Rust core pins en-US.
 */
test.skipIf(
  !existsSync(REAL_PACKAGE) || !isEnglishCollator(defaultCollatorLocale()),
)("the built package builds rows through the real loader", () => {
  setEnv("THAR_CORE", "rust");
  setEnv("THAR_CORE_WASM", undefined);
  resetCoreBridgeForTests();
  const debug = vi.spyOn(console, "debug").mockImplementation(() => {});

  const todos = [
    new Todo("beta one @work"),
    new Todo("alpha two @work"),
    new Todo("gamma plain h:1"),
    new Todo("delta plain"),
  ];

  // Empty query: hidden todos are filtered, contexts are grouped and the
  // uncategorised `None` header is present.
  const entries = buildRowsWithCore(todos, "", false, "2026-11-15");
  const expected = createIndexes(
    filterBySearch(filterHidden(sortByImportance(todos)), ""),
  );

  // Not the fallback: the adapter returned rows instead of `undefined`.
  expect(entries).toBeDefined();
  expect(debug).not.toHaveBeenCalled();
  expect(entries?.map((entry) => entry.type)).toEqual(
    expected.map((entry) => entry.type),
  );
  const todoTexts = (list: typeof expected) =>
    list
      .filter((entry) => entry.type === IndexType.todo)
      .map((entry) => entry.todo.text);
  expect(todoTexts(entries ?? [])).toEqual(todoTexts(expected));
  expect(entries?.[0]).toEqual({
    type: IndexType.context,
    contextName: "None",
    todoCount: 1,
  });

  // Host-normalized terms and views are used: only `alpha two` matches.
  const searched = buildRowsWithCore(todos, "ALPHA", false, "2026-11-15");
  expect(todoTexts(searched ?? [])).toEqual(["alpha two @work"]);
  // `showHidden` reaches the core.
  const shown = buildRowsWithCore(todos, "", true, "2026-11-15");
  expect(todoTexts(shown ?? [])).toContain("gamma plain");
});
