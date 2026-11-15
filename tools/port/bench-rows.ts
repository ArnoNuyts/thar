/**
 * CP3b row-building benchmark.
 *
 * Measures the row path at 50 / 3 000 / 10 000 todos on a 120×40 terminal
 * (the realistic viewport; like the TypeScript `createIndexes`, the core builds
 * the whole row list, so the viewport does not change the measured work).
 *
 * Two implementations are measured in the same process:
 *
 * - **TS oracle**: `sortByImportance → filterHidden → filterBySearch →
 *   createIndexes`, the production per-keystroke pipeline;
 * - **WASM core**: `thar-wasm` `buildRows`, including the stateless marshalling
 *   the CP3b1 boundary uses (`JSON.stringify` of the request, the Rust JSON
 *   parse, and `JSON.parse` of the response).
 *
 * `parse+views` is measured once per size (the host would do it on load, not on
 * every keystroke). Per query the table reports the full stateless call so a
 * boundary regression cannot hide behind a cached payload; the split columns
 * show where the time goes.
 *
 * Each (size, query) is also a parity smoke test: the two orders must be equal,
 * otherwise the numbers are meaningless. Run from the repository root after
 * `wasm-pack build crates/thar-wasm --release --target nodejs --out-dir pkg`.
 *
 * ```sh
 * npm run port:bench:rows
 * ```
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createIndexes } from "../../logic/indexes.ts";
import { Todo } from "../../logic/todo.ts";
import {
  filterBySearch,
  filterHidden,
  sortByImportance,
} from "../../logic/Todos.ts";
import { extractSearchTerms } from "../../utils/search-utils.ts";
import { IndexType } from "../../types/enums.ts";
import { REPO_ROOT } from "./build.ts";
import { createGeneratedLines } from "./rows.ts";

const TODAY = "2026-11-15";

/** Sizes from the PLAN's performance targets. */
const SIZES = [50, 3_000, 10_000];

/** The three shapes the gate asks for. */
const QUERIES = ["", "work", "alpha beta"];

/** Iterations per (size, query); enough for a stable p95, small enough to wait. */
const iterationsFor = (size: number): number => {
  if (size <= 50) return 300;
  if (size <= 3_000) return 60;
  return 20;
};

const WARMUP = 5;

/** Reps for the once-per-load parse+views figure (median reported). */
const PREPARE_REPS = 5;

interface Measurement {
  total: number;
  stringify: number;
  build: number;
  parse: number;
}

const percentile = (values: number[], fraction: number): number => {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(fraction * sorted.length) - 1),
  );
  return sorted[index];
};

const formatMs = (value: number): string => value.toFixed(2);

const loadCore = () => {
  const entry = join(REPO_ROOT, "crates", "thar-wasm", "pkg", "thar_wasm.js");
  if (!existsSync(entry)) {
    process.stderr.write(
      `port-bench-rows: missing WASM package ${entry}; run ` +
        "`wasm-pack build crates/thar-wasm --release --target nodejs --out-dir pkg`\n",
    );
    process.exit(1);
  }
  const require = createRequire(import.meta.url);
  return require(entry) as {
    parseFile(text: string, today: string): string;
    buildRows(input: string): string;
  };
};

/** One todo record of the `parseFile` envelope. */
interface CoreTodo {
  text: string;
  state: "todo" | "done";
  priority: string | null;
  completionDate: string | null;
  creationDate: string | null;
  projects: string[];
  contexts: string[];
  tags: [string, string | string[]][];
}

const todoRecordOf = (todo: CoreTodo) => ({
  text: todo.text,
  state: todo.state,
  priority: todo.priority,
  completionDate: todo.completionDate,
  creationDate: todo.creationDate,
  projects: todo.projects,
  contexts: todo.contexts,
  tags: todo.tags,
});

const searchViewOf = (todo: CoreTodo) => ({
  text: todo.text.toLowerCase(),
  contexts: todo.contexts.map((context) => context.toLowerCase()),
  projects: todo.projects.map((project) => project.toLowerCase()),
});

const main = () => {
  const core = loadCore();
  const moduleDir = resolve(fileURLToPath(import.meta.url), "..");

  process.stdout.write(
    `port-bench-rows: ${SIZES.join(" / ")} todos, 120x40 terminal (40 rows), ` +
      `clock ${TODAY}\n` +
      `port-bench-rows: node ${process.version}, wasm ${resolve(moduleDir, "../../crates/thar-wasm/pkg")}\n` +
      "port-bench-rows: whole-list row build (same work as createIndexes), times in ms\n\n",
  );

  process.stdout.write(
    "| todos | query | TS p50 | TS p95 | WASM p50 | WASM p95 | stringify p50 | build p50 | parse p50 | payload KB |\n",
  );
  process.stdout.write(
    "| ----: | :---- | -----: | -----: | -------: | -------: | ------------: | --------: | --------: | ---------: |\n",
  );

  for (const size of SIZES) {
    const lines = createGeneratedLines(size);
    const text = `${lines.join("\n")}\n`;

    // ---- TS oracle: parse once, then the production pipeline per query.
    // Five reps; the median is the "load" cost the host pays once.
    const tsPrepares: number[] = [];
    let todos: Todo[] = [];
    for (let rep = 0; rep < PREPARE_REPS; rep++) {
      const started = performance.now();
      todos = lines.map((line) => new Todo(line));
      tsPrepares.push(performance.now() - started);
    }

    // ---- WASM core: parse once, derive the host-owned views, then call the
    // boundary per query. `payload` is stringified inside the timed loop.
    const wasmPrepares: number[] = [];
    let payload = {
      today: TODAY,
      showHidden: false,
      terms: [] as string[],
      todos: [] as ReturnType<typeof todoRecordOf>[],
      searchViews: [] as ReturnType<typeof searchViewOf>[],
    };
    for (let rep = 0; rep < PREPARE_REPS; rep++) {
      const started = performance.now();
      const parsed = JSON.parse(core.parseFile(text, TODAY)) as {
        ok: boolean;
        todos?: CoreTodo[];
      };
      if (!parsed.ok || parsed.todos === undefined) {
        throw new Error(
          `parseFile rejected the generated list at ${size} todos`,
        );
      }
      payload = {
        today: TODAY,
        showHidden: false,
        terms: [],
        todos: parsed.todos.map(todoRecordOf),
        searchViews: parsed.todos.map(searchViewOf),
      };
      wasmPrepares.push(performance.now() - started);
    }
    const emptyPayload = JSON.stringify(payload);

    process.stdout.write(
      `<!-- prepare: ${size} todos — TS parse ${formatMs(percentile(tsPrepares, 0.5))} ms, ` +
        `WASM parse+views ${formatMs(percentile(wasmPrepares, 0.5))} ms, empty payload ` +
        `${(emptyPayload.length / 1024).toFixed(0)} KB -->\n`,
    );

    for (const query of QUERIES) {
      const terms = extractSearchTerms(query);
      const iterations = iterationsFor(size);

      const tsTimes: number[] = [];
      const compareIndex = new Map(
        todos.map((todo, index) => [todo, index] as const),
      );

      for (let index = 0; index < iterations + WARMUP; index++) {
        const started = performance.now();
        const visible = filterHidden(sortByImportance(todos));
        createIndexes(filterBySearch(visible, query));
        const elapsed = performance.now() - started;
        if (index >= WARMUP) tsTimes.push(elapsed);
      }
      const tsOrder = createIndexes(
        filterBySearch(filterHidden(sortByImportance(todos)), query),
      )
        .filter((entry) => entry.type === IndexType.todo)
        .map((entry) => compareIndex.get(entry.todo) as number);

      const measurements: Measurement[] = [];
      let wasmOrder: number[] = [];

      for (let index = 0; index < iterations + WARMUP; index++) {
        payload.terms = terms;
        const started = performance.now();
        const input = JSON.stringify(payload);
        const stringified = performance.now();
        const output = core.buildRows(input);
        const built = performance.now();
        const envelope = JSON.parse(output) as {
          ok: boolean;
          order?: number[];
        };
        if (!envelope.ok || envelope.order === undefined) {
          throw new Error(
            `buildRows rejected the generated list at ${size} todos`,
          );
        }
        const parsedOutput = performance.now();
        wasmOrder = envelope.order;

        if (index >= WARMUP) {
          measurements.push({
            total: parsedOutput - started,
            stringify: stringified - started,
            build: built - stringified,
            parse: parsedOutput - built,
          });
        }
      }

      if (JSON.stringify(tsOrder) !== JSON.stringify(wasmOrder)) {
        throw new Error(
          `row order differs for ${size} todos / ${JSON.stringify(query)}: ` +
            `TS ${tsOrder.length} rows, WASM ${wasmOrder.length} rows`,
        );
      }

      const wasmTotals = measurements.map((measurement) => measurement.total);
      process.stdout.write(
        `| ${size} | ${JSON.stringify(query)} | ` +
          `${formatMs(percentile(tsTimes, 0.5))} | ${formatMs(percentile(tsTimes, 0.95))} | ` +
          `${formatMs(percentile(wasmTotals, 0.5))} | ${formatMs(percentile(wasmTotals, 0.95))} | ` +
          `${formatMs(
            percentile(
              measurements.map((m) => m.stringify),
              0.5,
            ),
          )} | ` +
          `${formatMs(
            percentile(
              measurements.map((m) => m.build),
              0.5,
            ),
          )} | ` +
          `${formatMs(
            percentile(
              measurements.map((m) => m.parse),
              0.5,
            ),
          )} | ` +
          `${(emptyPayload.length / 1024).toFixed(0)} |\n`,
      );
    }
  }
};

main();
