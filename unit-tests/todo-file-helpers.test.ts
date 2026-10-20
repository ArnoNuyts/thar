import { assertEquals, assertRejects } from "@std/assert";
import { join } from "node:path";
import { readTodosFromFile } from "../logic/todo-file-helpers.ts";

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("readTodosFromFile - creates a missing file and returns empty Todos", async () => {
  await withTempDir(async (dir) => {
    const filename = join(dir, "todos.txt");

    const todos = await readTodosFromFile(filename);

    assertEquals(todos.length, 0, "Should return an empty Todos object");
    assertEquals(
      await Deno.readTextFile(filename),
      "",
      "Missing file should be created empty",
    );
  });
});

Deno.test("readTodosFromFile - throws on unreadable paths instead of exiting", async () => {
  await withTempDir(async (dir) => {
    // Reading a directory fails with an error other than NotFound.
    await assertRejects(() => readTodosFromFile(dir), /EISDIR/);
  });
});

Deno.test("readTodosFromFile - parses existing file lines", async () => {
  await withTempDir(async (dir) => {
    const filename = join(dir, "todos.txt");
    await Deno.writeTextFile(filename, "(A) First task\n\n(B) Second task\n");

    const todos = await readTodosFromFile(filename);

    assertEquals(todos.length, 2);
    assertEquals(todos[0].toString(), "(A) First task");
    assertEquals(todos[1].toString(), "(B) Second task");
  });
});
