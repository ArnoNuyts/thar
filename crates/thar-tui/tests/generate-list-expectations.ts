/**
 * One-shot generator for `fixtures/list-expectations.json`.
 *
 * This file is **not** part of the test suite and CI never runs it. It records
 * the TypeScript pipeline the owned Rust row model replaces:
 *
 *   `sortByImportance` → `filterHidden` (unless `showHidden`) →
 *   `filterBySearch` → `createIndexes`
 *
 * for every parseable fixture in `testdata/port/`, both hidden modes, and the
 * fixed query list. The Rust test reads the committed JSON and never
 * regenerates it. Regenerate only when the fixture is deliberately changing:
 *
 * ```sh
 * PATH="$HOME/.local/share/mise/installs/node/26.12.0/bin:$PATH" \
 *   npx vite-node crates/thar-tui/tests/generate-list-expectations.ts
 * PATH="$HOME/.local/share/mise/installs/node/26.12.0/bin:$PATH" \
 *   npx oxfmt crates/thar-tui/tests/fixtures/list-expectations.json
 * ```
 *
 * The corpus clock is pinned to local `2026-11-15T12:00:00` by replacing
 * `Date`, exactly like `crates/thar-core/tests/generate-domain-expectations.ts`.
 * Lists with more than 500 expected entries are stored as `{count, sha256}` of
 * the newline-joined values; that keeps `large-10000.txt` reviewable while
 * still pinning its exact order and row encoding.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createIndexes } from "../../../logic/indexes.ts";
import { getReadLimits } from "../../../logic/limits.ts";
import { Todo } from "../../../logic/todo.ts";
import { validateTodoFileContent } from "../../../logic/todo-file-validation.ts";
import {
  filterBySearch,
  filterHidden,
  sortByImportance,
} from "../../../logic/Todos.ts";
import { IndexType } from "../../../types/enums.ts";

const CLOCK_LOCAL = "2026-11-15T12:00:00";

// Pin the clock before any oracle call. `new Date()` (and `Date.now()`) return
// the corpus clock; `new Date(args)` keeps the normal constructor.
const RealDate = Date;
const clockMilliseconds = new RealDate(CLOCK_LOCAL).getTime();
const FixedDate = new Proxy(RealDate, {
  construct(target, args) {
    return Reflect.construct(
      target,
      args.length === 0 ? [clockMilliseconds] : args,
    );
  },
  get(target, property, receiver) {
    if (property === "now") return () => clockMilliseconds;
    return Reflect.get(target, property, receiver);
  },
});
globalThis.Date = FixedDate;

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const corpusDir = path.join(repoRoot, "testdata/port");
const outputPath = path.join(here, "fixtures/list-expectations.json");

/** Must match the fixed list in `crates/thar-core/tests/domain_parity.rs`. */
const QUERIES = [
  "",
  "   ",
  "work",
  "@work",
  "+project",
  "alpha beta",
  "!!!",
  "MILK",
  "due:",
  "h:1",
  "@",
  "a.b",
  "\u039F\u0394\u039F\u03A3",
];

const SHOW_HIDDEN_MODES = [false, true];

const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

/** Full list for reviewability; a digest for the very large fixture. */
const encodeList = <T>(
  values: T[],
  digestAbove: number,
): T[] | { count: number; sha256: string } =>
  values.length > digestAbove
    ? { count: values.length, sha256: hash(values.join("\n")) }
    : values;

const encodeRows = (todos: Todo[]): string[] =>
  createIndexes(todos).map((entry) =>
    entry.type === IndexType.context
      ? `context:${entry.contextName}:${entry.todoCount}`
      : `todo:${entry.number}`,
  );

const fixtureNames = fs
  .readdirSync(corpusDir)
  .filter((name) => name.endsWith(".txt"))
  .sort();

const fixtures: Record<string, unknown> = {};

for (const name of fixtureNames) {
  const data = fs.readFileSync(path.join(corpusDir, name), "utf8");

  let todos: Todo[];
  try {
    // The same loader the TypeScript oracle uses: validate, drop blank lines,
    // parse each line and assign ids in load order.
    const lines = validateTodoFileContent(data, getReadLimits());
    todos = lines.filter((line) => line.trim()).map((line) => new Todo(line));
  } catch {
    // Error fixtures are pinned by thar-core's corpus_parity test.
    continue;
  }

  const sorted = sortByImportance(todos);
  const cases: unknown[] = [];

  for (const showHidden of SHOW_HIDDEN_MODES) {
    const base = showHidden ? sorted : filterHidden(sorted);

    for (const query of QUERIES) {
      const matched = filterBySearch(base, query);
      const order = matched.map((todo) => todos.indexOf(todo));
      const rows = encodeRows(matched);
      cases.push({
        showHidden,
        query,
        order: encodeList(order, 500),
        rows: encodeList(rows, 500),
      });
    }
  }

  fixtures[name] = {
    todoCount: todos.length,
    cases,
  };
}

const document = {
  oracle: {
    source:
      "TypeScript pipeline (logic/Todos.ts, logic/indexes.ts, logic/todo-file-validation.ts)",
    clockLocal: CLOCK_LOCAL,
    generatedAt: "2026-11-15",
    node: process.version,
    icu: process.versions.icu ?? "unknown",
    unicode: process.versions.unicode ?? "unknown",
    notes: [
      "Generated once with crates/thar-tui/tests/generate-list-expectations.ts; the Rust test never regenerates it.",
      "Each case records the input-list indexes (order) and the createIndexes encoding (rows) after sortByImportance, filterHidden unless showHidden, and filterBySearch.",
      "rows entries are 'context:<name>:<count>' or 'todo:<number>'; todo numbers are 1-based across the whole list and headers include None.",
      "Lists above 500 entries are stored as {count, sha256} of the newline-joined values.",
      "Known rejection fixtures in testdata/port are absent; thar-core's corpus parity owns them.",
    ],
  },
  queries: QUERIES,
  hiddenModes: SHOW_HIDDEN_MODES,
  fixtures,
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");

// oxlint-disable-next-line no-console
console.log(
  `wrote ${outputPath} (${Object.keys(fixtures).length} parseable fixtures, ${QUERIES.length} queries, ${SHOW_HIDDEN_MODES.length} hidden modes)`,
);
