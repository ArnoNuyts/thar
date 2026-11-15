// Interleaved fresh-process startup + peak-RSS matrix for the CP0 baseline
// (docs/rust-port/baseline.md §4.2, §5.5).
//
// Run from the repository root, after `npm run build`:
//
//   node scripts/port-startup-matrix.mjs [--rounds=7]
//
// Method: child_process.spawn() and performance.now() from spawn() to the
// child's "exit" event, stdout discarded. Peak RSS comes from
// scripts/port-rss-probe.mjs, which prints process.resourceUsage().maxRSS
// (KiB) at exit. Variants run round-robin so concurrent load on the host
// affects every variant equally.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const probe = join(here, "port-rss-probe.mjs");

const variants = {
  "app (dist/main.js --help)": ["dist/main.js", "--help"],
  'import("date-fns")': [
    "--input-type=module",
    "-e",
    'await import("date-fns")',
  ],
  'import("ink")': ["--input-type=module", "-e", 'await import("ink")'],
  "bare node (-e '')": ["-e", ""],
};

const roundsArg = process.argv.find((arg) => arg.startsWith("--rounds="));
const rounds = Number(roundsArg ? roundsArg.slice("--rounds=".length) : 7);
if (!Number.isInteger(rounds) || rounds < 1) {
  throw new Error("--rounds must be a positive integer");
}
if (!existsSync(join(process.cwd(), "dist/main.js"))) {
  throw new Error("dist/main.js is missing; run `npm run build` first");
}

const once = (argv) =>
  new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const child = spawn(process.execPath, ["--import", probe, ...argv], {
      cwd: process.cwd(),
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      const ms = performance.now() - startedAt;
      if (code !== 0) {
        reject(new Error(`exit ${code}: ${stderr}`));
        return;
      }
      const match = /MAXRSS_KB=(\d+)/.exec(stderr);
      resolve({ ms, rssKb: match ? Number(match[1]) : Number.NaN });
    });
  });

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = 0.5 * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
};

const results = Object.fromEntries(
  Object.keys(variants).map((name) => [name, []]),
);
for (let round = 0; round < rounds; round++) {
  for (const [name, argv] of Object.entries(variants)) {
    results[name].push(await once(argv));
  }
}

console.log(`rounds per variant: ${rounds}`);
for (const [name, samples] of Object.entries(results)) {
  const wallMs = samples.map((sample) => sample.ms);
  const rssMb = samples.map((sample) => sample.rssKb / 1024);
  console.log(`\n${name}`);
  console.log(
    `  wall ms: min ${Math.min(...wallMs).toFixed(0)} | p50 ${median(wallMs).toFixed(0)} | max ${Math.max(...wallMs).toFixed(0)}`,
  );
  console.log(
    `  peak RSS MB: min ${Math.min(...rssMb).toFixed(0)} | p50 ${median(rssMb).toFixed(0)} | max ${Math.max(...rssMb).toFixed(0)}`,
  );
  console.log(
    `  samples: ${wallMs.map((value) => value.toFixed(0)).join(", ")}`,
  );
}
