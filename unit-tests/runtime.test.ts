import { strict as assert } from "node:assert";
import { test } from "vitest";
import { Runtime } from "../utils/runtime.ts";

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await Runtime.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Runtime.remove(dir, { recursive: true });
  }
}

test("Runtime: reads, writes and appends text files", async () => {
  await withTempDir(async (dir) => {
    const filename = `${dir}/todos.txt`;

    await Runtime.writeTextFile(filename, "first");
    await Runtime.writeTextFile(filename, "\nsecond", { append: true });

    assert.equal(await Runtime.readTextFile(filename), "first\nsecond");
  });
});

test("Runtime: creates and removes directories", async () => {
  await withTempDir(async (dir) => {
    const nested = `${dir}/nested`;
    await Runtime.mkdir(nested);

    const info = await Runtime.stat(nested);
    assert.equal(info.isDirectory, true);
    assert.equal(info.isFile, false);
  });
});

test("Runtime: lists directory entries", async () => {
  await withTempDir(async (dir) => {
    await Runtime.writeTextFile(`${dir}/one.txt`, "1");
    await Runtime.writeTextFile(`${dir}/two.txt`, "2");

    const names: string[] = [];
    for await (const entry of Runtime.readDir(dir)) {
      names.push(entry.name);
      assert.equal(entry.isFile, true);
    }

    assert.deepEqual(names.sort(), ["one.txt", "two.txt"]);
  });
});

test("Runtime: watches a file and emits a change event", async () => {
  await withTempDir(async (dir) => {
    const filename = `${dir}/todos.txt`;
    await Runtime.writeTextFile(filename, "before");

    const watcher = Runtime.watchFs(filename);
    try {
      const nextEvent = watcher[Symbol.asyncIterator]().next();
      await Runtime.writeTextFile(filename, "after");

      const result = await Promise.race([
        nextEvent,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("watch event timed out")), 2_000);
        }),
      ]);

      assert.equal(result.done, false);
      assert.ok(
        result.value.kind === "modify" || result.value.kind === "rename",
        `unexpected event kind: ${result.value.kind}`,
      );
      assert.deepEqual(result.value.paths, [filename]);
    } finally {
      watcher.close();
    }
  });
});

test("Runtime: overwrites files atomically without leaving temp files", async () => {
  await withTempDir(async (dir) => {
    const filename = `${dir}/todos.txt`;
    await Runtime.writeTextFile(filename, "first");
    await Runtime.writeTextFile(filename, "second");

    assert.equal(await Runtime.readTextFile(filename), "second");

    const entries: string[] = [];
    for await (const entry of Runtime.readDir(dir)) {
      entries.push(entry.name);
    }

    assert.deepEqual(entries, ["todos.txt"]);
  });
});

test("Runtime: create: false refuses to create a missing file", async () => {
  await withTempDir(async (dir) => {
    const filename = `${dir}/missing.txt`;

    await assert.rejects(
      Runtime.writeTextFile(filename, "data", { create: false }),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    );
  });
});

test("Runtime: runs a command and captures stdout", async () => {
  const result = await new Runtime.Command(process.execPath, {
    args: ["-e", "process.stdout.write('ok')"],
  }).output();

  assert.equal(result.success, true);
  assert.equal(new TextDecoder().decode(result.stdout), "ok");
});
