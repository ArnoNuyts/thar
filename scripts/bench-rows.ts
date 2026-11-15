/**
 * Preliminary CP3b2a row-builder benchmark.
 *
 * Compares the TypeScript index build
 * (`sortByImportance → filterHidden → filterBySearch → createIndexes`) with the
 * gated `buildRowsWithCore` adapter at 50 / 3 000 / 10 000 todos, for an empty
 * query, a one-term query and a multi-term query.
 *
 * "warm" measurements reuse the todo array, so the adapter's per-array record
 * and view cache is populated; "cold" measurements pass a fresh array copy and
 * therefore include building the structured input. Every number includes the
 * adapter's JSON marshalling, which is the part CP3b1 asked to measure.
 *
 * The real WASM `buildRows` export lands in CP3b1. When the package or the
 * export is missing, the script reports the TypeScript baseline plus the
 * adapter's marshalling cost through an injected empty-row builder, and says
 * the Rust side is pending. It is not a CI gate.
 *
 * Run with `npm run bench:rows`.
 */

import { existsSync } from "node:fs";
import { performance } from "node:perf_hooks";

import { getTodayKey } from "../hooks/useTodayKey.ts";
import {
  buildRowsWithCore,
  resetCoreBridgeForTests,
  setRowBuilderForTests,
} from "../logic/core-wasm.ts";
import { formatDateTag } from "../logic/dates.ts";
import { createIndexes, type IndexEntry } from "../logic/indexes.ts";
import {
  filterBySearch,
  filterHidden,
  sortByImportance,
} from "../logic/Todos.ts";
import { Todo } from "../logic/todo.ts";

const SIZES = [50, 3_000, 10_000] as const;
const QUERIES = [
  { label: "empty", query: "" },
  { label: "one-term", query: "milk" },
  { label: "multi-term", query: "task @work" },
] as const;

const ITERATIONS: Record<number, number> = {
  50: 80,
  3_000: 25,
  10_000: 12,
};

const WORDS = [
  "milk",
  "report",
  "review",
  "call",
  "ship",
  "alpha",
  "beta",
  "gamma",
  "δelta",
  "errand",
];
const CONTEXTS = ["work", "Work", "home", "errand", "reading", ""];

/**
 * Deterministic mixed list: done/priority/due/threshold/hidden, mixed-case
 * contexts, projects and a duplicated tag key. No randomness, so two runs
 * measure the same work.
 */
const makeTodos = (count: number): Todo[] =>
  Array.from({ length: count }, (_, index) => {
    const context = CONTEXTS[index % CONTEXTS.length] ?? "";
    const parts: string[] = [];
    if (index % 11 === 0) parts.push("x");
    if (index % 4 === 0) parts.push(`(${"ABCD"[index % 4] ?? "A"})`);
    if (index % 11 === 0) parts.push("2024-03-02");
    parts.push(`task ${index} ${WORDS[index % WORDS.length] ?? "milk"}`);
    if (index % 3 === 0) parts.push(`+project${index % 5}`);
    if (context) parts.push(`@${context}`);
    if (index % 13 === 0) parts.push("h:1");
    if (index % 17 === 0) parts.push("t:2999-01-01");
    if (index % 19 === 0) parts.push("due:2024-01-01");
    if (index % 23 === 0) parts.push("alpha:one alpha:two");
    return new Todo(parts.join(" "));
  });

const tsRows = (todos: Todo[], query: string): IndexEntry[] => {
  let list = sortByImportance(todos);
  list = filterHidden(list);
  list = filterBySearch(list, query);
  return createIndexes(list);
};

const percentile = (samples: number[], fraction: number): number => {
  const position = Math.min(
    samples.length - 1,
    Math.max(0, Math.ceil(samples.length * fraction) - 1),
  );
  return samples[position] ?? 0;
};

const measure = (
  run: () => unknown,
  iterations: number,
): { p50: number; p95: number } => {
  for (let warmup = 0; warmup < Math.min(3, iterations); warmup++) run();
  const samples: number[] = [];
  for (let index = 0; index < iterations; index++) {
    const start = performance.now();
    run();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return { p50: percentile(samples, 0.5), p95: percentile(samples, 0.95) };
};

const fixed = (value: number): string => value.toFixed(2).padStart(8);

const printRow = (
  size: number,
  query: string,
  path: string,
  stats: { p50: number; p95: number } | undefined,
  rows: number | string,
): void => {
  const timing = stats
    ? `${fixed(stats.p50)} ${fixed(stats.p95)}`
    : `${"-".padStart(8)} ${"-".padStart(8)}`;
  console.log(
    `${String(size).padStart(6)}  ${query.padEnd(11)}  ${path.padEnd(26)} ${timing}  ${rows}`,
  );
};

/** The row count of a `buildRowsWithCore` result, or `undefined` on fallback. */
const rowCount = (rows: IndexEntry[] | undefined): number | undefined =>
  rows?.length;

const main = (): void => {
  // The benchmark asks the adapter for Rust rows directly; the TypeScript path
  // below is explicit, so the flag does not affect its measurement.
  process.env.THAR_CORE = "rust";

  const today = formatDateTag(new Date(getTodayKey()));
  const packageFound = existsSync(
    new URL("../crates/thar-wasm/pkg/thar_wasm.js", import.meta.url),
  );

  // Availability probing and the timing runs stay quiet; the header below is
  // the report.
  const debug = console.debug;
  console.debug = () => {};
  try {
    const probeRows = buildRowsWithCore(makeTodos(10), "", false, today);
    const rustAvailable = probeRows !== undefined;

    console.log(
      `thar row builder benchmark — Node ${process.version}, today ${today}`,
    );
    console.log(
      `THAR_CORE=rust, package ${packageFound ? "found" : "missing"}, ` +
        `buildRows ${rustAvailable ? "available" : "pending (CP3b1)"}`,
    );
    console.log("");
    console.log(
      `${"todos".padStart(6)}  ${"query".padEnd(11)}  ${"path".padEnd(26)} ${"p50 ms".padStart(8)} ${"p95 ms".padStart(8)}  rows`,
    );

    for (const size of SIZES) {
      const base = makeTodos(size);
      const iterations = ITERATIONS[size] ?? 12;

      for (const { label, query } of QUERIES) {
        const ts = measure(() => tsRows(base, query), iterations);
        printRow(size, label, "ts", ts, tsRows(base, query).length);

        // Warm: same array, so the record/view cache is populated after warmup.
        const rustWarm = buildRowsWithCore(base, query, false, today);
        if (rustAvailable) {
          const stats = measure(
            () => buildRowsWithCore(base, query, false, today),
            iterations,
          );
          printRow(
            size,
            label,
            "rust (warm)",
            stats,
            rowCount(rustWarm) ?? "-",
          );
        }

        // Cold: a fresh array copy forces the structured input to be rebuilt.
        const coldRuns = Math.max(5, Math.floor(iterations / 2));
        if (rustAvailable) {
          const stats = measure(
            () => buildRowsWithCore([...base], query, false, today),
            coldRuns,
          );
          printRow(
            size,
            label,
            "rust (cold input)",
            stats,
            rowCount(buildRowsWithCore([...base], query, false, today)) ?? "-",
          );
          if (rowCount(rustWarm) !== tsRows(base, query).length) {
            console.log(
              `  ! row count differs from TS at ${size} todos, query "${query}"`,
            );
          }
        } else {
          // No Rust export: still measure the adapter's own input marshalling
          // (JSON.stringify of every record and view) as a lower-bound cost.
          setRowBuilderForTests(() => JSON.stringify({ ok: true, rows: [] }));
          const warm = measure(
            () => buildRowsWithCore(base, query, false, today),
            iterations,
          );
          printRow(size, label, "marshal only (warm, fake)", warm, "-");
          const cold = measure(
            () => buildRowsWithCore([...base], query, false, today),
            coldRuns,
          );
          printRow(size, label, "marshal only (cold, fake)", cold, "-");
          setRowBuilderForTests(undefined);
        }
      }
    }

    if (!rustAvailable) {
      console.log("");
      console.log(
        "Rust buildRows is not available in this checkout; the TS baseline " +
          "and the adapter marshalling cost above are preliminary. The Rust " +
          "side lands with CP3b1 and is wired/measured in CP3b2b.",
      );
    }
  } finally {
    console.debug = debug;
    resetCoreBridgeForTests();
  }
};

main();
