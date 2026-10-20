import { assertEquals } from "@std/assert";

const RUNTIME_ROOTS = [
  "main.tsx",
  "components",
  "contexts",
  "hooks",
  "logic",
  "theme",
  "types",
  "utils",
];

const NON_PORTABLE_IMPORT =
  /from\s+["'](?:jsr:|@std\/|https?:\/\/deno\.land\/)/;

async function* walk(path: string): AsyncGenerator<string> {
  const stat = await Deno.stat(path);
  if (stat.isFile) {
    yield path;
    return;
  }

  for await (const entry of Deno.readDir(path)) {
    yield* walk(`${path}/${entry.name}`);
  }
}

Deno.test("runtime code does not import JSR or deno.land modules", async () => {
  const offenders: string[] = [];

  for (const root of RUNTIME_ROOTS) {
    for await (const path of walk(root)) {
      if (!/\.(ts|tsx)$/.test(path)) continue;
      const source = await Deno.readTextFile(path);
      if (NON_PORTABLE_IMPORT.test(source)) {
        offenders.push(path);
      }
    }
  }

  assertEquals(
    offenders,
    [],
    "Runtime files must use portable imports (node: or npm:) so the Deno " +
      "dependency stays out of application code.",
  );
});
