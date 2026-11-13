import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const directory = resolve(process.argv[2] ?? "dist");
const ignored = new Set(["SHA256SUMS"]);
const names = (await readdir(directory))
  .filter((name) => !ignored.has(name) && !name.endsWith(".map"))
  .sort();

const lines = [];
for (const name of names) {
  const data = await readFile(join(directory, name));
  const hash = createHash("sha256").update(data).digest("hex");
  lines.push(`${hash}  ${name}`);
}

const output = join(directory, "SHA256SUMS");
await writeFile(output, lines.join("\n") + "\n");
console.log(`Wrote ${lines.length} checksums to ${output}`);
