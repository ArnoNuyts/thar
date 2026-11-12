import { Runtime } from "../utils/runtime.ts";
import { expect, test } from "vitest";

import { join } from "node:path";
import { TodoControlCharacterError } from "../logic/limits.ts";
import { Todo } from "../logic/todo.ts";
import {
  readTodosFromFile,
  writeTodosToFile,
} from "../logic/todo-file-helpers.ts";
import { originalWriteTextFile, restoreRuntimeMocks } from "./test-utils.ts";

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await Runtime.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Runtime.remove(dir, { recursive: true });
  }
}

test("readTodosFromFile - creates a missing file and returns empty Todos", async () => {
  await withTempDir(async (dir) => {
    const filename = join(dir, "todos.txt");

    const todos = await readTodosFromFile(filename);

    expect(todos.length, "Should return an empty Todos object").toEqual(0);
    expect(
      await Runtime.readTextFile(filename),
      "Missing file should be created empty",
    ).toEqual("");
  });
});

test("readTodosFromFile - throws on unreadable paths instead of exiting", async () => {
  await withTempDir(async (dir) => {
    // Reading a directory fails with an error other than NotFound.
    await expect(readTodosFromFile(dir)).rejects.toThrow(/EISDIR/);
  });
});

test("readTodosFromFile - parses existing file lines", async () => {
  await withTempDir(async (dir) => {
    const filename = join(dir, "todos.txt");
    await Runtime.writeTextFile(
      filename,
      "(A) First task\n\n(B) Second task\n",
    );

    const todos = await readTodosFromFile(filename);

    expect(todos.length).toEqual(2);
    expect(todos[0].toString()).toEqual("(A) First task");
    expect(todos[1].toString()).toEqual("(B) Second task");
  });
});

test("writeTodosToFile - refuses unsafe serialization before touching the file", async () => {
  await withTempDir(async (dir) => {
    const filename = join(dir, "todos.txt");
    await Runtime.writeTextFile(filename, "Original\n");

    const unsafe = [
      "esc\u001b[31mred",
      "c1\u009b31m",
      "line\u2028sep",
      "nul\u0000byte",
      "bare\rcr",
      "new\nline",
    ];

    for (const text of unsafe) {
      await expect(
        writeTodosToFile([new Todo(text)], filename),
        `Expected ${JSON.stringify(text)} to be refused`,
      ).rejects.toBeInstanceOf(TodoControlCharacterError);

      expect(
        await Runtime.readTextFile(filename),
        "A rejected write must leave the file unchanged",
      ).toEqual("Original\n");
    }

    // A valid file still reads normally after the refused writes.
    const todos = await readTodosFromFile(filename);
    expect(todos.map((todo) => todo.text)).toEqual(["Original"]);
  });
});

test("readTodosFromFile - ignores EEXIST when a concurrent writer creates the file", async () => {
  await withTempDir(async (dir) => {
    const filename = join(dir, "todos.txt");
    let injected = false;

    (Runtime as any).writeTextFile = async (
      path: string | URL,
      data: string,
      options?: { exclusive?: boolean },
    ) => {
      if (!injected && options?.exclusive) {
        injected = true;
        // Simulate a sync client creating the file between the failed stat
        // and our exclusive create.
        await originalWriteTextFile(path, "Concurrent todo\n");
      }
      return originalWriteTextFile(path, data, options as never);
    };

    try {
      const todos = await readTodosFromFile(filename);
      expect(injected).toEqual(true);
      expect(todos.map((todo) => todo.text)).toEqual(["Concurrent todo"]);
      expect(await Runtime.readTextFile(filename)).toEqual("Concurrent todo\n");
    } finally {
      restoreRuntimeMocks();
    }
  });
});
