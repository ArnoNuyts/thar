import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  getReadLimits,
  type ReadLimits,
  TodoFileTooLargeError,
} from "../../logic/limits.ts";
import { type MutationName, createAdapter } from "./adapter.ts";
import { pinClock } from "./clock.ts";
import type {
  ContractError,
  ContractReadLimits,
  ContractRecord,
  ContractTodosRecord,
} from "./types.ts";

export const DEFAULT_CLOCK_LOCAL = "2026-11-15T12:00:00";

const MODULE_DIR = resolve(fileURLToPath(import.meta.url), "..");
export const REPO_ROOT = resolve(MODULE_DIR, "../..");
export const DEFAULT_CORPUS_DIR = join(REPO_ROOT, "testdata", "port");

export const sha256Hex = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

/** Bytewise (UTF-8) filename order, independent of the host locale. */
export const compareFixtureNames = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

export const listFixtures = (corpusDir: string): string[] =>
  readdirSync(corpusDir)
    .filter((name) => name.endsWith(".txt"))
    .sort(compareFixtureNames);

export interface BuildOptions {
  corpusDir?: string;
  clockLocal?: string;
  mutation?: MutationName;
}

export interface ContractBuild {
  corpusDir: string;
  clockLocal: string;
  readLimits: ReadLimits;
  records: ContractRecord[];
  /** Compact JSONL with a final LF. Empty corpus -> empty string. */
  jsonl: string;
}

const toContractReadLimits = (limits: ReadLimits): ContractReadLimits => ({
  maxFileBytes: limits.maxFileBytes,
  maxReadTodos: limits.maxReadTodos,
  maxLineChars: limits.maxLineChars,
});

const NUMERIC_ERROR_FIELDS = [
  "lineNumber",
  "length",
  "maxLineChars",
  "lineCount",
  "maxReadTodos",
  "actualBytes",
  "maxBytes",
  "codePoint",
] as const;

/**
 * Build the rejection record for one fixture. Numeric fields are copied in a
 * fixed order and omitted when absent; `message` always comes last.
 */
const contractError = (error: Error): ContractError => {
  const source = error as Error & Record<string, unknown>;
  const numeric: Partial<ContractError> = {};
  for (const field of NUMERIC_ERROR_FIELDS) {
    const value = source[field];
    if (typeof value === "number") numeric[field] = value;
  }
  return {
    name: error.name,
    code: typeof source.code === "string" ? source.code : "",
    ...numeric,
    message: error.message,
  };
};

/**
 * Build the deterministic contract over every `*.txt` fixture in `corpusDir`.
 *
 * The fixtures are loaded through the production parse path and serialized
 * through the production write path (see `adapter.ts`). The clock is pinned on
 * the first call; later calls reuse the same pinned instant.
 */
export const buildContract = (options: BuildOptions = {}): ContractBuild => {
  const corpusDir = resolve(options.corpusDir ?? DEFAULT_CORPUS_DIR);
  const clockLocal = options.clockLocal ?? DEFAULT_CLOCK_LOCAL;
  pinClock(clockLocal);

  const limits = getReadLimits();
  const readLimits = toContractReadLimits(limits);
  const adapter = createAdapter(options.mutation);
  const records: ContractRecord[] = [];

  for (const fixture of listFixtures(corpusDir)) {
    const raw = readFileSync(join(corpusDir, fixture));
    const sha256 = sha256Hex(raw);

    try {
      // Mirror the reader's size guard before parsing (CP0 pins > 1 MiB as a
      // rejection; committed fixtures are far below it).
      const actualBytes = Buffer.byteLength(raw.toString("utf8"), "utf8");
      if (actualBytes > limits.maxFileBytes) {
        throw new TodoFileTooLargeError(actualBytes, limits.maxFileBytes);
      }

      const todos = adapter.parse(raw);
      const serialized = adapter.serialize(todos);
      const record: ContractTodosRecord = {
        fixture,
        sha256,
        kind: "todos",
        readLimits,
        clockLocal,
        todoCount: todos.length,
        serialized: {
          sha256: sha256Hex(serialized),
          bytes: Buffer.byteLength(serialized, "utf8"),
        },
        todos: todos.map((todo) => adapter.record(todo)),
      };
      records.push(record);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      records.push({
        fixture,
        sha256,
        kind: "error",
        readLimits,
        clockLocal,
        error: contractError(error),
      });
    }
  }

  return {
    corpusDir,
    clockLocal,
    readLimits: limits,
    records,
    jsonl:
      records.map((record) => JSON.stringify(record)).join("\n") +
      (records.length > 0 ? "\n" : ""),
  };
};
