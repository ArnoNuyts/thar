import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { build } from "vite";

const root = resolve(import.meta.dirname, "..");
const outputName =
  process.env.SEA_OUTPUT ??
  (process.platform === "win32" ? "thar.exe" : "thar");
const outputPath = resolve(root, "dist", outputName);
const bundlePath = resolve(root, "dist-sea", "main.mjs");
const seaConfigPath = resolve(root, "dist-sea", "sea-config.json");

await build({
  configFile: resolve(root, "vite.sea.config.ts"),
  root,
});

await mkdir(resolve(root, "dist"), { recursive: true });
await writeFile(
  seaConfigPath,
  JSON.stringify(
    {
      main: bundlePath,
      mainFormat: "module",
      output: outputPath,
      disableExperimentalSEAWarning: true,
    },
    null,
    2,
  ) + "\n",
);

execFileSync(process.execPath, ["--build-sea", seaConfigPath], {
  cwd: root,
  stdio: "inherit",
});

console.log(`\nSEA binary: ${outputPath} (${basename(outputPath)})`);
