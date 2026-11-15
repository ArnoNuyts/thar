import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  MAX_SHADOW_LOG_BYTES,
  buildRowsWithCore,
  getCoreMode,
  isShadowEnabled,
  parseFileWithCore,
  resetCoreBridgeForTests,
  resolveShadowLogPath,
  serializeTodosWithCore,
  setCollatorLocaleForTests,
  setRowBuilderForTests,
  setSerializerForTests,
  shadowCheckTodoFile,
  shadowLogPath,
} from "../logic/core-wasm.ts";
import { createIndexes } from "../logic/indexes.ts";
import {
  filterBySearch,
  filterHidden,
  sortByImportance,
} from "../logic/Todos.ts";
import { Todo } from "../logic/todo.ts";
import { IndexType } from "../types/enums.ts";
import {
  readTodosFromFile,
  serializeTodosForWrite,
} from "../logic/todo-file-helpers.ts";
import { isEnglishCollator } from "../utils/collation-locale.ts";
import { Runtime } from "../utils/runtime.ts";
import { restoreRuntimeMocks } from "./test-utils.ts";

/**
 * CP2b: the opt-in Rust bridge and the `THAR_SHADOW=1` differential check.
 *
 * The main Node test matrix must not require Rust or a built
 * `crates/thar-wasm/pkg/`, so these tests drive the real loader with a tiny
 * CommonJS test double written into a temp directory and named by
 * `THAR_CORE_WASM`. When the real package happens to exist (the Rust WASM CI
 * job and a developer checkout) one extra test runs against it.
 */

const ENV_KEYS = [
  "THAR_SHADOW",
  "THAR_SHADOW_LOG",
  "THAR_CORE",
  "THAR_CORE_WASM",
  "THAR_MAX_FILE_BYTES",
  "THAR_MAX_READ_TODOS",
  "THAR_MAX_LINE_CHARS",
  "XDG_CACHE_HOME",
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

/**
 * A package that enforces the three read limits the way `thar-wasm` does, and
 * echoes each line as its `toString`/`hash` (`lineSuffix` adds a difference).
 *
 * `parseFile` implements the compile-time defaults (1 MiB / 10 000 / 8 192) and
 * rejects a longer line, so a test that overrides `THAR_MAX_LINE_CHARS` fails
 * with a spurious `rejected` record if the adapter forgets to pass the
 * effective limits to `parseFileWithLimits`.
 */
const limitAwarePackage = (lineSuffix = "") => `
const fail = (name, code, fields) => ({
  ok: false,
  error: { name, code, ...fields, message: "bounded" },
});
const todo = (line, rustLine) => ({
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
  toString: rustLine,
  hash: rustLine,
});
const check = (text, maxFileBytes, maxReadTodos, maxLineChars) => {
  const actualBytes = Buffer.byteLength(text, "utf8");
  if (actualBytes > maxFileBytes) {
    return fail("TodoFileTooLargeError", "FILE_TOO_LARGE", {
      actualBytes,
      maxBytes: maxFileBytes,
    });
  }
  const lines = text.split("\\n").filter((line) => line.trim());
  if (lines.length > maxReadTodos) {
    return fail("TodoLineCountLimitError", "TOO_MANY_LINES", {
      lineCount: lines.length,
      maxReadTodos,
    });
  }
  const index = lines.findIndex((line) => line.length > maxLineChars);
  if (index >= 0) {
    return fail("TodoLineLengthLimitError", "LINE_TOO_LONG", {
      lineNumber: index + 1,
      length: lines[index].length,
      maxLineChars,
    });
  }
  return {
    ok: true,
    todos: lines.map((line) => todo(line, line + ${JSON.stringify(lineSuffix)})),
  };
};
module.exports = {
  coreVersion: () => "0.2.0-test",
  parseFile: (text) => JSON.stringify(check(text, 1024 * 1024, 10000, 8192)),
  parseFileWithLimits: (text, _today, maxFileBytes, maxReadTodos, maxLineChars) =>
    JSON.stringify(check(text, maxFileBytes, maxReadTodos, maxLineChars)),
};
`;

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

describe("THAR_CORE at CP2", () => {
  test("both values keep the TypeScript implementation", async () => {
    await withTempDir(async (dir) => {
      const filename = join(dir, "todo.txt");
      await Runtime.writeTextFile(
        filename,
        "x 2024-03-02 alpha:one done +p @c\nopen due:2026-11-14\n",
      );

      setEnv("THAR_CORE", "ts");
      expect(getCoreMode()).toBe("ts");
      const ts = await readTodosFromFile(filename);

      setEnv("THAR_CORE", "rust");
      expect(getCoreMode()).toBe("rust");
      // No package built in this process: the TS path must still work.
      setEnv("THAR_CORE_WASM", join(dir, "missing", "thar_wasm.js"));
      resetCoreBridgeForTests();
      const rust = await readTodosFromFile(filename);

      expect(rust.map((todo) => todo.toString())).toEqual(
        ts.map((todo) => todo.toString()),
      );
    });
  });

  test("unknown values fall back to ts", () => {
    setEnv("THAR_CORE", "wasm");
    expect(getCoreMode()).toBe("ts");
    setEnv("THAR_CORE", "");
    expect(getCoreMode()).toBe("ts");
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

  test("ts mode and an unset variable never call the core", () => {
    const todos = [new Todo("one @home"), new Todo("two")];
    const builder = vi.fn(() => rowEnvelope([]));
    setRowBuilderForTests(builder);

    for (const value of [undefined, "ts", "", "wasm"]) {
      setEnv("THAR_CORE", value);
      expect(buildRowsWithCore(todos, "", false, TODAY)).toBeUndefined();
    }
    expect(builder).not.toHaveBeenCalled();
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

  test("a failing or inconsistent builder falls back and logs once", async () => {
    await withTempDir(async (dir) => {
      const log = join(dir, "shadow.log");
      setEnv("THAR_SHADOW_LOG", log);
      setEnv("THAR_CORE", "rust");
      const secret = "SECRET-TODO-alpha-77";
      const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
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
        () =>
          rowEnvelope([contextRow("None", 2), todoRow(0, 1), todoRow(0, 2)]),
        () =>
          rowEnvelope([contextRow("None", 2), todoRow(0, 2), todoRow(0, 1)]),
        () =>
          rowEnvelope([
            contextRow("None", 1),
            todoRow(0, 1),
            contextRow("None", 1),
          ]),
        () =>
          rowEnvelope([
            { type: "context", contextName: "None", todoCount: "1" },
          ]),
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
      expect(warn).not.toHaveBeenCalled();
      // Nothing is written anywhere: the shadow log stays absent.
      expect(existsSync(log)).toBe(false);
    });
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

  test("ts mode and an unset variable never call the core", () => {
    const serializer = vi.fn(() => ok("x\n"));
    setSerializerForTests(serializer);

    for (const value of [undefined, "ts", "", "wasm"]) {
      setEnv("THAR_CORE", value);
      expect(serializeTodosWithCore([new Todo("one")])).toBeUndefined();
    }
    expect(serializer).not.toHaveBeenCalled();
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

  test("a guard rejection is returned; a malformed one falls back", () => {
    setEnv("THAR_CORE", "rust");
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const todos = [new Todo("one")];

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
    expect(serializeTodosWithCore(todos)).toEqual({
      ok: false,
      error: { code: "UNSAFE_CONTROL_CHARACTER", index: 3, codePoint: 0x1b },
    });
    // A legitimate rejection is not a fallback: it is not logged either.
    expect(debug).not.toHaveBeenCalled();

    // The same code without numeric fields cannot be mapped to the TS error.
    setSerializerForTests(() =>
      JSON.stringify({
        ok: false,
        error: { code: "UNSAFE_CONTROL_CHARACTER" },
      }),
    );
    expect(serializeTodosWithCore(todos)).toBeUndefined();
    expect(debug).toHaveBeenCalledTimes(1);
    expect(String(debug.mock.calls[0]?.[0])).toContain(
      "malformed serializeFile envelope",
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
        "serializeFile is not exported",
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

describe("THAR_SHADOW=1", () => {
  test("is off by default and writes nothing", async () => {
    await withTempDir(async (dir) => {
      const log = join(dir, "shadow.log");
      setEnv("THAR_SHADOW_LOG", log);
      setEnv("THAR_SHADOW", undefined);

      expect(isShadowEnabled()).toBe(false);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      shadowCheckTodoFile("alpha:one\n", [new Todo("something else")]);

      expect(existsSync(log)).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  test("a matching parse records nothing", async () => {
    await withTempDir(async (dir) => {
      const log = join(dir, "shadow.log");
      setEnv("THAR_SHADOW_LOG", log);
      setEnv("THAR_SHADOW", "1");
      const text = "alpha:one\nbeta:two\n";
      await envelopePackage({
        ok: true,
        todos: [
          record("", {
            tags: [["alpha", "one"]],
            toString: " alpha:one",
            hash: " alpha:one",
          }),
          record("", {
            tags: [["beta", "two"]],
            toString: " beta:two",
            hash: " beta:two",
          }),
        ],
      })(dir);

      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      shadowCheckTodoFile(text, [new Todo("alpha:one"), new Todo("beta:two")]);

      expect(existsSync(log)).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  test("the read seam records a bounded, content-free mismatch", async () => {
    await withTempDir(async (dir) => {
      const log = join(dir, "shadow.log");
      setEnv("THAR_SHADOW_LOG", log);
      setEnv("THAR_SHADOW", "1");
      const secret = "SECRET-TOKEN-should-never-be-logged";
      await envelopePackage({ ok: true, todos: [record("different line")] })(
        dir,
      );

      const filename = join(dir, "todo.txt");
      await Runtime.writeTextFile(filename, `${secret}:SECRET-VALUE\nsecond\n`);

      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const todos = await readTodosFromFile(filename);

      // The app keeps the TypeScript result; only the log changed.
      expect(todos.map((todo) => todo.toString())).toEqual([
        `${secret}:SECRET-VALUE`,
        "second",
      ]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain("thar shadow:");
      expect(warn.mock.calls[0]?.[0]).toContain(log);

      const content = readFileSync(log, "utf8");
      expect(content.endsWith("\n")).toBe(true);
      expect(content).not.toContain("SECRET");
      for (const line of content.trimEnd().split("\n")) {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        expect(parsed.kind).toBe("mismatch");
        expect(parsed.tsTodoCount).toBe(2);
        expect(parsed.rustTodoCount).toBe(1);
        expect(parsed.mismatchCount).toBe(2);
        const details = parsed.lines as Record<string, unknown>[];
        expect(details).toHaveLength(2);
        expect(details[0]).toMatchObject({
          index: 0,
          // Both fields disagree with the TypeScript line; `hash` is the same
          // serializer output, so it is reported separately.
          fields: ["toString", "hash"],
        });
        expect(String(details[0]?.tsHash)).toMatch(/^[0-9a-f]{16}$/);
        expect(String(details[0]?.rustHash)).toMatch(/^[0-9a-f]{16}$/);
      }
    });
  });

  test("uses the effective read limits instead of the compile-time defaults", async () => {
    await withTempDir(async (dir) => {
      const log = join(dir, "shadow.log");
      setEnv("THAR_SHADOW_LOG", log);
      setEnv("THAR_SHADOW", "1");
      // One line longer than the default 8 192 units but inside the override.
      setEnv("THAR_MAX_LINE_CHARS", "10000");
      const line = "a".repeat(9_000);
      const filename = join(dir, "todo.txt");
      await Runtime.writeTextFile(filename, `${line}\n`);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      await fakePackage(dir, limitAwarePackage());

      // The TypeScript reader accepts the file under the override and Rust
      // must reach the same verdict. Without the limits, the package's
      // `parseFile` (8 192) would record a spurious rejection here.
      const todos = await readTodosFromFile(filename);
      expect(todos.map((todo) => todo.toString())).toEqual([line]);
      expect(existsSync(log)).toBe(false);
      expect(warn).not.toHaveBeenCalled();

      // Under the same override a real difference is still caught, and it is
      // reported as a mismatch rather than a limit rejection.
      await fakePackage(
        dir,
        limitAwarePackage(" (rust)"),
        "thar_wasm_diff.cjs",
      );
      await readTodosFromFile(filename);

      const written = JSON.parse(readFileSync(log, "utf8").trim()) as Record<
        string,
        unknown
      >;
      expect(written.kind).toBe("mismatch");
      expect(written.mismatchCount).toBe(1);
      expect(written.tsTodoCount).toBe(1);
      expect(written.rustTodoCount).toBe(1);
    });
  });

  test("a Rust rejection of a loadable file is recorded", async () => {
    await withTempDir(async (dir) => {
      const log = join(dir, "shadow.log");
      setEnv("THAR_SHADOW_LOG", log);
      setEnv("THAR_SHADOW", "1");
      await envelopePackage({
        ok: false,
        error: {
          name: "TodoLineCountLimitError",
          code: "TOO_MANY_LINES",
          lineCount: 2,
          maxReadTodos: 1,
          message: "bounded",
        },
      })(dir);

      const filename = join(dir, "todo.txt");
      await Runtime.writeTextFile(filename, "one\ntwo\n");
      vi.spyOn(console, "warn").mockImplementation(() => {});
      await readTodosFromFile(filename);

      const record = JSON.parse(readFileSync(log, "utf8").trim()) as Record<
        string,
        unknown
      >;
      expect(record.kind).toBe("rejected");
      expect(record.tsTodoCount).toBe(2);
      expect(record.error).toEqual({
        name: "TodoLineCountLimitError",
        code: "TOO_MANY_LINES",
      });
      expect(JSON.stringify(record)).not.toContain("one");
    });
  });

  test("caps the log file by truncating older records", async () => {
    await withTempDir(async (dir) => {
      const log = join(dir, "shadow.log");
      setEnv("THAR_SHADOW_LOG", log);
      setEnv("THAR_SHADOW", "1");
      await envelopePackage({
        ok: true,
        todos: Array.from({ length: 20 }, (_, index) =>
          record(`rust-${index}`),
        ),
      })(dir);

      const todos = Array.from(
        { length: 20 },
        (_, index) => new Todo(`typescript-${index}`),
      );
      vi.spyOn(console, "warn").mockImplementation(() => {});
      for (let index = 0; index < 200; index++) {
        shadowCheckTodoFile("ignored", todos);
      }

      const size = readFileSync(log).byteLength;
      expect(size).toBeLessThanOrEqual(MAX_SHADOW_LOG_BYTES);
      const lines = readFileSync(log, "utf8").trimEnd().split("\n");
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
      // Truncation means the oldest records are gone, not that the newest
      // record was split: every line is still complete JSON.
      expect(lines.length).toBeLessThan(200);
    });
  }, 30_000);

  test("a broken package disables the check silently", async () => {
    await withTempDir(async (dir) => {
      const log = join(dir, "shadow.log");
      setEnv("THAR_SHADOW_LOG", log);
      setEnv("THAR_SHADOW", "1");
      setEnv("THAR_CORE_WASM", join(dir, "missing.js"));
      resetCoreBridgeForTests();
      const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const filename = join(dir, "todo.txt");
      await Runtime.writeTextFile(filename, "one\n");
      const todos = await readTodosFromFile(filename);

      expect(todos).toHaveLength(1);
      expect(existsSync(log)).toBe(false);
      expect(warn).not.toHaveBeenCalled();
      expect(debug).toHaveBeenCalledTimes(1);
    });
  });
});

describe("shadow log path", () => {
  // A made-up home directory: the branch tests pass it in, so nothing here
  // depends on the host user, `os.homedir()` or `process.platform`.
  const homeDir = join("/home", "someone");

  test("THAR_SHADOW_LOG wins over the cache directory", async () => {
    await withTempDir(async (dir) => {
      setEnv("XDG_CACHE_HOME", join(dir, "cache"));
      expect(shadowLogPath()).toBe(join(dir, "cache", "thar", "shadow.log"));
      // The exported path is the pure helper applied to the live globals.
      expect(shadowLogPath()).toBe(
        resolveShadowLogPath(process.env, process.platform, homedir()),
      );

      const explicit = join(dir, "elsewhere", "shadow.log");
      setEnv("THAR_SHADOW_LOG", explicit);
      expect(shadowLogPath()).toBe(explicit);
    });
  });

  test("XDG_CACHE_HOME wins on every platform, and empty means unset", () => {
    const cache = join("/tmp", "cache");
    const fallbacks = {
      linux: join(homeDir, ".cache"),
      darwin: join(homeDir, "Library", "Caches"),
      win32: join(homeDir, "AppData", "Local"),
    } as const;
    for (const platform of ["linux", "darwin", "win32"] as const) {
      expect(
        resolveShadowLogPath({ XDG_CACHE_HOME: cache }, platform, homeDir),
      ).toBe(join(cache, "thar", "shadow.log"));
      expect(
        resolveShadowLogPath({ XDG_CACHE_HOME: "" }, platform, homeDir),
      ).toBe(join(fallbacks[platform], "thar", "shadow.log"));
    }
  });

  test("falls back to the platform cache directory without XDG", () => {
    expect(resolveShadowLogPath({}, "linux", homeDir)).toBe(
      join(homeDir, ".cache", "thar", "shadow.log"),
    );
    // Every platform that is not darwin or win32 uses the XDG default.
    expect(resolveShadowLogPath({}, "aix", homeDir)).toBe(
      join(homeDir, ".cache", "thar", "shadow.log"),
    );
    expect(resolveShadowLogPath({}, "darwin", homeDir)).toBe(
      join(homeDir, "Library", "Caches", "thar", "shadow.log"),
    );
  });

  test("win32 prefers LOCALAPPDATA and falls back to the profile", () => {
    const localAppData = join(homeDir, "AppData", "Local");
    expect(
      resolveShadowLogPath({ LOCALAPPDATA: localAppData }, "win32", homeDir),
    ).toBe(join(localAppData, "thar", "shadow.log"));
    expect(resolveShadowLogPath({}, "win32", homeDir)).toBe(
      join(localAppData, "thar", "shadow.log"),
    );
    // LOCALAPPDATA is not consulted off Windows.
    expect(
      resolveShadowLogPath(
        { LOCALAPPDATA: join(homeDir, "ignored") },
        "darwin",
        homeDir,
      ),
    ).toBe(join(homeDir, "Library", "Caches", "thar", "shadow.log"));
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

    // The write-time guard is the Rust envelope, with the same line and code
    // point the TypeScript serializer would name.
    expect(
      serializeTodosWithCore([new Todo("safe"), new Todo("nul\u0000")]),
    ).toEqual({
      ok: false,
      error: { code: "UNSAFE_CONTROL_CHARACTER", index: 2, codePoint: 0 },
    });
  },
);

/**
 * CP3b2b: the rows path against the **real** package the wasm CI job just
 * built. The rest of this file drives a fake through the loader or a seam; this
 * is the only test that proves the request field names and the response shape
 * match `crates/thar-wasm` (a `views`-only regression is rejected with
 * `INVALID_INPUT` and falls back, so `entries` would be `undefined` here).
 *
 * Skipped in the Node matrix, where `pkg/` does not exist.
 */
test.skipIf(!existsSync(REAL_PACKAGE))(
  "the built package builds rows through the real loader",
  () => {
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
  },
);
