/**
 * One-shot generator for `domain-expectations.json` (CP3a).
 *
 * This file is **not** part of the test suite and CI never runs it. It exists
 * so the committed expectations can be reproduced and reviewed instead of
 * being hand-written. The Rust tests read the JSON and never regenerate it; a
 * behaviour change is a deliberate change to the JSON, reviewed as such.
 *
 * CP3b folds this file into the live CP1 contract (`tools/port/`) instead of
 * keeping a second corpus.
 *
 * Run with:
 *
 * ```sh
 * npx vite-node crates/thar-core/tests/generate-domain-expectations.ts
 * npx oxfmt crates/thar-core/tests/domain-expectations.json
 * ```
 *
 * The corpus clock is pinned by replacing `Date` (the Vitest suite uses
 * `vi.setSystemTime`, which is not available outside Vitest). Every
 * clock-dependent oracle function therefore sees local
 * `2026-11-15T12:00:00`, the `clockLocal` value in `testdata/port/expected.json`.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { format, parseISO } from "date-fns";

import { getReadLimits } from "../../../logic/limits.ts";
import { createIndexes } from "../../../logic/indexes.ts";
import { IndexType } from "../../../types/enums.ts";
import { planRecurrence } from "../../../logic/recurrence.ts";
import { Todo } from "../../../logic/todo.ts";
import { validateTodoFileContent } from "../../../logic/todo-file-validation.ts";
import {
  filterBySearch,
  filterHidden,
  sortByImportance,
} from "../../../logic/Todos.ts";
import { extractSearchTerms } from "../../../utils/search-utils.ts";
import type { UpperCaseLetter } from "../../../types/types.ts";

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
const outputPath = path.join(here, "domain-expectations.json");

/** Fixed query list: the search pins the host-normalized terms and views. */
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
  "ΟΔΟΣ",
];

const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

/**
 * Small lists are committed in full (reviewable, good failure messages); very
 * large ones as `{count, sha256}` of the newline-joined values, documented in
 * the Rust test. A digest still pins the exact order and content.
 */
const encodeList = <T>(
  values: T[],
  digestAbove: number,
): T[] | { count: number; sha256: string } =>
  values.length > digestAbove
    ? { count: values.length, sha256: hash(values.join("\n")) }
    : values;

/** One todo's host-normalized search input: `[text, contexts, projects]`. */
type SearchView = [string, string[], string[]];

/**
 * `filterBySearch` lowercases the text, contexts, and projects itself. The
 * Rust core takes these values instead of folding again, because JavaScript's
 * `toLowerCase` applies the Unicode Final_Sigma rule with Case_Ignorable
 * skipping and `extractSearchTerms` is a JavaScript regex pipeline.
 */
const searchViewOf = (todo: Todo): SearchView => [
  todo.text.toLowerCase(),
  Array.from(todo.contexts).map((context) => context.toLowerCase()),
  Array.from(todo.projects).map((project) => project.toLowerCase()),
];

const indexOfTodos = (todos: Todo[], subset: Todo[]): number[] =>
  subset.map((todo) => todos.indexOf(todo));

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
  const raw = fs.readFileSync(path.join(corpusDir, name));
  const data = raw.toString("utf8");

  let todos: Todo[];
  try {
    const lines = validateTodoFileContent(data, getReadLimits());
    todos = lines.filter((line) => line.trim()).map((line) => new Todo(line));
  } catch {
    // Error fixtures have no domain expectations; corpus_parity.rs pins them.
    continue;
  }

  const sorted = sortByImportance(todos);
  const visible = filterHidden(todos);
  const visibleSorted = filterHidden(sorted);

  fixtures[name] = {
    todoCount: todos.length,
    sorted: encodeList(indexOfTodos(todos, sorted), 5000),
    visible: encodeList(indexOfTodos(todos, visible), 5000),
    rows: encodeList(encodeRows(visibleSorted), 5000),
    searchView: todos.map(searchViewOf),
    search: Object.fromEntries(
      QUERIES.map((query) => [
        query,
        encodeList(
          indexOfTodos(todos, filterBySearch(visibleSorted, query)),
          500,
        ),
      ]),
    ),
  };
}

// ---------------------------------------------------------------------------
// Synthetic list: deterministic LCG, mixed-case/punctuation contexts,
// priorities, due/threshold/hidden tags, and duplicate lines for stability.
// ---------------------------------------------------------------------------

const createRandom = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

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
];
const PRIORITIES = [undefined, "A", "B", "C", "D", "E", undefined];
const DUE_DATES = [
  undefined,
  undefined,
  "2020-01-01",
  "2026-11-14",
  "2026-11-15",
  "2026-11-16",
  "2999-12-31",
  "2026-02-30",
];
const THRESHOLDS = [
  undefined,
  undefined,
  "2026-11-14",
  "2026-11-16",
  "not-a-date",
];
const PROJECTS = [undefined, "+project", "+Project", "+side.project", "+a-1"];

const createSyntheticLines = (count: number): string[] => {
  const random = createRandom(20261020);
  const pick = <T>(values: T[]): T =>
    values[Math.floor(random() * values.length)];
  const lines: string[] = [];

  for (let index = 0; index < count; index++) {
    // Every seventh line repeats the previous one so equal-key stability and
    // duplicate detection are exercised.
    if (index > 0 && index % 7 === 0) {
      lines.push(lines[index - 1]);
      continue;
    }

    const done = pick([false, true]);
    const priority = pick(PRIORITIES);
    const context = pick(CONTEXTS);
    const due = pick(DUE_DATES);
    const threshold = pick(THRESHOLDS);
    const project = pick(PROJECTS);
    const hidden = pick([false, false, false, true]);

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

const syntheticLines = createSyntheticLines(1000);

const syntheticTodos = syntheticLines.map((line) => new Todo(line));
const syntheticSorted = sortByImportance(syntheticTodos);
const syntheticVisible = filterHidden(syntheticTodos);
const syntheticVisibleSorted = filterHidden(syntheticSorted);

const synthetic = {
  "synthetic-1000": {
    lines: syntheticLines,
    todoCount: syntheticTodos.length,
    sorted: encodeList(indexOfTodos(syntheticTodos, syntheticSorted), 5000),
    visible: encodeList(indexOfTodos(syntheticTodos, syntheticVisible), 5000),
    rows: encodeList(encodeRows(syntheticVisibleSorted), 5000),
    searchView: syntheticTodos.map(searchViewOf),
    search: Object.fromEntries(
      QUERIES.map((query) => [
        query,
        encodeList(
          indexOfTodos(
            syntheticTodos,
            filterBySearch(syntheticVisibleSorted, query),
          ),
          500,
        ),
      ]),
    ),
  },
};

// ---------------------------------------------------------------------------
// Collation probe: the ICU default order for the context alphabet.
// ---------------------------------------------------------------------------

const alphabet: string[] = [];
for (const character of "abcdefghijklmnopqrstuvwxyz") alphabet.push(character);
for (const character of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") alphabet.push(character);
for (const character of "0123456789") alphabet.push(character);
alphabet.push("_", "-", ".");

const collate = (a: string, b: string): number => a.localeCompare(b);

const singleCharacterOrder = [...alphabet].sort(collate);

const collationRandom = createRandom(20261115);
const collationStrings = new Set<string>([
  "",
  "a",
  "A",
  "b",
  "B",
  "ab",
  "aB",
  "Ab",
  "AB",
  "_",
  "-",
  ".",
  "0",
  "9",
  "a0",
  "a_",
  "a-",
  "a.",
  "aZ",
  "Az",
  "zz",
  "ZZ",
  "_a",
  "-a",
  ".a",
  "a_1",
  "a-1",
  "a.1",
  "a1",
  "A1",
  "alpha",
  "Zed",
]);
for (let index = 0; index < 600; index++) {
  const length = Math.floor(collationRandom() * 7);
  let value = "";
  for (let position = 0; position < length; position++) {
    value += alphabet[Math.floor(collationRandom() * alphabet.length)];
  }
  collationStrings.add(value);
}
const collationOrder = [...collationStrings].sort(collate);

// ---------------------------------------------------------------------------
// Search cases: the host normalization, including the internal-final-sigma
// shapes Rust cannot derive without JavaScript's Final_Sigma rule.
// ---------------------------------------------------------------------------

const SEARCH_CASES: Array<{ line: string; query: string }> = [
  // PR #64 blocker 1a/1b: `Σ` is final (or not) only after skipping
  // Case_Ignorable characters, so the term and the text fold differently.
  { line: "aσ.", query: "aΣ.Α" },
  { line: "aβ\u0301σ.", query: "aβ\u0301Σ." },
  { line: "aσ.\u0301a", query: "aΣ.\u0301a" },
  { line: "aς.", query: "aΣ." },
  // Term extraction: lowercasing, ASCII-only `\w` stripping, and prefixes.
  { line: "MILK", query: "MILK," },
  { line: "walk dog @home", query: "/@HOME/" },
  { line: "task @A.b @x", query: "@A.b" },
  { line: "task @a.b @a😀b", query: "a.b" },
  { line: "ΟΔΟΣ ΝΕΑ", query: "ΟΔΟΣ" },
  { line: "buy milk +work", query: "@work" },
];

const searchCases = SEARCH_CASES.map(({ line, query }) => {
  const todo = new Todo(line);
  return {
    line,
    query,
    view: searchViewOf(todo),
    terms: extractSearchTerms(query),
    matched: indexOfTodos([todo], filterBySearch([todo], query)),
  };
});

// ---------------------------------------------------------------------------
// Recurrence and setter/toggle pinning.
// ---------------------------------------------------------------------------

/**
 * Date-tag values must be built with `parseISO`: the `new Date(year, …)`
 * constructor maps years 0..99 to 1900+year, which would silently move a
 * `0001-01-01` recurrence base to 1901.
 */
const dateAt = (value: string): Date => parseISO(value);

const RECURRENCE_CASES: Array<[string, string]> = [
  ["1d", "2026-01-15"],
  ["2w", "2026-01-15"],
  ["3m", "2026-01-15"],
  ["1y", "2026-01-15"],
  ["+1d", "2026-01-15"],
  ["9999d", "2026-01-15"],
  ["9999y", "2026-01-15"],
  ["1m", "2024-01-31"],
  ["1m", "2026-01-31"],
  ["1y", "2024-02-29"],
  ["12m", "2024-02-29"],
  ["9m", "2024-05-31"],
  ["4y", "2024-02-29"],
  ["1m", "2024-03-31"],
  ["1m", "2024-12-31"],
  ["1d", "2026-12-31"],
  ["1w", "2026-12-29"],
  ["1m", "2026-12-15"],
  ["1y", "2026-12-31"],
  ["1d", "0001-01-01"],
  ["1y", "9999-01-01"],
  ["1m", "9999-12-01"],
  ["1w", "9999-12-31"],
  ["1d", "9999-12-31"],
  ["0d", "2026-01-15"],
  ["00w", "2026-01-15"],
  ["10000d", "2026-01-15"],
  ["999999999999y", "2026-01-15"],
  ["abc", "2026-01-15"],
  ["1D", "2026-01-15"],
  ["-1d", "2026-01-15"],
  ["1dd", "2026-01-15"],
  ["1d2", "2026-01-15"],
  ["d", "2026-01-15"],
  ["1", "2026-01-15"],
  ["1 d", "2026-01-15"],
  ["01dd", "2026-01-15"],
];

const recurrence = RECURRENCE_CASES.map(([value, base]) => {
  const plan = planRecurrence(value, dateAt(base));
  return "nextDue" in plan
    ? { value, base, nextDue: format(plan.nextDue, "yyyy-MM-dd") }
    : { value, base, error: plan.error };
});

type SetterCase = {
  line: string;
  op: string;
  arg?: string | null;
  preserve?: boolean;
};

const SETTER_CASES: SetterCase[] = [
  {
    line: "task +project @context rec:1d due:2024-01-01 t:2024-01-01 multi:one multi:two h:1",
    op: "set_text",
    arg: "renamed +project @context other:keep",
    preserve: true,
  },
  {
    line: "task +project @context rec:1d due:2024-01-01 t:2024-01-01 multi:one multi:two h:1",
    op: "set_text",
    arg: "renamed gamma:changed",
    preserve: false,
  },
  {
    line: "task gamma:three",
    op: "set_text",
    arg: "renamed alpha:one",
    preserve: true,
  },
  {
    line: "task gamma:three",
    op: "set_text",
    arg: "renamed gamma:changed alpha:one",
    preserve: true,
  },
  { line: "task", op: "set_priority", arg: "A" },
  { line: "(B) task", op: "set_priority", arg: "C" },
  { line: "(B) task", op: "set_priority", arg: null },
  { line: "task", op: "set_creation_date", arg: "2024-06-15" },
  { line: "2024-01-01 task", op: "set_creation_date", arg: "2024-06-15" },
  { line: "task", op: "set_completion_date", arg: "2024-06-15" },
  { line: "x 2024-01-01 done", op: "set_completion_date", arg: null },
  { line: "x 2024-01-01 done", op: "set_completion_date", arg: "2024-02-02" },
  {
    line: "x 2023-05-04 2023-02-29 literal",
    op: "set_completion_date",
    arg: null,
  },
  { line: "task", op: "set_state", arg: "done" },
  { line: "x 2024-03-02 2024-03-01 done", op: "set_state", arg: "todo" },
  { line: "task due:2024-01-01 other:keep", op: "set_due", arg: "2024-06-15" },
  { line: "task due:2024-01-01 other:keep", op: "remove_due" },
  {
    line: "task t:2024-01-01 other:keep",
    op: "set_threshold",
    arg: "2024-06-15",
  },
  { line: "task t:2024-01-01 other:keep", op: "remove_threshold" },
  { line: "task h:1", op: "toggle_hidden" },
  { line: "task h:x other:keep", op: "toggle_hidden" },
  { line: "task h:0", op: "toggle_hidden" },
  { line: "task", op: "toggle_hidden" },
  { line: "task rec:2w", op: "set_recurrence", arg: "1d" },
  { line: "task rec:2w", op: "set_recurrence", arg: "0d" },
  { line: "task", op: "set_recurrence", arg: "9999d" },
  { line: "task rec:1d", op: "remove_recurrence" },
  {
    line: "task +project @context other:keep",
    op: "add_context",
    arg: "errand",
  },
  {
    line: "task +project @context other:keep",
    op: "add_context",
    arg: "context",
  },
  {
    line: "task +project @context other:keep",
    op: "remove_context",
    arg: "context",
  },
  {
    line: "task +project @context other:keep",
    op: "remove_context",
    arg: "missing",
  },
  { line: "one @aXb two @a.b", op: "remove_context", arg: "a.b" },
  { line: "task +project @context other:keep", op: "add_project", arg: "side" },
  {
    line: "task +project @context other:keep",
    op: "remove_project",
    arg: "project",
  },
  {
    line: "task +project @context other:keep",
    op: "remove_project",
    arg: "missing",
  },
];

const applySetter = (testCase: SetterCase): Todo => {
  const todo = new Todo(testCase.line);
  switch (testCase.op) {
    case "set_text":
      return todo.setText(testCase.arg ?? "", {
        preserveTags: testCase.preserve,
      });
    case "set_priority":
      return testCase.arg
        ? todo.setPriority(testCase.arg as UpperCaseLetter)
        : todo.setPriority(undefined);
    case "set_creation_date":
      return todo.setCreationDate(dateAt(testCase.arg ?? "2024-06-15"));
    case "set_completion_date":
      return todo.setCompletionDate(
        testCase.arg ? dateAt(testCase.arg) : undefined,
      );
    case "set_state":
      return todo.setState(testCase.arg === "done" ? 2 : 1);
    case "set_due":
      return todo.setDue(dateAt(testCase.arg ?? "2024-06-15"));
    case "remove_due":
      return todo.removeDue();
    case "set_threshold":
      return todo.setThreshold(dateAt(testCase.arg ?? "2024-06-15"));
    case "remove_threshold":
      return todo.removeThreshold();
    case "toggle_hidden":
      return todo.toggleHidden();
    case "set_recurrence":
      return todo.setRecurrence(testCase.arg ?? "");
    case "remove_recurrence":
      return todo.removeRecurrence();
    case "add_context":
      return todo.addContext(testCase.arg ?? "");
    case "remove_context":
      return todo.removeContext(testCase.arg ?? "");
    case "add_project":
      return todo.addProject(testCase.arg ?? "");
    case "remove_project":
      return todo.removeProject(testCase.arg ?? "");
    default:
      throw new Error(`unknown setter op ${testCase.op}`);
  }
};

const setters = SETTER_CASES.map((testCase) => {
  const original = new Todo(testCase.line);
  const updated = applySetter(testCase);
  return {
    line: testCase.line,
    op: testCase.op,
    arg: testCase.arg ?? null,
    preserve: testCase.preserve ?? false,
    original: original.toString(),
    expected: updated.toString(),
  };
});

const SEARCH_TERM_QUERIES = [
  ...QUERIES,
  "/@work +bug/",
  "/@home/",
  "milk,",
  "..abc..",
  "-x-",
  "@@@",
  "+/",
  "a@b+",
  "ασ",
  "xσx",
];

const TOGGLE_CASES = [
  "task rec:1d",
  "task rec:+2d",
  "task rec:1w",
  "task rec:1m",
  "task rec:1y",
  "due:2026-11-01 rec:2d",
  "due:2026-12-31 rec:1m",
  "task",
  "task rec:1D",
  "task rec:0d",
  "task rec:1d rec:2d",
  "x 2024-03-02 2024-03-01 done rec:1w",
  "2023-02-29 literal rec:1d",
  "x 2023-05-04 2023-02-29 literal rec:1d",
];

const toggles = TOGGLE_CASES.map((line) => {
  const result = new Todo(line).toggleState();
  return {
    line,
    updated: result.updated.toString(),
    recurring: result.recurring ? result.recurring.toString() : null,
    error: result.recurrenceError ?? null,
  };
});

const document = {
  oracle: {
    source: "TypeScript implementation (logic/, utils/)",
    clockLocal: CLOCK_LOCAL,
    generatedAt: "2026-11-15",
    node: process.version,
    icu: process.versions.icu ?? "unknown",
    unicode: process.versions.unicode ?? "unknown",
    collation: "Intl.Collator default (locale-dependent, en-US here)",
    notes: [
      "Generated once with crates/thar-core/tests/generate-domain-expectations.ts; tests never regenerate it.",
      "Temporary until CP3b replaces this file with the live CP1 contract.",
      "Fixture and synthetic indexes are positions in the input todo list.",
      "searchView entries are [text, contexts, projects] already lowercased by the host.",
      "searchTerms entries are the host-normalized extractSearchTerms output for each query.",
      "searchCases pin the normalized view/terms for the sigma and astral-dot shapes.",
      "rows entries are 'context:<name>:<count>' or 'todo:<number>'.",
      "Lists above the digest threshold are stored as {count, sha256} of the newline-joined values.",
    ],
  },
  queries: QUERIES,
  fixtures,
  synthetic,
  collation: {
    singleCharacters: singleCharacterOrder,
    strings: collationOrder,
  },
  searchTerms: SEARCH_TERM_QUERIES.map((query) => ({
    query,
    terms: extractSearchTerms(query),
  })),
  searchCases,
  recurrence,
  setters,
  toggles,
};

fs.writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");

const syntheticSummary = Object.keys(synthetic)[0];
// oxlint-disable-next-line no-console
console.log(
  `wrote ${outputPath} (${fixtureNames.length} fixtures, ${syntheticSummary}, ${syntheticLines.length} synthetic todos, ${collationOrder.length} collation strings)`,
);
