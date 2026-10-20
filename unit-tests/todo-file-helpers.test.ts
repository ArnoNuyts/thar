import { Runtime } from "../utils/runtime.ts";
import { expect, test } from "vitest";

import { join } from "node:path";
import { readTodosFromFile } from "../logic/todo-file-helpers.ts";

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
