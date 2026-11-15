import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  resetCoreBridgeForTests,
  serializeTodosWithCore,
  setSerializerForTests,
} from "../logic/core-wasm.ts";
import {
  TodoControlCharacterError,
  TodoFileValidationError,
} from "../logic/limits.ts";
import { Todo } from "../logic/todo.ts";
import {
  readTodosFromFile,
  resetWriteFallbackForTests,
  serializeTodosForWrite,
  writeTodosToFile,
} from "../logic/todo-file-helpers.ts";
import {
  Runtime,
  setWriteFaultForTests,
  type WriteFileOptions,
} from "../utils/runtime.ts";
import { originalWriteTextFile, restoreRuntimeMocks } from "./test-utils.ts";

/**
 * CP4 data-safety matrix for the byte-compared dual write.
 *
 * Real `fs` and temp directories throughout: the point is what ends up on disk,
 * not what a mock was told. The Rust boundary is a seam (`setSerializerForTests`)
 * or a tiny CommonJS package (`THAR_CORE_WASM`), so the suite runs in the Node
 * matrix without Rust or `crates/thar-wasm/pkg/`.
 *
 * No fixed sleeps: nothing here is time-dependent.
 */

const ENV_KEYS = ["THAR_CORE", "THAR_CORE_WASM", "NODE_ENV"] as const;
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
  resetWriteFallbackForTests();
  restoreRuntimeMocks();
  setWriteFaultForTests(undefined);
  vi.restoreAllMocks();
});

const withTempDir = async (fn: (dir: string) => Promise<void>) => {
  const dir = await Runtime.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Runtime.remove(dir, { recursive: true });
  }
};

const readBytes = (path: string): Buffer => readFileSync(path);

const bytesOf = (text: string): Buffer => Buffer.from(text, "utf8");

const listTempFiles = (dir: string): string[] =>
  readdirSync(dir).filter((name) => name.endsWith(".tmp"));

/** Point `THAR_CORE` at the Rust path and reset the bridge state. */
const useRustCore = () => {
  setEnv("THAR_CORE", "rust");
  resetCoreBridgeForTests();
};

/** A serializer that returns whatever the test says. */
const serializerReturning = (text: string) => {
  const calls: string[] = [];
  setSerializerForTests((input) => {
    calls.push(input);
    return JSON.stringify({ ok: true, text });
  });
  return calls;
};

describe("THAR_CORE=ts (the default)", () => {
  test("writes the TypeScript bytes and never asks Rust to serialize", async () => {
    await withTempDir(async (dir) => {
      const filename = join(dir, "todos.txt");
      const todos = [new Todo("(A) one @work due:2026-01-01"), new Todo("two")];
      const serializer = vi.fn(() => JSON.stringify({ ok: true, text: "x\n" }));
      setSerializerForTests(serializer);

      for (const value of [undefined, "ts", "", "wasm"]) {
        setEnv("THAR_CORE", value);
        await writeTodosToFile(todos, filename);
        expect(readBytes(filename)).toEqual(
          bytesOf(serializeTodosForWrite(todos)),
        );
      }
      expect(serializer).not.toHaveBeenCalled();
    });
  });

  test("does not load a package, even a broken one", async () => {
    await withTempDir(async (dir) => {
      const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
      // A package that would throw on require: if it were loaded, the debug
      // line would appear and the run would still succeed. Asserting both
      // gives the "not loaded" claim a failing mode.
      const pkg = join(dir, "thar_wasm.cjs");
      await Runtime.writeTextFile(pkg, 'throw new Error("should not load");\n');
      setEnv("THAR_CORE", undefined);
      setEnv("THAR_CORE_WASM", pkg);
      resetCoreBridgeForTests();

      const filename = join(dir, "todos.txt");
      const todos = [new Todo("one")];
      await writeTodosToFile(todos, filename);

      expect(readBytes(filename)).toEqual(bytesOf("one\n"));
      expect(debug).not.toHaveBeenCalled();
    });
  });
});

describe("THAR_CORE=rust dual write", () => {
  test("identical Rust text produces the TypeScript bytes", async () => {
    await withTempDir(async (dir) => {
      const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
      useRustCore();
      const filename = join(dir, "todos.txt");
      const todos = [new Todo("one"), new Todo("two @work")];

      // A faithful stand-in: same records, same write shape.
      const calls = serializerReturning("one\ntwo @work\n");
      await writeTodosToFile(todos, filename);

      expect(calls).toHaveLength(1);
      expect(JSON.parse(calls[0]!).todos).toHaveLength(2);
      expect(readBytes(filename)).toEqual(
        bytesOf(serializeTodosForWrite(todos)),
      );
      expect(debug).not.toHaveBeenCalled();
    });
  });

  test("different Rust text keeps the TypeScript bytes, one log, no throw", async () => {
    await withTempDir(async (dir) => {
      const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
      useRustCore();
      const filename = join(dir, "todos.txt");
      await Runtime.writeTextFile(filename, "Original\n");
      const todos = [new Todo("one"), new Todo("two")];
      serializerReturning("one\ntwo"); // dropped the trailing newline

      await expect(writeTodosToFile(todos, filename)).resolves.toBeUndefined();
      await writeTodosToFile(todos, filename); // a second save does not log again

      expect(readBytes(filename)).toEqual(bytesOf("one\ntwo\n"));
      expect(debug).toHaveBeenCalledTimes(1);
      const logged = String(debug.mock.calls[0]?.[0]);
      expect(logged).toContain(
        "serializeFile differs from the TypeScript serializer",
      );
      // Bounded and content-free: lengths and a byte offset, never a todo line.
      expect(logged).toContain("7 vs 8 bytes");
      expect(logged).toContain("first difference at byte 7");
      expect(logged).not.toContain("two");
      expect(listTempFiles(dir)).toEqual([]);
    });
  });

  test("a throwing export falls back with one log", async () => {
    await withTempDir(async (dir) => {
      const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
      useRustCore();
      const filename = join(dir, "todos.txt");
      const todos = [new Todo("SECRET-todo-91")];
      setSerializerForTests(() => {
        throw new SyntaxError("request was SECRET-todo-91");
      });

      await writeTodosToFile(todos, filename);
      expect(readBytes(filename)).toEqual(bytesOf("SECRET-todo-91\n"));

      expect(debug).toHaveBeenCalledTimes(1);
      const logged = String(debug.mock.calls[0]?.[0]);
      expect(logged).toContain("serializeFile failed (SyntaxError)");
      // `error.message` can quote the request, which contains every todo line.
      expect(logged).not.toContain("SECRET");
    });
  });

  test("a malformed envelope falls back with one log", async () => {
    await withTempDir(async (dir) => {
      useRustCore();
      const filename = join(dir, "todos.txt");
      const todos = [new Todo("one")];

      const cases: [string, string][] = [
        ["not json", "serializeFile failed (SyntaxError)"],
        ["{}", "malformed serializeFile envelope"],
        [JSON.stringify({ ok: true }), "malformed serializeFile envelope"],
        [
          JSON.stringify({ ok: true, text: 1 }),
          "malformed serializeFile envelope",
        ],
        [JSON.stringify({ ok: false }), "malformed serializeFile envelope"],
        [
          JSON.stringify({ ok: false, error: { code: 1 } }),
          "malformed serializeFile envelope",
        ],
        // A guard rejection without numeric fields cannot be mapped back.
        [
          JSON.stringify({
            ok: false,
            error: { code: "UNSAFE_CONTROL_CHARACTER" },
          }),
          "malformed serializeFile envelope",
        ],
        // An unexpected rejection code is reported with its code.
        [
          JSON.stringify({ ok: false, error: { code: "INVALID_INPUT" } }),
          "serializeFile rejected (INVALID_INPUT)",
        ],
      ];

      for (const [raw, expected] of cases) {
        // Each case starts from a fresh once-per-process log budget, so the
        // assertion is about the message, not about which case ran first.
        const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
        resetCoreBridgeForTests();
        setSerializerForTests(() => raw);

        await writeTodosToFile(todos, filename);
        expect(readBytes(filename), raw).toEqual(bytesOf("one\n"));
        expect(debug).toHaveBeenCalledTimes(1);
        expect(String(debug.mock.calls[0]?.[0])).toContain(expected);

        resetWriteFallbackForTests();
        debug.mockRestore();
      }
    });
  });

  test("a package without the export falls back and says so once", async () => {
    await withTempDir(async (dir) => {
      const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
      const pkg = join(dir, "thar_wasm.cjs");
      await Runtime.writeTextFile(
        pkg,
        'module.exports = { coreVersion: () => "0.9.9-test" };\n',
      );
      useRustCore();
      setEnv("THAR_CORE_WASM", pkg);
      resetCoreBridgeForTests();

      const filename = join(dir, "todos.txt");
      const todos = [new Todo("one")];
      await writeTodosToFile(todos, filename);
      await writeTodosToFile(todos, filename);

      expect(readBytes(filename)).toEqual(bytesOf("one\n"));
      const logged = debug.mock.calls.map((call) => String(call[0])).join("\n");
      expect(logged).toContain("serializeFile is not exported");
      expect(debug).toHaveBeenCalledTimes(1);
    });
  });

  test("a legitimate guard rejection throws the same error as the TS writer", async () => {
    await withTempDir(async (dir) => {
      const filename = join(dir, "todos.txt");
      await Runtime.writeTextFile(filename, "Original\n");
      useRustCore();
      // The todo list is safe (so the TypeScript serializer does not throw),
      // but the Rust envelope claims the write-time guard refused line 2.
      setSerializerForTests(() =>
        JSON.stringify({
          ok: false,
          error: {
            name: "TodoControlCharacterError",
            code: "UNSAFE_CONTROL_CHARACTER",
            message: "content-free in Rust",
            index: 2,
            codePoint: 27,
          },
        }),
      );

      const expected = new TodoControlCharacterError(2, 27);
      let thrown: unknown;
      try {
        await writeTodosToFile([new Todo("safe")], filename);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(TodoControlCharacterError);
      const error = thrown as TodoControlCharacterError;
      expect(error.name).toEqual(expected.name);
      expect(error.code).toEqual(expected.code);
      expect(error.lineNumber).toEqual(2);
      expect(error.codePoint).toEqual(27);
      expect(error.message).toEqual(expected.message);
      // Nothing was written: the guard runs before the writer is called.
      expect(readBytes(filename)).toEqual(bytesOf("Original\n"));
      expect(listTempFiles(dir)).toEqual([]);
    });
  });

  test("the append path appends exactly once and never duplicates", async () => {
    await withTempDir(async (dir) => {
      useRustCore();
      const filename = join(dir, "done.txt");
      const calls: WriteFileOptions[] = [];
      Runtime.writeTextFile = async (path, data, options) => {
        calls.push(options ?? {});
        return originalWriteTextFile(path, data, options);
      };

      await writeTodosToFile([new Todo("first")], filename, { append: true });
      // A second, different append must add one serialization, not repeat the
      // first. (The oracle and the Rust text are compared per write; the append
      // itself happens once.)
      setSerializerForTests(() =>
        JSON.stringify({ ok: true, text: "second\n" }),
      );
      await writeTodosToFile([new Todo("second")], filename, { append: true });

      expect(calls).toHaveLength(2);
      expect(calls.every((options) => options.append === true)).toBe(true);
      expect(readBytes(filename)).toEqual(bytesOf("first\nsecond\n"));
      expect(listTempFiles(dir)).toEqual([]);
    });
  });
});

describe("atomic replace", () => {
  test("an injected write failure leaves the target byte-identical and no temp", async () => {
    await withTempDir(async (dir) => {
      const filename = join(dir, "todos.txt");
      await Runtime.writeTextFile(filename, "Original\n");
      const before = readBytes(filename);

      setWriteFaultForTests("write");
      await expect(
        writeTodosToFile([new Todo("new")], filename),
      ).rejects.toMatchObject({ code: "ENOSPC" });

      expect(readBytes(filename)).toEqual(before);
      expect(listTempFiles(dir)).toEqual([]);
    });
  });

  test("an injected rename failure leaves the target and cleans the temp", async () => {
    await withTempDir(async (dir) => {
      const filename = join(dir, "todos.txt");
      await Runtime.writeTextFile(filename, "Original\n");
      const before = readBytes(filename);

      setWriteFaultForTests("rename");
      await expect(
        writeTodosToFile([new Todo("new")], filename),
      ).rejects.toMatchObject({ code: "EIO" });

      expect(readBytes(filename)).toEqual(before);
      expect(listTempFiles(dir)).toEqual([]);
    });
  });

  test("a read-only directory refuses the write and keeps the original", async () => {
    if (process.platform === "win32") return; // mode bits are not enforced
    await withTempDir(async (dir) => {
      const filename = join(dir, "todos.txt");
      await Runtime.writeTextFile(filename, "Original\n");
      const before = readBytes(filename);

      await Runtime.mkdir(join(dir, "locked"));
      const target = join(dir, "locked", "todos.txt");
      await Runtime.writeTextFile(target, "Locked\n");

      // `chmod` is a POSIX call; the runtime adapter does not expose it, so the
      // test uses `node:fs` directly like the rest of the safety suite.
      const { chmodSync } = await import("node:fs");
      chmodSync(join(dir, "locked"), 0o555);
      try {
        await expect(
          writeTodosToFile([new Todo("new")], target),
        ).rejects.toMatchObject({ code: "EACCES" });
        expect(readBytes(target)).toEqual(bytesOf("Locked\n"));
        expect(listTempFiles(join(dir, "locked"))).toEqual([]);
        // The untouched sibling is unaffected too.
        expect(readBytes(filename)).toEqual(before);
      } finally {
        chmodSync(join(dir, "locked"), 0o755);
      }
    });
  });

  test("a read-only file keeps its mode across the replace (POSIX)", async () => {
    // Atomic replace renames a temp file over the target, and POSIX `rename`
    // checks the *directory* permission, not the target's mode. So a read-only
    // `todo.txt` in a writable directory is still replaced (this predates CP4:
    // the same temp+rename ran before). The mode is copied to the temp file, so
    // the new bytes keep 0444. Windows refuses the rename instead.
    await withTempDir(async (dir) => {
      const { chmodSync, statSync } = await import("node:fs");
      const filename = join(dir, "todos.txt");
      await Runtime.writeTextFile(filename, "Original\n");
      chmodSync(filename, 0o444);

      try {
        if (process.platform === "win32") {
          await expect(
            writeTodosToFile([new Todo("new")], filename),
          ).rejects.toMatchObject({ code: "EPERM" });
          expect(readBytes(filename)).toEqual(bytesOf("Original\n"));
        } else {
          await writeTodosToFile([new Todo("new")], filename);
          expect(readBytes(filename)).toEqual(bytesOf("new\n"));
          expect(statSync(filename).mode & 0o777).toEqual(0o444);
        }
        expect(listTempFiles(dir)).toEqual([]);
      } finally {
        chmodSync(filename, 0o644);
      }
    });
  });

  test("an external edit is replaced atomically, never spliced into", async () => {
    // The write path is a whole-file replace: it never reads the target, so a
    // concurrent edit by another program cannot be merged or appended to. The
    // external content is simply gone, exactly as before CP4.
    await withTempDir(async (dir) => {
      const filename = join(dir, "todos.txt");
      const todos = [new Todo("one"), new Todo("two")];

      await writeTodosToFile(todos, filename);
      expect(readBytes(filename)).toEqual(bytesOf("one\ntwo\n"));

      // Another writer (a sync client, an editor) changes the file.
      const { writeFileSync } = await import("node:fs");
      writeFileSync(filename, "external\nedit from elsewhere\n");

      const readSpy = vi.spyOn(Runtime, "readTextFile");
      await writeTodosToFile([...todos, new Todo("three")], filename);

      expect(readSpy).not.toHaveBeenCalled();
      const written = readBytes(filename);
      expect(written).toEqual(bytesOf("one\ntwo\nthree\n"));
      expect(written.toString("utf8")).not.toContain("external");
      expect(written.toString("utf8")).not.toContain("elsewhere");
    });
  });

  test("a crash before the rename leaves the old file, then a save replaces it", async () => {
    await withTempDir(async (dir) => {
      const target = join(dir, "todos.txt");
      await Runtime.writeTextFile(target, "old\n");

      // The child process reaches the flush, then exits; the rename never runs.
      // `utils/runtime.ts` imports nothing but Node built-ins, so Node's type
      // stripping can load it directly and the child needs no build step.
      const script = join(dir, "crash-write.ts");
      await Runtime.writeTextFile(
        script,
        [
          'import { pathToFileURL } from "node:url";',
          "const { Runtime } = await import(pathToFileURL(process.argv[2]).href);",
          "await Runtime.writeTextFile(process.argv[3], process.argv[4]);",
          "",
        ].join("\n"),
      );
      const runtimePath = fileURLToPath(
        new URL("../utils/runtime.ts", import.meta.url),
      );
      const child = spawnSync(
        process.execPath,
        [script, runtimePath, target, "new\n"],
        {
          env: {
            ...process.env,
            NODE_ENV: "test",
            THAR_WRITE_CRASH: "before-rename",
          },
          encoding: "utf8",
        },
      );

      expect(child.status).toEqual(9);
      // Old or new, never partial and never empty.
      expect(readBytes(target)).toEqual(bytesOf("old\n"));

      // The leftover temp file is inert: the next save writes a fresh one.
      await Runtime.writeTextFile(target, "after\n");
      expect(readBytes(target)).toEqual(bytesOf("after\n"));
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
const CORPUS_DIR = join(process.cwd(), "testdata", "port");

/**
 * The real package, when `crates/thar-wasm/pkg/` exists (the Rust WASM CI job
 * and a developer checkout). Skipped in the Node matrix.
 */
test.skipIf(!existsSync(REAL_PACKAGE))(
  "the real package serializes and writes every corpus fixture byte-identically",
  async () => {
    setEnv("THAR_CORE", "rust");
    setEnv("THAR_CORE_WASM", undefined);
    resetCoreBridgeForTests();
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});

    const fixtures = readdirSync(CORPUS_DIR)
      .filter((name) => name.endsWith(".txt"))
      .sort();

    await withTempDir(async (dir) => {
      let checked = 0;
      for (const fixture of fixtures) {
        let todos: Todo[];
        try {
          todos = await readTodosFromFile(join(CORPUS_DIR, fixture));
        } catch (error) {
          // The rejection fixtures are the CP1 contract's, not the writer's.
          if (!(error instanceof TodoFileValidationError)) throw error;
          continue;
        }

        const tsText = serializeTodosForWrite(todos);
        const rust = serializeTodosWithCore(todos);
        expect(rust?.ok, fixture).toBe(true);
        if (rust?.ok !== true) continue;
        expect(
          Buffer.from(rust.text, "utf8").equals(Buffer.from(tsText, "utf8")),
          fixture,
        ).toBe(true);

        // The whole write path, not just the serializer: the file must hold the
        // exact TypeScript bytes even though Rust produced them.
        const target = join(dir, fixture);
        await writeTodosToFile(todos, target);
        expect(
          readBytes(target).equals(Buffer.from(tsText, "utf8")),
          fixture,
        ).toBe(true);
        expect(listTempFiles(dir), fixture).toEqual([]);
        checked++;
      }

      // Every parseable fixture was covered, not just the small ones. (The
      // corpus has 20 parseable *.txt files plus the 8 rejection fixtures.)
      expect(checked).toBeGreaterThanOrEqual(20);
    });

    expect(debug).not.toHaveBeenCalled();
  },
  60_000,
);
