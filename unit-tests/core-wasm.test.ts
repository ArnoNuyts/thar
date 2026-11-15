import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  MAX_SHADOW_LOG_BYTES,
  getCoreMode,
  isShadowEnabled,
  parseFileWithCore,
  resetCoreBridgeForTests,
  shadowCheckTodoFile,
  shadowLogPath,
} from "../logic/core-wasm.ts";
import { Todo } from "../logic/todo.ts";
import { readTodosFromFile } from "../logic/todo-file-helpers.ts";
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
  test("THAR_SHADOW_LOG wins over the cache directory", async () => {
    await withTempDir(async (dir) => {
      setEnv("XDG_CACHE_HOME", join(dir, "cache"));
      expect(shadowLogPath()).toBe(join(dir, "cache", "thar", "shadow.log"));

      const explicit = join(dir, "elsewhere", "shadow.log");
      setEnv("THAR_SHADOW_LOG", explicit);
      expect(shadowLogPath()).toBe(explicit);
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
