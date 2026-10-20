import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";

const RUNTIME_ROOTS = [
  "main.tsx",
  "components",
  "contexts",
  "hooks",
  "logic",
  "scripts",
  "theme",
  "types",
  "utils",
];

const NON_PORTABLE_IMPORT =
  /from\s+["'](?:jsr:|@std\/|https?:\/\/deno\.land\/)/;
const DENO_RUNTIME_REFERENCE = /\bDeno\./;

async function* walk(path: string): AsyncGenerator<string> {
  const info = await stat(path);
  if (info.isFile()) {
    yield path;
    return;
  }

  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      yield* walk(child);
    } else {
      yield child;
    }
  }
}

test("runtime code is Node-only", async () => {
  const offenders: string[] = [];

  for (const root of RUNTIME_ROOTS) {
    for await (const path of walk(root)) {
      if (!/\.(ts|tsx)$/.test(path)) continue;
      const source = await readFile(path, "utf8");
      if (
        NON_PORTABLE_IMPORT.test(source) ||
        DENO_RUNTIME_REFERENCE.test(source)
      ) {
        offenders.push(path);
      }
    }
  }

  expect(
    offenders,
    "Runtime files must use Node APIs and portable imports (node: or npm:)",
  ).toEqual([]);
});
