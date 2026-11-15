import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
const MODULE_ROOT = resolve(MODULE_DIR, "../..");

/**
 * Repository root. From the TypeScript source (`tools/port/`) this is the
 * checkout above it. A bundled copy (the self-test's plain-Node bundle) lives
 * in a temp directory, so fall back to the working directory — the harness
 * contract is "run from the repository root" either way.
 */
export const REPO_ROOT = existsSync(join(MODULE_ROOT, "package.json"))
  ? MODULE_ROOT
  : process.cwd();
export const DEFAULT_CORPUS_DIR = join(REPO_ROOT, "testdata", "port");

export const sha256Hex = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

/** A corpus that cannot be listed or a fixture that cannot be read. */
export class CorpusError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.name = "CorpusError";
    this.path = path;
  }
}

const describeFsError = (error: unknown): string => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case "ENOENT":
      return "no such file or directory";
    case "EACCES":
    case "EPERM":
      return "permission denied";
    case "EISDIR":
      return "is a directory";
    case "ENOTDIR":
      return "not a directory";
    default: {
      const message =
        error instanceof Error
          ? error.message
          : String(error ?? "unknown error");
      return message.length > 200 ? `${message.slice(0, 200)}…` : message;
    }
  }
};

/** Bytewise (UTF-8) filename order, independent of the host locale. */
export const compareFixtureNames = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

/** Every `*.txt` fixture in `corpusDir`, bytewise by name. */
export const listFixtures = (corpusDir: string): string[] => {
  let names: string[];
  try {
    names = readdirSync(corpusDir);
  } catch (error) {
    throw new CorpusError(
      corpusDir,
      `cannot read the corpus directory ${corpusDir}: ${describeFsError(error)}`,
    );
  }
  return names
    .filter((name) => name.endsWith(".txt"))
    .sort(compareFixtureNames);
};

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
    const path = join(corpusDir, fixture);
    let raw: Buffer;
    try {
      raw = readFileSync(path);
    } catch (error) {
      throw new CorpusError(
        path,
        `cannot read fixture ${path}: ${describeFsError(error)}`,
      );
    }
    const sha256 = sha256Hex(raw);

    try {
      // Mirror `readTodosFromFile`'s post-read byte re-check before parsing
      // (CP0 pins > 1 MiB as a rejection; committed fixtures are far below
      // it). The write path's own size guard is not exercised here — see
      // "Coverage limits" in `tools/port/README.md`.
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
