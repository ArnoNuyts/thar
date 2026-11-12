import { expect, test } from "vitest";
import { join } from "node:path";

import { Runtime } from "../utils/runtime.ts";
import {
  readTodosFromFile,
  writeTodosToFile,
} from "../logic/todo-file-helpers.ts";
import {
  type ReadLimits,
  TodoControlCharacterError,
  TodoFileTooLargeError,
  TodoLineCountLimitError,
  TodoLineLengthLimitError,
} from "../logic/limits.ts";
import { restoreRuntimeMocks } from "./test-utils.ts";

const limits = (overrides: Partial<ReadLimits> = {}): ReadLimits => ({
  maxFileBytes: 1024 * 1024,
  maxReadTodos: 10_000,
  maxLineChars: 8192,
  ...overrides,
});

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await Runtime.makeTempDir();
  try {
    await fn(dir);
  } finally {
    restoreRuntimeMocks();
    await Runtime.remove(dir, { recursive: true });
  }
}

const captureRejection = async (
  promise: Promise<unknown>,
): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the promise to reject");
};

test("readTodosFromFile: creates a missing file and returns no todos", async () => {
  await withTempDir(async (dir) => {
    const filename = join(dir, "todos.txt");

    const todos = await readTodosFromFile(filename);

    expect(todos).toEqual([]);
    expect(await Runtime.readTextFile(filename)).toEqual("");
  });
});

test("readTodosFromFile: loads normal and CRLF content", async () => {
  await withTempDir(async (dir) => {
    const filename = join(dir, "todos.txt");
    await Runtime.writeTextFile(filename, "First task\r\n\r\nSecond task\r\n");

    const todos = await readTodosFromFile(filename);

    expect(todos.map((todo) => todo.text)).toEqual([
      "First task",
      "Second task",
    ]);
  });
});

test("readTodosFromFile: CRLF and blank lines normalize to LF on save", async () => {
  await withTempDir(async (dir) => {
    const filename = join(dir, "todos.txt");
    await Runtime.writeTextFile(
      filename,
      "First task\r\n\r\nSecond task\r\n\r\n",
    );

    const todos = await readTodosFromFile(filename);
    await writeTodosToFile(todos, filename);

    expect(await Runtime.readTextFile(filename)).toEqual(
      "First task\nSecond task\n",
    );
  });
});

test("readTodosFromFile: rejects an oversized file from stat before reading", async () => {
  await withTempDir(async (dir) => {
    const filename = join(dir, "todos.txt");
    await Runtime.writeTextFile(filename, "x".repeat(200));

    let readCount = 0;
    (Runtime as any).readTextFile = async () => {
      readCount++;
      return "";
    };

    const error = await captureRejection(
      readTodosFromFile(filename, limits({ maxFileBytes: 100 })),
    );

    expect(error).toBeInstanceOf(TodoFileTooLargeError);
    expect((error as TodoFileTooLargeError).actualBytes).toEqual(200);
    expect((error as TodoFileTooLargeError).maxBytes).toEqual(100);
    expect(readCount, "An oversized file must not be read").toEqual(0);
    expect((error as Error).message.length).toBeLessThan(300);
  });
});

test("readTodosFromFile: re-checks UTF-8 bytes after the read", async () => {
  await withTempDir(async (dir) => {
    const filename = join(dir, "todos.txt");
    await Runtime.writeTextFile(filename, "small");

    (Runtime as any).stat = async () => ({ isFile: true, size: 1 });
    (Runtime as any).readTextFile = async () => "é".repeat(32);

    const error = await captureRejection(
      readTodosFromFile(filename, limits({ maxFileBytes: 32 })),
    );

    expect(error).toBeInstanceOf(TodoFileTooLargeError);
    // "é" is two UTF-8 bytes, so the decoded string is 64 bytes.
    expect((error as TodoFileTooLargeError).actualBytes).toEqual(64);
  });
});

test("readTodosFromFile: rejects too many lines with a bounded error", async () => {
  await withTempDir(async (dir) => {
    const filename = join(dir, "todos.txt");
    const marker = "LINE_COUNT_MARKER";
    await Runtime.writeTextFile(
      filename,
      `${Array.from({ length: 6 }, () => marker).join("\n")}\n`,
    );

    const error = await captureRejection(
      readTodosFromFile(filename, limits({ maxReadTodos: 5 })),
    );

    expect(error).toBeInstanceOf(TodoLineCountLimitError);
    expect((error as TodoLineCountLimitError).lineCount).toEqual(6);
    expect((error as TodoLineCountLimitError).maxReadTodos).toEqual(5);
    expect((error as Error).message).not.toContain(marker);
  });
});

test("readTodosFromFile: rejects a long line with its line number", async () => {
  await withTempDir(async (dir) => {
    const filename = join(dir, "todos.txt");
    await Runtime.writeTextFile(filename, `short\n${"x".repeat(21)}`);

    const error = await captureRejection(
      readTodosFromFile(filename, limits({ maxLineChars: 20 })),
    );

    expect(error).toBeInstanceOf(TodoLineLengthLimitError);
    expect((error as TodoLineLengthLimitError).lineNumber).toEqual(2);
    expect((error as TodoLineLengthLimitError).length).toEqual(21);
    expect((error as TodoLineLengthLimitError).maxLineChars).toEqual(20);
  });
});

test("readTodosFromFile: rejects poisoned content and leaves the file untouched", async () => {
  await withTempDir(async (dir) => {
    const filename = join(dir, "todos.txt");
    const marker = "POISON_MARKER";
    const poisoned = `good\n${marker}\u001b[31mred\n`;
    await Runtime.writeTextFile(filename, poisoned);

    const error = await captureRejection(readTodosFromFile(filename));

    expect(error).toBeInstanceOf(TodoControlCharacterError);
    expect((error as TodoControlCharacterError).lineNumber).toEqual(2);
    expect((error as TodoControlCharacterError).codePoint).toEqual(0x1b);
    expect((error as Error).message).not.toContain(marker);
    expect((error as Error).message).not.toContain("\u001b");
    expect(await Runtime.readTextFile(filename)).toEqual(poisoned);
  });
});
