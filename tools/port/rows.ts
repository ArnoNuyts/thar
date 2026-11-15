import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { createIndexes } from "../../logic/indexes.ts";
import { type ReadLimits, getReadLimits } from "../../logic/limits.ts";
import { Todo } from "../../logic/todo.ts";
import { validateTodoFileContent } from "../../logic/todo-file-validation.ts";
import {
  filterBySearch,
  filterHidden,
  sortByImportance,
} from "../../logic/Todos.ts";
import { IndexType } from "../../types/enums.ts";
import { extractSearchTerms } from "../../utils/search-utils.ts";
import {
  CorpusError,
  DEFAULT_CLOCK_LOCAL,
  DEFAULT_CORPUS_DIR,
  compareFixtureNames,
  listFixtures,
} from "./build.ts";
import { pinClock } from "./clock.ts";

// The oracle builds `isOverdue`/`isVisibleInOverview` from the pinned clock, so
// pin the process timezone exactly like the CP1 harness. `clockLocal` is then
// one instant on every host.
process.env.TZ = "UTC";

/**
 * CP3b live rows contract.
 *
 * The oracle is the production pipeline
 * `sortByImportance → filterHidden → filterBySearch → createIndexes`; the
 * candidate is `thar-wasm`'s `parseFile` + `buildRows`. For every parseable
 * corpus fixture and one deterministic generated list, for a fixed query set
 * and both `showHidden` values, both sides emit one JSONL record:
 *
 * ```json
 * {
 *   "fixture": "tags.txt",
 *   "query": "MILK",
 *   "terms": ["milk"],
 *   "showHidden": false,
 *   "clockLocal": "2026-11-15T12:00:00",
 *   "todoCount": 12,
 *   "rows": [
 *     { "type": "context", "contextName": "None", "todoCount": 3 },
 *     { "type": "todo", "number": 1, "index": 5 }
 *   ],
 *   "order": [5, 0, 2]
 * }
 * ```
 *
 * `index` is the todo's position in the parsed fixture, `number` is the 1-based
 * todo-row number, and `order` repeats the todo-row indexes so a dropped or
 * reordered row is diffed directly. `terms` is the host-normalized
 * `extractSearchTerms` output that the candidate must use verbatim; the core
 * never folds case.
 *
 * The generated list is built here and handed to the candidate in a manifest
 * file, so there is no second committed corpus. Rejection fixtures (the
 * `control-*.txt` files) are skipped: `corpus_parity.rs` owns them.
 *
 * The CLI lives in `rows-cli.ts`; everything here is import-safe, so the
 * benchmark and the unit tests can build the same contract in-process.
 */

/**
 * The fixed query list. It covers the CP3a set (empty, whitespace-only,
 * `work`, `@work`, `+project`, a two-term query, a punctuation-only query,
 * uppercase, Unicode) plus the reverse final-sigma shapes that a per-character
 * fold gets wrong.
 */
export const ROW_QUERIES = [
  "",
  "   ",
  "work",
  "@work",
  "+project",
  "alpha beta",
  "!!!",
  "MILK",
  "ΟΔΟΣ",
  "aΣ.Α",
  "aβ\u0301Σ.",
  "due:",
] as const;

/** `showHidden=false` then `true`, for every query. */
export const ROW_SHOW_HIDDEN = [false, true] as const;

/** Name of the generated list in the contract. */
export const GENERATED_FIXTURE = "generated-1000.txt";

/** How many todos the generated list holds. */
export const GENERATED_TODO_COUNT = 1000;

export type RowsContractRow =
  | { type: "context"; contextName: string; todoCount: number }
  | { type: "todo"; number: number; index: number };

export interface RowsRecord {
  fixture: string;
  query: string;
  terms: string[];
  showHidden: boolean;
  clockLocal: string;
  todoCount: number;
  rows: RowsContractRow[];
  order: number[];
}

/** One normalized query, as the core receives it. */
export interface RowsQuery {
  query: string;
  terms: string[];
}

/** The candidate's input besides the corpus: queries, generated lines, clock. */
export interface RowsManifest {
  clockLocal: string;
  today: string;
  /**
   * The effective read limits. The oracle takes them from the environment
   * (`getReadLimits`), so a `THAR_MAX_*` override is passed to the candidate
   * instead of letting the two sides disagree about which fixture parses.
   */
  readLimits: {
    maxFileBytes: number;
    maxReadTodos: number;
    maxLineChars: number;
  };
  queries: RowsQuery[];
  showHidden: boolean[];
  generated: { fixture: string; lines: string[] }[];
}

/** Seeded bugs the self-check must detect in the oracle's own row builder. */
export type RowsMutationName =
  | "drop-none-header"
  | "miscount-headers"
  | "case-sensitive-search"
  | "ignore-threshold";

export const ROWS_MUTATION_NAMES: readonly RowsMutationName[] = [
  "drop-none-header",
  "miscount-headers",
  "case-sensitive-search",
  "ignore-threshold",
];

export const ROWS_MUTATIONS: Record<RowsMutationName, string> = {
  "drop-none-header":
    "omits the `None` header of the uncategorised group (a port that treats " +
    "the header as a display detail)",
  "miscount-headers":
    "reports `todoCount: 1` on every context header (a port that counts " +
    "headers instead of their group)",
  "case-sensitive-search":
    "matches terms against the raw (non-lowercased) text, contexts and " +
    "projects (a port that folds only one side of the search)",
  "ignore-threshold":
    "derives visibility from `h:` alone and ignores the `t:` threshold " +
    "(a port that drops the future-threshold rule)",
};

export const isRowsMutationName = (value: string): value is RowsMutationName =>
  (ROWS_MUTATION_NAMES as readonly string[]).includes(value);

/** A rows-contract build problem the CLI reports as one bounded line. */
export class RowsHarnessError extends Error {}

/** The production parse path: validate the file, drop blank lines, parse. */
const parseTodoText = (text: string, limits: ReadLimits): Todo[] => {
  const lines = validateTodoFileContent(text, limits);
  return lines.filter((line) => line.trim()).map((line) => new Todo(line));
};

const manifestLimits = (limits: ReadLimits): RowsManifest["readLimits"] => ({
  maxFileBytes: limits.maxFileBytes,
  maxReadTodos: limits.maxReadTodos,
  maxLineChars: limits.maxLineChars,
});

/**
 * Deterministic generated list: LCG, mixed-case/punctuation contexts,
 * priorities, due/threshold/hidden tags, and duplicate lines for stability.
 *
 * Built here (not committed) so the contract covers cases the corpus does not
 * need to grow for.
 */
export const createGeneratedLines = (
  count = GENERATED_TODO_COUNT,
): string[] => {
  let seed = 20261020;
  const random = (): number => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const pick = <T>(values: readonly T[]): T =>
    values[Math.floor(random() * values.length)];

  const CONTEXTS = [
    undefined,
    "home",
    "Home",
    "HOME",
    "work",
    "Work",
    "work-2",
    "work_2",
    "work.2",
    "alpha",
    "Zed",
    "9lives",
    "3d",
    "_hidden",
    "-dash",
    ".dot",
    "a1",
    "A1",
  ] as const;
  const PRIORITIES = [undefined, "A", "B", "C", "D", "E", undefined] as const;
  const DUE_DATES = [
    undefined,
    undefined,
    "2020-01-01",
    "2026-11-14",
    "2026-11-15",
    "2026-11-16",
    "2999-12-31",
    "2026-02-30",
  ] as const;
  const THRESHOLDS = [
    undefined,
    undefined,
    "2026-11-14",
    "2026-11-16",
    "not-a-date",
  ] as const;
  const PROJECTS = [
    undefined,
    "+project",
    "+Project",
    "+side.project",
    "+a-1",
  ] as const;

  const lines: string[] = [];
  for (let index = 0; index < count; index++) {
    // Every seventh line repeats the previous one so equal-key stability and
    // duplicate detection are exercised.
    if (index > 0 && index % 7 === 0) {
      lines.push(lines[index - 1]);
      continue;
    }

    const done = pick([false, true] as const);
    const priority = pick(PRIORITIES);
    const context = pick(CONTEXTS);
    const due = pick(DUE_DATES);
    const threshold = pick(THRESHOLDS);
    const project = pick(PROJECTS);
    const hidden = pick([false, false, false, true] as const);

    lines.push(
      [
        done ? "x" : "",
        priority ? `(${priority})` : "",
        `todo ${index}`,
        context ? `@${context}` : "",
        project ?? "",
        due ? `due:${due}` : "",
        threshold ? `t:${threshold}` : "",
        hidden ? "h:1" : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
  }

  return lines;
};

/** The manifest the oracle hands to its candidate. */
export const createManifest = (
  clockLocal = DEFAULT_CLOCK_LOCAL,
  limits: ReadLimits = getReadLimits(),
): RowsManifest => ({
  clockLocal,
  today: clockLocal.slice(0, 10),
  readLimits: manifestLimits(limits),
  queries: ROW_QUERIES.map((query) => ({
    query,
    terms: extractSearchTerms(query),
  })),
  showHidden: [...ROW_SHOW_HIDDEN],
  generated: [{ fixture: GENERATED_FIXTURE, lines: createGeneratedLines() }],
});

/** One parsed fixture or generated list. */
interface RowsFixture {
  name: string;
  todos: Todo[];
}

const generatedFixtures = (
  manifest: RowsManifest,
  limits: ReadLimits,
): RowsFixture[] =>
  manifest.generated.map(({ fixture, lines }) => ({
    name: fixture,
    // The generated lines are not a file, so join them the way the reader
    // would see them and run the same production parse path.
    todos: parseTodoText(`${lines.join("\n")}\n`, limits),
  }));

const corpusFixtures = (
  corpusDir: string,
  limits: ReadLimits,
): RowsFixture[] => {
  const fixtures: RowsFixture[] = [];

  for (const fixture of listFixtures(corpusDir)) {
    let raw: Buffer;
    try {
      raw = readFileSync(join(corpusDir, fixture));
    } catch (error) {
      throw new CorpusError(
        join(corpusDir, fixture),
        `cannot read fixture ${fixture}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    let todos: Todo[];
    try {
      // `Buffer#toString` decodes lossily, exactly like the production reader.
      todos = parseTodoText(raw.toString("utf8"), limits);
    } catch {
      // Rejection fixtures are owned by the CP1 contract and
      // `corpus_parity.rs`; there is no row model for a file that cannot parse.
      continue;
    }

    fixtures.push({ name: fixture, todos });
  }

  return fixtures;
};

/** Case-sensitive search over raw fields: the `case-sensitive-search` bug. */
const caseSensitiveSearch = (todos: Todo[], query: string): Todo[] => {
  if (!query.trim()) return todos;
  const terms = extractSearchTerms(query);

  return todos.filter((todo) =>
    terms.every((term) => {
      const normalized =
        term.startsWith("@") || term.startsWith("+") ? term.slice(1) : term;
      return (
        todo.text.includes(term) ||
        [...todo.contexts].some((context) => context.includes(normalized)) ||
        [...todo.projects].some((project) => project.includes(normalized))
      );
    }),
  );
};

/** The production pipeline, with an optional seeded bug for the self-check. */
const visibleTodos = (
  todos: Todo[],
  showHidden: boolean,
  mutation?: RowsMutationName,
): Todo[] => {
  const sorted = sortByImportance(todos);
  if (showHidden) return sorted;
  if (mutation === "ignore-threshold") {
    return sorted.filter((todo) => !todo.isHidden());
  }
  return filterHidden(sorted);
};

/**
 * Build the whole rows contract.
 *
 * `manifest` lets the oracle reproduce exactly what a candidate was told to
 * compute; in oracle mode it is created from the fixed query list.
 */
export const buildRowsContract = (
  options: {
    corpusDir?: string;
    clockLocal?: string;
    manifest?: RowsManifest;
    mutation?: RowsMutationName;
  } = {},
): {
  corpusDir: string;
  clockLocal: string;
  manifest: RowsManifest;
  records: RowsRecord[];
  jsonl: string;
} => {
  const corpusDir = resolve(options.corpusDir ?? DEFAULT_CORPUS_DIR);
  const clockLocal =
    options.manifest?.clockLocal ?? options.clockLocal ?? DEFAULT_CLOCK_LOCAL;
  pinClock(clockLocal);

  const limits = options.manifest?.readLimits ?? getReadLimits();
  const manifest =
    options.manifest ??
    createManifest(options.clockLocal ?? DEFAULT_CLOCK_LOCAL, limits);
  const fixtures = [
    ...corpusFixtures(corpusDir, limits),
    ...generatedFixtures(manifest, limits),
  ];
  fixtures.sort((left, right) => compareFixtureNames(left.name, right.name));

  const records: RowsRecord[] = [];

  for (const { name, todos } of fixtures) {
    // Identity map: `sortByImportance` keeps object identity, so this maps a
    // row back to its input index without an O(n²) `indexOf` per row.
    const indexOf = new Map(todos.map((todo, index) => [todo, index] as const));

    for (const { query, terms } of manifest.queries) {
      for (const showHidden of manifest.showHidden) {
        const visible = visibleTodos(todos, showHidden, options.mutation);
        const matched =
          options.mutation === "case-sensitive-search"
            ? caseSensitiveSearch(visible, query)
            : filterBySearch(visible, query);

        const rows: RowsContractRow[] = [];
        const order: number[] = [];

        for (const entry of createIndexes(matched)) {
          if (entry.type === IndexType.context) {
            if (
              options.mutation === "drop-none-header" &&
              entry.contextName === "None"
            ) {
              continue;
            }
            rows.push({
              type: "context",
              contextName: entry.contextName,
              todoCount:
                options.mutation === "miscount-headers" ? 1 : entry.todoCount,
            });
            continue;
          }

          const index = indexOf.get(entry.todo);
          if (index === undefined) {
            throw new RowsHarnessError(
              `row for ${name} refers to a todo outside the parsed list`,
            );
          }
          order.push(index);
          rows.push({ type: "todo", number: entry.number, index });
        }

        records.push({
          fixture: name,
          query,
          terms,
          showHidden,
          clockLocal,
          todoCount: order.length,
          rows,
          order,
        });
      }
    }
  }

  return {
    corpusDir,
    clockLocal,
    manifest,
    records,
    jsonl:
      records.map((record) => JSON.stringify(record)).join("\n") +
      (records.length > 0 ? "\n" : ""),
  };
};
