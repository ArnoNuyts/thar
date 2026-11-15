import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  coreTodoRecord,
  parseRecordToTodoParts,
  parseTodosWithCore,
  type CoreParseTodoRecord,
} from "../../logic/core-wasm.ts";
import {
  type ReadLimits,
  TodoFileTooLargeError,
  TodoFileValidationError,
  getReadLimits,
} from "../../logic/limits.ts";
import { Todo, type TodoParts } from "../../logic/todo.ts";
import { serializeTodosForWrite } from "../../logic/todo-file-helpers.ts";
import { validateTodoFileContent } from "../../logic/todo-file-validation.ts";
import { pinClock } from "./clock.ts";
import {
  CorpusError,
  DEFAULT_CLOCK_LOCAL,
  DEFAULT_CORPUS_DIR,
  contractError,
  listFixtures,
  sha256Hex,
} from "./build.ts";
import type { ContractError, ContractReadLimits } from "./types.ts";

// The contract includes `isOverdue`/`isVisibleInOverview`, which read the
// ambient clock. Pin the process timezone exactly like the CP1 harness, so
// `clockLocal` names one instant on every host.
process.env.TZ = "UTC";

/**
 * CP3b2c parse contract: `parse_file → Todo.fromParts → serialize` against the
 * TypeScript reader.
 *
 * The oracle is the production reader:
 *
 * ```ts
 * validateTodoFileContent(data, limits).filter((line) => line.trim()).map((line) => new Todo(line))
 * ```
 *
 * The candidate is either
 *
 * - `self` — the oracle's own `Todo` objects projected back to parse records
 *   (`coreTodoRecord` plus the derived getters and the load id), normalized by
 *   the production `parseRecordToTodoParts` and rebuilt with `Todo.fromParts`.
 *   This proves the factory is lossless for every parseable line, and is the
 *   half that runs in the Node CI job; or
 * - `wasm` — `parseTodosWithCore`, the wired `THAR_CORE=rust` read path. A
 *   fallback to TypeScript is a harness error, not a pass: the contract must
 *   prove the Rust path ran.
 *
 * Both sides emit one JSONL record per fixture, in the CP1 fixture order:
 *
 * ```json
 * {
 *   "fixture": "tags.txt",
 *   "sha256": "…",
 *   "kind": "todos",
 *   "clockLocal": "2026-11-15T12:00:00",
 *   "readLimits": { "maxFileBytes": 1048576, … },
 *   "todoCount": 12,
 *   "serialized": { "sha256": "…", "bytes": 491 },
 *   "todos": [
 *     {
 *       "text": "ship it +thar",
 *       "state": "todo",
 *       "priority": "A",
 *       "completionDate": null,
 *       "creationDate": "2024-03-01",
 *       "projects": ["thar"],
 *       "contexts": [],
 *       "tags": [["beta", ["one", "two"]]],
 *       "datesInText": false,
 *       "completionDateInText": false,
 *       "isDone": false,
 *       "isHidden": false,
 *       "isVisibleInOverview": true,
 *       "isOverdue": false,
 *       "toString": "…",
 *       "hash": "…"
 *     }
 *   ]
 * }
 * ```
 *
 * Rejection fixtures are compared too: `kind: "error"` carries the same
 * name/code/numeric-fields/message record CP1 pins, which is the read path's
 * error-parity proof.
 *
 * Seeded mutations edit the candidate's parts (never `logic/**`): drop a tag,
 * swap the two date slots, lose the round-trip flags, or reverse the records.
 * The self-check requires the comparator to see each one.
 */

/** One reconstructed todo, in the contract's fixed key order. */
export interface ParseContractTodo {
  text: string;
  state: "todo" | "done";
  priority: string | null;
  completionDate: string | null;
  creationDate: string | null;
  projects: string[];
  contexts: string[];
  tags: [string, string | string[]][];
  datesInText: boolean;
  completionDateInText: boolean;
  isDone: boolean;
  isHidden: boolean;
  isVisibleInOverview: boolean;
  isOverdue: boolean;
  toString: string;
  hash: string;
}

export interface ParseTodosRecord {
  fixture: string;
  sha256: string;
  kind: "todos";
  clockLocal: string;
  readLimits: ContractReadLimits;
  todoCount: number;
  serialized: { sha256: string; bytes: number };
  todos: ParseContractTodo[];
}

export interface ParseErrorRecord {
  fixture: string;
  sha256: string;
  kind: "error";
  clockLocal: string;
  readLimits: ContractReadLimits;
  error: ContractError;
}

export type ParseContractRecord = ParseTodosRecord | ParseErrorRecord;

/** Which implementation produces the record set. */
export type ParseCandidate = "oracle" | "self" | "wasm";

/** Seeded reconstruction bugs the self-check must detect. */
export type ParseMutationName =
  | "drop-last-tag"
  | "swap-dates"
  | "lose-round-trip-flags"
  | "reverse-records";

export const PARSE_MUTATION_NAMES: readonly ParseMutationName[] = [
  "drop-last-tag",
  "swap-dates",
  "lose-round-trip-flags",
  "reverse-records",
];

export const PARSE_MUTATIONS: Record<ParseMutationName, string> = {
  "drop-last-tag":
    "drops the last tag of every todo (a reconstruction that loses a tag " +
    "instead of rebuilding it)",
  "swap-dates":
    "swaps the completion and creation dates (a reconstruction with the two " +
    "`x DATE DATE` slots exchanged)",
  "lose-round-trip-flags":
    "resets both round-trip flags to false (a reconstruction that re-parses " +
    "the line and cannot recover them)",
  "reverse-records":
    "returns the parsed records in reverse order (a parse adapter that loses " +
    "file order)",
};

export const isParseMutationName = (
  value: string,
): value is ParseMutationName =>
  (PARSE_MUTATION_NAMES as readonly string[]).includes(value);

/** A parse-contract build problem the CLI reports as one bounded line. */
export class ParseHarnessError extends Error {}

const toContractReadLimits = (limits: ReadLimits): ContractReadLimits => ({
  maxFileBytes: limits.maxFileBytes,
  maxReadTodos: limits.maxReadTodos,
  maxLineChars: limits.maxLineChars,
});

/** The production TypeScript reader. */
const parseTodoText = (text: string, limits: ReadLimits): Todo[] =>
  validateTodoFileContent(text, limits)
    .filter((line) => line.trim())
    .map((line) => new Todo(line));

/**
 * One `Todo` as the parse record the Rust core emits.
 *
 * `coreTodoRecord` is the adapter's own projection, so the self candidate
 * cannot quietly derive the flags or tags differently from the app.
 */
export const recordFromTodo = (
  todo: Todo,
  id: number,
): CoreParseTodoRecord => ({
  ...coreTodoRecord(todo),
  isDone: todo.isDone(),
  isHidden: todo.isHidden(),
  isVisibleInOverview: todo.isVisibleInOverview(),
  isOverdue: todo.isOverdue(),
  toString: todo.toString(),
  hash: todo.getHash(),
  id,
});

/** The contract view of one todo. */
const contractTodo = (todo: Todo, id: number): ParseContractTodo => {
  const record = recordFromTodo(todo, id);
  return {
    text: record.text,
    state: record.state,
    priority: record.priority,
    completionDate: record.completionDate,
    creationDate: record.creationDate,
    projects: [...record.projects],
    contexts: [...record.contexts],
    tags: record.tags.map(
      ([key, value]) => [key, value] as [string, string | string[]],
    ),
    datesInText: record.datesInText,
    completionDateInText: record.completionDateInText,
    isDone: record.isDone,
    isHidden: record.isHidden,
    isVisibleInOverview: record.isVisibleInOverview,
    isOverdue: record.isOverdue,
    toString: record.toString,
    hash: record.hash,
  };
};

/** Apply one seeded bug to a todo's parts. */
const mutateParts = (
  parts: TodoParts,
  mutation: ParseMutationName | undefined,
): TodoParts => {
  switch (mutation) {
    case "drop-last-tag": {
      const entries = Object.entries(parts.tags);
      if (entries.length === 0) return parts;
      return {
        ...parts,
        tags: Object.fromEntries(entries.slice(0, -1)),
      };
    }
    case "swap-dates":
      return {
        ...parts,
        completionDate: parts.creationDate,
        creationDate: parts.completionDate,
      };
    case "lose-round-trip-flags":
      return {
        ...parts,
        datesInText: false,
        completionDateInText: false,
      };
    default:
      return parts;
  }
};

/**
 * The self candidate: project every oracle todo back to a record, run the
 * production normalizer, rebuild it with `Todo.fromParts`, then apply an
 * optional seeded bug.
 */
const rebuildTodos = (
  todos: readonly Todo[],
  mutation?: ParseMutationName,
): Todo[] => {
  const rebuilt = todos.map((todo, id) => {
    const parts = parseRecordToTodoParts(recordFromTodo(todo, id));
    if (!parts) {
      throw new ParseHarnessError(
        `the adapter rejected its own record for todo ${id}`,
      );
    }
    return Todo.fromParts(mutateParts(parts, mutation));
  });
  return mutation === "reverse-records" ? rebuilt.reverse() : rebuilt;
};

/** `THAR_CORE=rust` for the duration of the WASM candidate build. */
const withRustMode = <T>(build: () => T): T => {
  const previous = process.env.THAR_CORE;
  process.env.THAR_CORE = "rust";
  try {
    return build();
  } finally {
    if (previous === undefined) delete process.env.THAR_CORE;
    else process.env.THAR_CORE = previous;
  }
};

/** The wired Rust read path, or a harness error when it fell back. */
const rustTodos = (
  text: string,
  today: string,
  limits: ReadLimits,
  fixture: string,
): Todo[] => {
  const todos = parseTodosWithCore(text, today, limits);
  if (!todos) {
    throw new ParseHarnessError(
      `the Rust parse fell back to TypeScript for ${fixture}`,
    );
  }
  return todos;
};

const jsonlOf = (records: readonly ParseContractRecord[]): string =>
  records.map((record) => JSON.stringify(record)).join("\n") +
  (records.length > 0 ? "\n" : "");

export interface ParseBuildOptions {
  corpusDir?: string;
  clockLocal?: string;
  /**
   * Which side to build: `oracle` is the TypeScript reader, `self` rebuilds
   * the oracle's todos through the factory, `wasm` is the wired Rust path.
   */
  candidate?: ParseCandidate;
  /** TEST ONLY: a seeded reconstruction bug, applied to the candidate. */
  mutation?: ParseMutationName;
}

export interface ParseContractBuild {
  corpusDir: string;
  clockLocal: string;
  readLimits: ReadLimits;
  candidate: ParseCandidate;
  records: ParseContractRecord[];
  /** Compact JSONL with a final LF. Empty corpus -> empty string. */
  jsonl: string;
}

/**
 * Build the parse contract over every corpus fixture.
 *
 * Rejection fixtures become `kind: "error"` records for both sides. A
 * validation error from the candidate is expected and compared; any other
 * candidate error is a harness error, because it means the path fell back or
 * threw outside the reader contract.
 */
export const buildParseContract = (
  options: ParseBuildOptions = {},
): ParseContractBuild => {
  const corpusDir = resolve(options.corpusDir ?? DEFAULT_CORPUS_DIR);
  const clockLocal = options.clockLocal ?? DEFAULT_CLOCK_LOCAL;
  const candidate = options.candidate ?? "oracle";
  const today = clockLocal.slice(0, 10);
  pinClock(clockLocal);

  const limits = getReadLimits();
  const readLimits = toContractReadLimits(limits);
  const records: ParseContractRecord[] = [];

  const build = (): void => {
    for (const fixture of listFixtures(corpusDir)) {
      const path = join(corpusDir, fixture);
      let raw: Buffer;
      try {
        raw = readFileSync(path);
      } catch (error) {
        throw new CorpusError(
          path,
          `cannot read fixture ${fixture}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      const sha256 = sha256Hex(raw);
      // `Buffer#toString` decodes lossily, exactly like the production reader.
      const text = raw.toString("utf8");

      try {
        // Mirror `readTodosFromFile`'s post-read byte re-check before parsing.
        const actualBytes = Buffer.byteLength(text, "utf8");
        if (actualBytes > limits.maxFileBytes) {
          throw new TodoFileTooLargeError(actualBytes, limits.maxFileBytes);
        }

        const parsed =
          candidate === "wasm"
            ? rustTodos(text, today, limits, fixture)
            : parseTodoText(text, limits);
        const todos =
          candidate === "self"
            ? rebuildTodos(parsed, options.mutation)
            : parsed;
        const serialized = serializeTodosForWrite(todos);
        records.push({
          fixture,
          sha256,
          kind: "todos",
          clockLocal,
          readLimits,
          todoCount: todos.length,
          serialized: {
            sha256: sha256Hex(serialized),
            bytes: Buffer.byteLength(serialized, "utf8"),
          },
          todos: todos.map((todo, id) => contractTodo(todo, id)),
        });
      } catch (error) {
        // The reader's own rejection is the contract. Anything else (a
        // fallback, a thrown adapter error) must fail the harness instead of
        // being recorded as if it were a legitimate rejection.
        if (!(error instanceof TodoFileValidationError)) throw error;
        records.push({
          fixture,
          sha256,
          kind: "error",
          clockLocal,
          readLimits,
          error: contractError(error),
        });
      }
    }
  };

  if (candidate === "wasm") withRustMode(build);
  else build();

  return {
    corpusDir,
    clockLocal,
    readLimits: limits,
    candidate,
    records,
    jsonl: jsonlOf(records),
  };
};
