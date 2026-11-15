import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { findUnsafeTodoTextCodePoint } from "../../logic/control-characters.ts";
import { coreTodoRecord, type CoreRowTodo } from "../../logic/core-wasm.ts";
import {
  getReadLimits,
  type ReadLimits,
  TodoControlCharacterError,
  TodoFileValidationError,
} from "../../logic/limits.ts";
import { Todo } from "../../logic/todo.ts";
import { serializeTodosForWrite } from "../../logic/todo-file-helpers.ts";
import { validateTodoFileContent } from "../../logic/todo-file-validation.ts";
import {
  CorpusError,
  DEFAULT_CORPUS_DIR,
  compareFixtureNames,
  listFixtures,
  sha256Hex,
} from "./build.ts";

/**
 * CP4 write contract: the TypeScript writer against `thar-wasm`'s
 * `serialize_file`.
 *
 * The oracle is the production write path:
 *
 * ```ts
 * serializeTodosForWrite(todos); // writeTodosToFile's serializer + guard
 * ```
 *
 * The candidate receives the **same structured records** the app's adapter
 * sends (`coreTodoRecord`) as `{"todos":[…]}` and answers with the envelope. That
 * is the boundary CP4's dual write uses, so the contract pins exactly the bytes
 * the file would receive, not a re-parse of the line.
 *
 * The corpus alone cannot reach the write-time guard (every parseable fixture is
 * safe to serialize), so two synthetic probes are part of the contract: a
 * control character on line 2 (with a later one beside it) and one on line 1.
 * Both sides must reject with the same 1-based line and code point, which pins
 * the ordering rule. A third probe keeps a tab allowed.
 *
 * ```json
 * {"fixture":"tags.txt","kind":"todos","todoCount":12,
 *  "serialized":{"sha256":"…","bytes":491}}
 * {"fixture":"guard-nul","kind":"rejected","lineNumber":2,"codePoint":0}
 * ```
 *
 * `kind: "rejected"` is the first line the writer refuses, with the first
 * offending code point on it. The TypeScript error calls it `lineNumber`, the
 * Rust envelope calls it `index`; the candidate maps it, so both sides emit the
 * same record.
 *
 * Determinism: records are ordered by fixture name (bytewise) followed by the
 * probe names, both sides emit the same fixed key order, and nothing here reads
 * the clock (serialization never does).
 */

/** One entry of the candidate manifest: the records for one fixture. */
export interface WriteManifestEntry {
  fixture: string;
  todos: CoreRowTodo[];
}

/**
 * The candidate's input. The records are built by the oracle from its real
 * `Todo` objects, so the candidate cannot re-derive them differently.
 */
export interface WriteManifest {
  entries: WriteManifestEntry[];
}

/** One serialized fixture, or the guard's rejection. */
export type WriteContractRecord =
  | {
      fixture: string;
      kind: "todos";
      todoCount: number;
      serialized: { sha256: string; bytes: number };
    }
  | {
      fixture: string;
      kind: "rejected";
      lineNumber: number;
      codePoint: number;
    };

/** Seeded writer bugs the self-check must detect. */
export type WriteMutationName =
  | "drop-trailing-newline"
  | "swap-date-order"
  | "drop-last-tag";

export const WRITE_MUTATION_NAMES: readonly WriteMutationName[] = [
  "drop-trailing-newline",
  "swap-date-order",
  "drop-last-tag",
];

export interface WriteMutationDescription {
  /** What a writer with this bug would do. */
  description: string;
  /** Readable text transformation applied to the oracle's serialized bytes. */
  apply: (text: string) => string;
}

/**
 * The mutations edit the oracle's own serialized bytes, never `logic/**`.
 *
 * Each one simulates a specific serialization bug, so the proof is that the
 * comparator notices a *changed file*, not that a second serializer agrees with
 * itself.
 */
export const WRITE_MUTATIONS: Record<
  WriteMutationName,
  WriteMutationDescription
> = {
  "drop-trailing-newline": {
    description:
      "writes the file without its final newline (a serializer that forgets " +
      '`+ "\\n"`)',
    apply: (text) => (text.endsWith("\n") ? text.slice(0, -1) : text),
  },
  "swap-date-order": {
    description:
      "writes a completed line's creation date before its completion date (a " +
      "serializer with the two `x DATE DATE` slots swapped)",
    apply: (text) =>
      text
        .split("\n")
        .map((line) =>
          line.replace(
            /^x (\d{4}-\d{2}-\d{2}) (\d{4}-\d{2}-\d{2}) /,
            "x $2 $1 ",
          ),
        )
        .join("\n"),
  },
  "drop-last-tag": {
    description:
      "drops the last tag of every line that has one (a serializer that loses " +
      "a tag instead of writing it at the end)",
    apply: (text) =>
      text
        .split("\n")
        .map((line) => line.replace(/ [^ \t]+:[^ \t]+$/, ""))
        .join("\n"),
  },
};

export const isWriteMutationName = (
  value: string,
): value is WriteMutationName =>
  (WRITE_MUTATION_NAMES as readonly string[]).includes(value);

/** A write-contract build problem the CLI reports as one bounded line. */
export class WriteHarnessError extends Error {}

/** One synthetic probe the guard must judge in a known way. */
interface GuardProbe {
  fixture: string;
  /** What the TypeScript writer must do with this list. */
  outcome: "rejected" | "todos";
  todos: Todo[];
}

/**
 * Guard probes: `serializeTodosForWrite` rejects the first two lists and accepts
 * the third.
 *
 * `guard-nul` puts the control character on line 2 with a second, less
 * interesting one beside it, so a port that reports the last code point, the
 * wrong line, or the whole-file first byte fails. `guard-esc` covers line 1 and
 * U+001B. `guard-tab` is the allow case: a tab is a delimiter and must pass.
 */
const GUARD_PROBES: readonly GuardProbe[] = [
  {
    fixture: "guard-nul",
    outcome: "rejected",
    todos: [new Todo("first line is safe"), new Todo("nul\u0000 and\u0001")],
  },
  {
    fixture: "guard-esc",
    outcome: "rejected",
    todos: [new Todo("\u001b[31mred")],
  },
  {
    fixture: "guard-tab",
    outcome: "todos",
    todos: [new Todo("tab\there")],
  },
];

/** The synthetic probe fixtures, in contract order. */
export const GUARD_PROBE_FIXTURES: readonly string[] = GUARD_PROBES.map(
  (probe) => probe.fixture,
);

/** The probes the writer must refuse, in contract order. */
export const REJECTED_GUARD_PROBE_FIXTURES: readonly string[] =
  GUARD_PROBES.filter((probe) => probe.outcome === "rejected").map(
    (probe) => probe.fixture,
  );

/** The production parse path: validate, drop blank lines, parse. */
const parseTodoText = (text: string, limits: ReadLimits): Todo[] =>
  validateTodoFileContent(text, limits)
    .filter((line) => line.trim())
    .map((line) => new Todo(line));

/**
 * Render one structured record exactly as `Todo::serialize` does.
 *
 * Only the self-candidate needs this: the real candidate is Rust, and the
 * oracle runs the production serializer over its own `Todo` objects. It is
 * deliberately not a second parser — no dates are computed and no text is
 * scanned, only the documented prefix/tag order — so it cannot hide a
 * serializer bug behind shared logic. If the records were lossy (the DTO could
 * not rebuild the line), the self-candidate would diff here.
 */
export const recordToString = (record: CoreRowTodo): string => {
  let line = "";
  if (record.state === "done") line += "x ";
  if (record.priority !== null) line += `(${record.priority}) `;
  if (!record.completionDateInText && record.completionDate !== null) {
    line += `${record.completionDate} `;
  }
  if (!record.datesInText && record.creationDate !== null) {
    line += `${record.creationDate} `;
  }
  line += record.text;
  if (record.tags.length > 0) {
    line +=
      " " +
      record.tags
        .map(
          ([key, value]) =>
            `${key}:${Array.isArray(value) ? value.join(",") : value}`,
        )
        .join(" ");
  }
  return line;
};

/** The guard result for one rendered record, in the writer's order. */
const unsafeCodePointOf = (
  records: readonly CoreRowTodo[],
): { lineNumber: number; codePoint: number } | undefined => {
  for (let index = 0; index < records.length; index++) {
    const codePoint = findUnsafeTodoTextCodePoint(
      recordToString(records[index]),
    );
    if (codePoint !== undefined) return { lineNumber: index + 1, codePoint };
  }
  return undefined;
};

/**
 * Build the contract records for one manifest entry.
 *
 * Shared by the self-candidate and the unit tests: it is the candidate side of
 * the contract expressed in TypeScript, with the production guard helper.
 */
export const serializeManifestEntry = (
  entry: WriteManifestEntry,
): WriteContractRecord => {
  const unsafe = unsafeCodePointOf(entry.todos);
  if (unsafe !== undefined) {
    return {
      fixture: entry.fixture,
      kind: "rejected",
      lineNumber: unsafe.lineNumber,
      codePoint: unsafe.codePoint,
    };
  }
  const text = `${entry.todos.map(recordToString).join("\n")}\n`;
  return {
    fixture: entry.fixture,
    kind: "todos",
    todoCount: entry.todos.length,
    serialized: {
      sha256: sha256Hex(text),
      bytes: Buffer.byteLength(text, "utf8"),
    },
  };
};

/** Build the candidate contract from a manifest, in manifest order. */
export const buildCandidateContract = (
  manifest: WriteManifest,
): WriteContractRecord[] => manifest.entries.map(serializeManifestEntry);

/** The oracle record for one real todo list. */
const oracleRecord = (
  fixture: string,
  todos: Todo[],
  mutation?: WriteMutationName,
): WriteContractRecord => {
  let text: string;
  try {
    text = serializeTodosForWrite(todos);
  } catch (error) {
    if (!(error instanceof TodoControlCharacterError)) throw error;
    return {
      fixture,
      kind: "rejected",
      lineNumber: error.lineNumber,
      codePoint: error.codePoint,
    };
  }

  const written =
    mutation === undefined ? text : WRITE_MUTATIONS[mutation].apply(text);
  return {
    fixture,
    kind: "todos",
    todoCount: todos.length,
    serialized: {
      sha256: sha256Hex(written),
      bytes: Buffer.byteLength(written, "utf8"),
    },
  };
};

const jsonlOf = (records: readonly WriteContractRecord[]): string =>
  records.map((record) => JSON.stringify(record)).join("\n") +
  (records.length > 0 ? "\n" : "");

export interface WriteContractBuild {
  corpusDir: string;
  /** Every contract record, in fixture order. */
  records: WriteContractRecord[];
  /** Fixture names the contract covers, including the guard probes. */
  fixtures: string[];
  /**
   * Fixtures skipped because the production reader rejected them (the CP1
   * `kind: "error"` records). Never any other failure.
   */
  skipped: string[];
  /** The candidate's input. */
  manifest: WriteManifest;
  /** Compact JSONL with a final LF. */
  jsonl: string;
}

/**
 * Build the whole write contract from the corpus.
 *
 * `manifest` lets the oracle reproduce exactly what a candidate was told to
 * serialize (used only by tests that re-check a recorded manifest); in oracle
 * mode it is created from the corpus and the guard probes.
 */
export const buildWriteContract = (
  options: {
    corpusDir?: string;
    mutation?: WriteMutationName;
    manifest?: WriteManifest;
  } = {},
): WriteContractBuild => {
  const corpusDir = resolve(options.corpusDir ?? DEFAULT_CORPUS_DIR);
  const limits = getReadLimits();
  const skipped: string[] = [];
  const sources: { fixture: string; todos: Todo[] }[] = [];

  if (options.manifest === undefined) {
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
      } catch (error) {
        // Rejection fixtures are owned by the CP1 contract and
        // `corpus_parity.rs`; only the validation family may be skipped, so
        // coverage cannot shrink silently.
        if (!(error instanceof TodoFileValidationError)) throw error;
        skipped.push(fixture);
        continue;
      }

      sources.push({ fixture, todos });
    }

    for (const probe of GUARD_PROBES) {
      sources.push({ fixture: probe.fixture, todos: probe.todos });
    }

    // `listFixtures` is bytewise-sorted; keep the probes in the same order.
    sources.sort((left, right) =>
      compareFixtureNames(left.fixture, right.fixture),
    );
  }

  const manifest: WriteManifest = {
    entries:
      options.manifest?.entries ??
      sources.map(({ fixture, todos }) => ({
        fixture,
        todos: todos.map(coreTodoRecord),
      })),
  };

  // In manifest mode the oracle runs the self-candidate over the supplied
  // records: that is how `--candidate-self` replays a real candidate's input.
  const records =
    options.manifest === undefined
      ? sources.map(({ fixture, todos }) =>
          oracleRecord(fixture, todos, options.mutation),
        )
      : buildCandidateContract(manifest);

  return {
    corpusDir,
    records,
    fixtures: manifest.entries.map((entry) => entry.fixture),
    skipped,
    manifest,
    jsonl: jsonlOf(records),
  };
};
