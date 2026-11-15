import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startOfDay } from "date-fns";

import { IndexType, TodoStateEnum } from "../types/enums.ts";
import type { UpperCaseLetter } from "../types/types.ts";
import {
  isEnglishCollator,
  defaultCollatorLocale,
} from "../utils/collation-locale.ts";
import { extractSearchTerms } from "../utils/search-utils.ts";
import { formatDateTag, parseDateTag } from "./dates.ts";
import { createIndexes } from "./indexes.ts";
import type { IndexEntry } from "./indexes.ts";
import {
  type ReadLimits,
  TodoControlCharacterError,
  TodoFileValidationError,
  TodoFileTooLargeError,
  TodoLineCountLimitError,
  TodoLineLengthLimitError,
} from "./limits.ts";
import { CONTEXT_REGEX, PROJECT_REGEX } from "./patterns.ts";
import { filterBySearch, filterHidden, sortByImportance } from "./Todos.ts";
import type { Todos } from "./Todos.ts";
import { Todo, type TodoParts } from "./todo.ts";

/**
 * Bridge to the Rust core compiled to WebAssembly.
 *
 * Since CP5 the Rust core is the **default** for every wired path: parse
 * (`readTodosFromFile`), rows (`useNavigationState`) and the byte-compared
 * write (`writeTodosToFile`). `THAR_CORE=ts` is the documented escape hatch for
 * one release and behaves exactly as the app did before the port: it loads no
 * package at all. The module offers four entry points:
 *
 * - {@link parseFileWithCore}, a thin batch adapter over `thar-wasm`'s
 *   `parseFile`/`parseFileWithLimits`;
 * - {@link parseTodosWithCore}, the wired read path: one Rust parse, validated
 *   into {@link Todo} instances through `Todo.fromParts`, with the TypeScript
 *   reader as the fallback;
 * - {@link buildRowsWithCore}, the wired row builder that calls the merged
 *   `buildRows` export and maps its rows back to `IndexEntry`;
 * - {@link serializeTodosWithCore}, the whole-file serializer the write path
 *   byte-compares against the TypeScript oracle before saving.
 *
 * All four are defensive: a missing, unbuildable or broken package, a malformed
 * envelope, an absent export, a rejected `today`, and a host collation locale
 * the Rust sort does not implement all resolve to `undefined` plus at most one
 * bounded, content-free debug log. The one deliberate exception is a proven
 * read rejection: {@link parseTodosWithCore} throws the same
 * `TodoFileValidationError` the TypeScript reader would have thrown, so invalid
 * files keep their exact user error. Nothing else may throw into the TUI, and
 * nothing here writes to the todo file. Debug lines never include the parse
 * input: a todo line is its own `hash`, so a Node `JSON.parse` snippet would
 * leak content. For the same reason a row-builder or serializer failure logs
 * only the error class or the typed error code, never the todo list or the
 * request body.
 *
 * The package is loaded with `createRequire` and a module-relative runtime
 * path, never with a static `import`. In a source checkout that path is
 * `crates/thar-wasm/pkg/` (gitignored, built by `npm run build:wasm`); in the
 * published package it is the same path inside the tarball (`files` ships
 * `crates/thar-wasm/pkg/**` next to `dist/main.js`). `npm run build`, `npm test`
 * and `npm run check` still work without Rust: the adapter falls back to the
 * TypeScript core and logs one line.
 *
 * The runtime `THAR_SHADOW=1` differential check was removed at CP5. The
 * durable oracle is the offline harness in `tools/port/` (`port:contract*`),
 * which runs in CI and never touches a user's process.
 *
 * See `docs/rust-port/PLAN.md` §5 (CP5) and §9.1.
 */

/** Which implementation the wired paths should use. `rust` is the default. */
export type CoreMode = "ts" | "rust";

/**
 * One record of the Rust `parseFile` envelope.
 *
 * Field names and order are the CP1 contract (`tools/port/types.ts`), which is
 * also what `testdata/port/expected.json` pins.
 */
export interface CoreTodoRecord {
  text: string;
  state: "todo" | "done";
  priority: string | null;
  completionDate: string | null;
  creationDate: string | null;
  projects: string[];
  contexts: string[];
  tags: [string, string | string[]][];
  isDone: boolean;
  isHidden: boolean;
  isVisibleInOverview: boolean;
  isOverdue: boolean;
  toString: string;
  hash: string;
  /**
   * Round-trip flag, CP3b2c. Optional on the type so the adapter still accepts
   * a package built before the parse-path fields existed; the read path
   * requires it and falls back to TypeScript when it is absent.
   */
  datesInText?: boolean;
  /** Round-trip flag, CP3b2c. See {@link datesInText}. */
  completionDateInText?: boolean;
  /** 0-based load-order id, CP3b2c. See {@link datesInText}. */
  id?: number;
}

/**
 * One parsed record the read path can rebuild a `Todo` from.
 *
 * The CP1 record plus exactly the three fields that cannot be recovered from
 * the serialized line. A package without them (older build) is treated as
 * unavailable and the TypeScript reader runs instead.
 */
export type CoreParseTodoRecord = CoreTodoRecord & {
  datesInText: boolean;
  completionDateInText: boolean;
  id: number;
};

/**
 * The rejection object of the Rust parse envelope.
 *
 * Only `name`, `code` and `message` are always present; the numeric fields
 * belong to the error variant, in the CP1 order (see
 * `crates/thar-wasm/src/lib.rs`). The read path maps a code back to the
 * TypeScript error class and confirms the numbers by regenerating its message,
 * so a stale or truncated rejection falls back to the TypeScript validator.
 */
export interface CoreParseError {
  name: string;
  code: string;
  message: string;
  lineNumber?: number;
  length?: number;
  maxLineChars?: number;
  lineCount?: number;
  maxReadTodos?: number;
  actualBytes?: number;
  maxBytes?: number;
  codePoint?: number;
}

/** Successful or rejected envelope from the Rust parse. */
export type CoreParseResult =
  | { ok: true; todos: CoreTodoRecord[] }
  | { ok: false; error: CoreParseError };

/** The subset of the wasm-bindgen package this module uses. */
interface CoreModule {
  coreVersion(): string;
  parseFile(text: string, today: string): string;
  /**
   * The generated `.d.ts` names these arguments `max_file_bytes`,
   * `max_read_todos` and `max_line_chars`; calls are positional, so the
   * camelCase names here are descriptive only.
   */
  parseFileWithLimits(
    text: string,
    today: string,
    maxFileBytes: number,
    maxReadTodos: number,
    maxLineChars: number,
  ): string;
  /**
   * CP3b1's coarse row builder: one JSON document in, one JSON envelope out.
   *
   * Optional because a partially built package can lack the export. The
   * wasm-bindgen name is `buildRows` (`#[wasm_bindgen(js_name = buildRows)]`),
   * which is what the merged crate exports.
   */
  buildRows?(input: string): string;
  /**
   * CP4's whole-file serializer: one JSON document in, one JSON envelope out.
   *
   * Optional because a partially built package can lack the export. The
   * wasm-bindgen name is `serializeFile`
   * (`#[wasm_bindgen(js_name = serializeFile)]`).
   */
  serializeFile?(input: string): string;
}

const PACKAGE_ENTRY = join("crates", "thar-wasm", "pkg", "thar_wasm.js");
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Explicit package entry (`THAR_CORE_WASM`), or the one checkout-relative
 * location that resolves from `logic/` in a dev run and from `dist/` after
 * `vite build`.
 *
 * `process.cwd()` is deliberately not a candidate. The TUI may be started from
 * any directory, and a `crates/thar-wasm/pkg` there belongs to whoever owns
 * that directory — loading it would run foreign code in this process.
 * `THAR_CORE_WASM` is the dev-only escape hatch for pointing the bridge at
 * another build; it goes through `resolve`, so a relative value is relative to
 * `process.cwd()`.
 */
const packageCandidates = (): string[] => {
  const override = process.env.THAR_CORE_WASM;
  if (override) return [resolve(override)];
  return [join(resolve(MODULE_DIR, ".."), PACKAGE_ENTRY)];
};

/** `undefined` = not tried yet, `null` = tried and unavailable. */
let coreModule: CoreModule | null | undefined;
let packageLogged = false;
let adapterLogged = false;
let rowBuilderLogged = false;
let serializerLogged = false;

/** One debug line; each caller keeps its own once-per-process guard. */
const debugLog = (message: string): void => {
  console.debug(message);
};

/**
 * `error.name` only.
 *
 * Node's `JSON.parse` failure message quotes a snippet of its input on recent
 * versions, and here the input is the whole todo file. Never log it.
 */
const errorName = (error: unknown): string =>
  error instanceof Error && error.name.length > 0
    ? error.name
    : "unknown error";

/**
 * The requested implementation, from `THAR_CORE`.
 *
 * - `ts` is the escape hatch: the TypeScript reader, pipeline and serializer
 *   only, no package loaded.
 * - `rust`, an unset variable and an empty value all select the Rust core; the
 *   wired paths fall back to TypeScript at runtime when the package is missing
 *   or disagrees.
 * - Any other value is treated as `rust` (the default applies unless the escape
 *   hatch is named explicitly) after one bounded debug line. The value itself is
 *   never echoed, so a stray environment value cannot leak into a log.
 */
let unknownModeLogged = false;

export const getCoreMode = (): CoreMode => {
  const requested = process.env.THAR_CORE;
  if (requested === "ts") return "ts";
  if (requested !== undefined && requested !== "" && requested !== "rust") {
    if (!unknownModeLogged) {
      unknownModeLogged = true;
      debugLog(
        "thar core: unrecognized THAR_CORE value; using the default Rust core " +
          "(set THAR_CORE=ts to opt out)",
      );
    }
  }
  return "rust";
};

const loadCoreModule = (): CoreModule | null => {
  if (coreModule !== undefined) return coreModule;

  const require = createRequire(import.meta.url);
  for (const candidate of packageCandidates()) {
    if (!existsSync(candidate)) continue;
    try {
      coreModule = require(candidate) as CoreModule;
      return coreModule;
    } catch (error) {
      if (!packageLogged) {
        packageLogged = true;
        // Deliberate exception to the "never `error.message`" rule: this
        // error comes from `require`-ing the package path, not from parsing a
        // todo file, and the message is what tells a developer *why* the
        // package was rejected (missing dependency, syntax error, ...). The
        // candidate path is developer-supplied and contains no todo content.
        debugLog(
          `thar core: ignoring unloadable WASM package ${candidate}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  coreModule = null;
  if (!packageLogged) {
    packageLogged = true;
    debugLog(
      "thar core: WASM package not built; using the TypeScript core " +
        "(build it with `npm run build:wasm`; THAR_CORE=ts silences this)",
    );
  }
  return null;
};

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

/** A 1-based line number: the guard's `index` starts at 1. */
const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1;

/** One `[key, value]` pair of the CP1 `tags` field. */
const isTagPair = (value: unknown): value is [string, string | string[]] =>
  Array.isArray(value) &&
  value.length === 2 &&
  typeof value[0] === "string" &&
  (typeof value[1] === "string" || isStringArray(value[1]));

/**
 * Structural check for one contract record.
 *
 * Deliberately stricter than a `"toString" in value` probe: a package that
 * returns the wrong shape must be ignored by every caller rather than guessed
 * at.
 */
const isCoreTodoRecord = (value: unknown): value is CoreTodoRecord => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const tagValue = record.tags;
  return (
    typeof record.text === "string" &&
    (record.state === "todo" || record.state === "done") &&
    isNullableString(record.priority) &&
    isNullableString(record.completionDate) &&
    isNullableString(record.creationDate) &&
    isStringArray(record.projects) &&
    isStringArray(record.contexts) &&
    Array.isArray(tagValue) &&
    tagValue.every(isTagPair) &&
    typeof record.isDone === "boolean" &&
    typeof record.isHidden === "boolean" &&
    typeof record.isVisibleInOverview === "boolean" &&
    typeof record.isOverdue === "boolean" &&
    typeof record.toString === "string" &&
    typeof record.hash === "string" &&
    // CP3b2c fields: accepted when present and required by the read-path
    // normalizer, so an older package still loads and falls back cleanly.
    (record.datesInText === undefined ||
      typeof record.datesInText === "boolean") &&
    (record.completionDateInText === undefined ||
      typeof record.completionDateInText === "boolean") &&
    (record.id === undefined || isNonNegativeInteger(record.id))
  );
};

const isCoreParseResult = (value: unknown): value is CoreParseResult => {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    return false;
  }
  if ((value as { ok: unknown }).ok === true) {
    const todos = (value as { todos?: unknown }).todos;
    return Array.isArray(todos) && todos.every(isCoreTodoRecord);
  }
  if ((value as { ok: unknown }).ok === false) {
    const error = (value as { error?: unknown }).error;
    if (typeof error !== "object" || error === null) return false;
    const fields = error as Record<string, unknown>;
    return (
      typeof fields.name === "string" &&
      typeof fields.code === "string" &&
      typeof fields.message === "string"
    );
  }
  return false;
};

/**
 * Parse `text` with the Rust core.
 *
 * `today` is the local calendar day (`YYYY-MM-DD`). With no `limits` the call
 * uses `thar-wasm`'s compile-time defaults; pass the effective `ReadLimits`
 * (from `getReadLimits()`) whenever the host may have overridden
 * `THAR_MAX_*`, otherwise Rust rejects files the TypeScript reader accepted.
 *
 * Returns `undefined` when the package is unavailable or the call fails for any
 * reason; it never throws. The result is exactly the JSON envelope
 * `thar-wasm` documents, parsed.
 */
export const parseFileWithCore = (
  text: string,
  today: string,
  limits?: ReadLimits,
): CoreParseResult | undefined => {
  const core = loadCoreModule();
  if (!core) return undefined;

  try {
    const raw =
      limits === undefined
        ? core.parseFile(text, today)
        : core.parseFileWithLimits(
            text,
            today,
            limits.maxFileBytes,
            limits.maxReadTodos,
            limits.maxLineChars,
          );
    const parsed: unknown = JSON.parse(raw);
    if (!isCoreParseResult(parsed)) {
      if (!adapterLogged) {
        adapterLogged = true;
        debugLog("thar core: ignoring a malformed parseFile envelope");
      }
      return undefined;
    }
    return parsed;
  } catch (error) {
    if (!adapterLogged) {
      adapterLogged = true;
      // Fixed text plus the error class: never `error.message`, which can
      // quote the todo file on a `JSON.parse` failure.
      debugLog(
        `thar core: parseFile failed (${errorName(error)}); ` +
          "using the TypeScript core",
      );
    }
    return undefined;
  }
};

/** Local calendar day, matching `startOfDay(new Date())` in `logic/todo.ts`. */
export const todayFromClock = (): string =>
  formatDateTag(startOfDay(new Date()));

/**
 * Whether the first real read-path parse problem has been reported.
 *
 * A todo file is loaded on every change and on startup; a package that cannot
 * rebuild the list would otherwise log on every load. One bounded line per
 * process is enough to notice, and the TypeScript reader keeps running.
 */
let parseLogged = false;

/** One bounded, content-free fallback line. */
const logParseFallback = (reason: string): void => {
  if (parseLogged) return;
  parseLogged = true;
  debugLog(`thar core: ${reason}; using the TypeScript reader`);
};

const DATE_TAG_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const PRIORITY_PATTERN = /^[A-Z]$/;

/** The result of reading one wire date field. */
type CoreDateRead = { ok: true; date: Date | undefined } | { ok: false };

/**
 * Normalize one `completionDate`/`creationDate` field.
 *
 * A date must be the exact `YYYY-MM-DD` calendar day the TypeScript parser
 * would produce, so a lenient or lossy value is a malformed record rather than
 * a silently shifted date.
 */
const readRecordDate = (value: string | null): CoreDateRead => {
  if (value === null) return { ok: true, date: undefined };
  if (!DATE_TAG_PATTERN.test(value)) return { ok: false };
  const date = parseDateTag(value);
  if (date === undefined || formatDateTag(date) !== value) {
    return { ok: false };
  }
  return { ok: true, date };
};

/**
 * Normalize the ordered `[key, value]` tag pairs into the object `Todo` uses.
 *
 * Object keys preserve insertion order, which is the serialization order. A
 * duplicate key cannot come from the Rust parser (it groups repeated tags into
 * an array), so it means the envelope is wrong; so does an empty key/value,
 * which no scanned line can produce.
 */
const readRecordTags = (
  pairs: [string, string | string[]][],
): Record<string, string | string[]> | undefined => {
  const tags: Record<string, string | string[]> = {};
  for (const [key, value] of pairs) {
    if (key.length === 0) return undefined;
    if (Object.hasOwn(tags, key)) return undefined;
    if (typeof value === "string") {
      if (value.length === 0) return undefined;
      tags[key] = value;
    } else {
      if (value.length === 0 || value.some((item) => item.length === 0)) {
        return undefined;
      }
      tags[key] = [...value];
    }
  }
  return tags;
};

/**
 * Validate one parse record and turn it into typed `TodoParts`.
 *
 * Returns `undefined` for anything unexpected — a missing flag or id, an
 * invalid priority or calendar date, a duplicate or empty tag, a state that
 * disagrees with `isDone`, or a `hash` that is not the serialized line. The
 * caller then falls back to the TypeScript reader rather than accepting a
 * todo the app would serialize differently.
 */
export const parseRecordToTodoParts = (
  record: CoreTodoRecord,
): TodoParts | undefined => {
  if (!isCoreTodoRecord(record)) return undefined;
  if (
    typeof record.datesInText !== "boolean" ||
    typeof record.completionDateInText !== "boolean" ||
    !isNonNegativeInteger(record.id)
  ) {
    return undefined;
  }
  if (record.hash !== record.toString) return undefined;

  const completion = readRecordDate(record.completionDate);
  const creation = readRecordDate(record.creationDate);
  if (!completion.ok || !creation.ok) return undefined;

  let priority: UpperCaseLetter | undefined;
  if (record.priority !== null) {
    if (!PRIORITY_PATTERN.test(record.priority)) return undefined;
    priority = record.priority as UpperCaseLetter;
  }

  const tags = readRecordTags(record.tags);
  if (tags === undefined) return undefined;

  // A literal completion date is a leading token in `text`, so the flag
  // without a date (or a `done` flag that disagrees with the state) is a
  // malformed record.
  if (record.completionDateInText && completion.date === undefined) {
    return undefined;
  }
  const state =
    record.state === "done" ? TodoStateEnum.done : TodoStateEnum.todo;
  if (record.isDone !== (state === TodoStateEnum.done)) return undefined;

  return {
    text: record.text,
    state,
    priority,
    completionDate: completion.date,
    creationDate: creation.date,
    projects: [...record.projects],
    contexts: [...record.contexts],
    tags,
    datesInText: record.datesInText,
    completionDateInText: record.completionDateInText,
  };
};

/** The number of lines the TypeScript reader keeps (non-blank, in order). */
const nonBlankLineCount = (text: string): number =>
  text
    .split("\n")
    .reduce((count, line) => (line.trim().length > 0 ? count + 1 : count), 0);

/**
 * The `@context` or `+project` names the constructor would find in `text`.
 *
 * The serialized line cannot show these fields directly (they are part of the
 * body, not tags), so the runtime round-trip guard re-derives them with the same
 * patterns the constructor uses. Without this, a package that agrees on bytes
 * but disagrees on `projects`/`contexts` would silently change `createIndexes`
 * grouping.
 */
const derivedNames = (text: string, pattern: RegExp): Set<string> => {
  const names = new Set<string>();
  for (const match of text.matchAll(pattern)) {
    const name = match.groups?.name;
    if (name !== undefined) names.add(name);
  }
  return names;
};

const sameNames = (left: Set<string>, right: Set<string>): boolean =>
  left.size === right.size && [...left].every((name) => right.has(name));

/**
 * Map a Rust rejection back to the exact TypeScript error.
 *
 * The numeric fields are re-checked by regenerating the TypeScript message: a
 * reader error's message embeds its line, length or byte count, so a match
 * proves the numbers are the ones the oracle would have reported. Any mismatch
 * returns `undefined` and the caller runs the TypeScript validator, which
 * throws the true error.
 */
const coreValidationError = (
  error: CoreParseError,
): TodoFileValidationError | undefined => {
  let mapped: TodoFileValidationError;
  switch (error.code) {
    case "FILE_TOO_LARGE":
      // Defence in depth: both callers check the decoded byte count before
      // asking Rust, so this mapping is unreachable in production today.
      if (
        !isPositiveInteger(error.actualBytes) ||
        !isPositiveInteger(error.maxBytes)
      ) {
        return undefined;
      }
      mapped = new TodoFileTooLargeError(error.actualBytes, error.maxBytes);
      break;
    case "TOO_MANY_LINES":
      if (
        !isPositiveInteger(error.lineCount) ||
        !isPositiveInteger(error.maxReadTodos)
      ) {
        return undefined;
      }
      mapped = new TodoLineCountLimitError(error.lineCount, error.maxReadTodos);
      break;
    case "LINE_TOO_LONG":
      if (
        !isPositiveInteger(error.lineNumber) ||
        !isNonNegativeInteger(error.length) ||
        !isPositiveInteger(error.maxLineChars)
      ) {
        return undefined;
      }
      mapped = new TodoLineLengthLimitError(
        error.lineNumber,
        error.length,
        error.maxLineChars,
      );
      break;
    case "CONTROL_CHARACTER":
      if (
        !isPositiveInteger(error.lineNumber) ||
        !isNonNegativeInteger(error.codePoint)
      ) {
        return undefined;
      }
      mapped = new TodoControlCharacterError(error.lineNumber, error.codePoint);
      break;
    default:
      return undefined;
  }
  return mapped.message === error.message ? mapped : undefined;
};

/**
 * Parse the todo file with the Rust core and rebuild the list as real
 * {@link Todo} instances. This is the default wired read path since CP5.
 *
 * One `parseFileWithLimits` call replaces
 * the TypeScript `validateTodoFileContent → filter(blank) → new Todo(line)`
 * chain:
 *
 * - a legitimate limit/control rejection is mapped back to the same
 *   `TodoFileValidationError` subclass, message and fields the TypeScript
 *   validator would have thrown, so the user sees no difference;
 * - every record is validated and rebuilt through `Todo.fromParts`, so tags
 *   stay array-valued and the two round-trip flags survive without a second
 *   parse;
 * - the record count must equal the file's non-blank line count, each `id`
 *   must be its array position, and each rebuilt line must equal the record's
 *   `toString`/`hash`, so a dropped, reordered or lossy envelope falls back
 *   instead of changing the list;
 * - `undefined` means "use the TypeScript reader": `ts` mode, a missing or
 *   broken package, a malformed envelope, a thrown error, a rejection the
 *   mapper cannot prove, or any record/count/order mismatch. The first such
 *   problem in a process logs one bounded, content-free line.
 *
 * `today` is the local calendar day; it only affects the envelope's
 * `isOverdue`/`isVisibleInOverview` fields, which the reconstructed todo
 * recomputes from its own clock-sensitive getters. `limits` must be the
 * effective `ReadLimits` of the load, exactly as for the TypeScript reader.
 */
export const parseTodosWithCore = (
  text: string,
  today: string,
  limits: ReadLimits,
): Todos | undefined => {
  if (getCoreMode() !== "rust") return undefined;

  const parsed = parseFileWithCore(text, today, limits);
  if (!parsed) return undefined;

  if (!parsed.ok) {
    const mapped = coreValidationError(parsed.error);
    if (mapped) throw mapped;
    // Envelope strings are only type-checked, so bound them like every other
    // diagnostic instead of echoing an arbitrarily long package value.
    const name = parsed.error.name.slice(0, 32);
    const code = parsed.error.code.slice(0, 32);
    logParseFallback(`rejected ${name}/${code}`);
    return undefined;
  }

  const expected = nonBlankLineCount(text);
  if (parsed.todos.length !== expected) {
    logParseFallback(
      `parseFile returned ${parsed.todos.length} record(s) for ${expected} line(s)`,
    );
    return undefined;
  }

  const todos: Todos = [];
  for (let index = 0; index < parsed.todos.length; index++) {
    const record = parsed.todos[index];
    if (record.id !== index) {
      logParseFallback(
        record.id === undefined
          ? `parseFile record ${index} is missing its load id`
          : `parseFile record ${index} has load id ${String(record.id)}`,
      );
      return undefined;
    }
    const parts = parseRecordToTodoParts(record);
    if (!parts) {
      logParseFallback(`parseFile record ${index} is malformed`);
      return undefined;
    }
    const todo = Todo.fromParts(parts);
    if (todo.toString() !== record.toString || todo.getHash() !== record.hash) {
      logParseFallback(`parseFile record ${index} does not round-trip`);
      return undefined;
    }
    // `projects`/`contexts` are body fields, so the byte round-trip above
    // cannot see a disagreement. Re-derive them with the constructor's patterns.
    if (
      !sameNames(derivedNames(record.text, PROJECT_REGEX), todo.projects) ||
      !sameNames(derivedNames(record.text, CONTEXT_REGEX), todo.contexts)
    ) {
      logParseFallback(
        `parseFile record ${index} has inconsistent projects/contexts`,
      );
      return undefined;
    }
    todos.push(todo);
  }
  return todos;
};

/**
 * One structured todo handed to the Rust core, at either boundary.
 *
 * Mirrors the Rust `TodoRecord` DTO: the getters of the TypeScript `Todo`,
 * never `toString()`. Serializing and re-parsing a line would collapse a
 * duplicated tag array (`beta:one beta:two`), and `build_rows` would then see
 * `beta` as one value instead of two. The two round-trip flags are sent too, so
 * CP4 can rebuild an exact `Todo` for serialization.
 */
export interface CoreRowTodo {
  text: string;
  state: "todo" | "done";
  priority: string | null;
  completionDate: string | null;
  creationDate: string | null;
  projects: string[];
  contexts: string[];
  tags: [string, string | string[]][];
  /**
   * Round-trip flag from the TypeScript `Todo`: leading dates stayed in `text`.
   * Row building ignores it; CP4's write path needs it to rebuild an exact
   * `Todo` from these records.
   */
  datesInText: boolean;
  /**
   * Round-trip flag from the TypeScript `Todo`: the completion date is already
   * the leading literal token in `text`.
   */
  completionDateInText: boolean;
}

/**
 * The host-normalized `SearchView` for one todo.
 *
 * CP3a's core takes views instead of folding: `String.prototype.toLowerCase`
 * applies the Unicode `Final_Sigma` rule and Rust's Unicode version can trail
 * the host's. Only the query terms change per keystroke, so the text,
 * contexts and projects are lowercased per element, exactly like
 * `filterBySearch` does.
 */
export interface CoreRowSearchView {
  text: string;
  contexts: string[];
  projects: string[];
}

/**
 * The JSON document `buildRows` accepts (the CP3b1 wire contract).
 *
 * `searchViews` is aligned with `todos` by index; it is the name the Rust
 * decoder requires (`crates/thar-wasm/src/rows.rs`), not a host-invented alias.
 * `terms` are already split and normalized by `extractSearchTerms`, and `today`
 * is the local `YYYY-MM-DD` day. Empty `terms` match every todo, matching
 * `filterBySearch`.
 */
export interface CoreRowInput {
  todos: CoreRowTodo[];
  searchViews: CoreRowSearchView[];
  terms: string[];
  showHidden: boolean;
  today: string;
}

/** A `buildRows`-shaped function; the test seam injects one of these. */
export type CoreRowBuilder = (input: string) => string;

/** A context header or todo row read back from the Rust envelope. */
type CoreRow =
  | { type: "context"; contextName: string; todoCount: number }
  | { type: "todo"; index: number; number: number };

/**
 * Structured records and search views, cached on the identity of the todo array.
 *
 * The app replaces the array on every edit and keeps `Todo` instances
 * immutable (`with()` clones), so the array identity is a sound cache key.
 * Rebuilding the records per keystroke at 10 000 todos is the expensive part
 * of marshalling; only `terms` actually changes while typing.
 */
let rowInputCache = new WeakMap<
  readonly Todo[],
  { records: CoreRowTodo[]; searchViews: CoreRowSearchView[] }
>();

/** Injected by {@link setRowBuilderForTests}; production leaves it unset. */
let injectedRowBuilder: CoreRowBuilder | undefined;

/** Injected by {@link setCollatorLocaleForTests}; production leaves it unset. */
let injectedCollatorLocale: string | undefined;

/**
 * The structured record both Rust boundaries take.
 *
 * Exported so the write contract (`tools/port/write.ts`) can build the exact
 * request the app sends: the contract oracle must not re-implement these
 * getters, or a broken projection could hide a serializer diff.
 */
export const coreTodoRecord = (todo: Todo): CoreRowTodo => ({
  text: todo.text,
  state: todo.isDone() ? "done" : "todo",
  priority: todo.priority ?? null,
  completionDate:
    todo.completionDate === undefined
      ? null
      : formatDateTag(todo.completionDate),
  creationDate:
    todo.creationDate === undefined ? null : formatDateTag(todo.creationDate),
  projects: Array.from(todo.projects),
  contexts: Array.from(todo.contexts),
  // `Object.entries` preserves insertion order and keeps array-valued tags:
  // this is the structured form the CP3b1 DTO exists for.
  tags: Object.entries(todo.tags).map(
    ([key, value]) => [key, value] as [string, string | string[]],
  ),
  // The two round-trip flags are invisible in `toString()`, so a boundary that
  // re-parsed the line could not recover them; CP4 needs them to serialize an
  // exact copy.
  datesInText: todo.datesInText,
  completionDateInText: todo.completionDateInText,
});

const rowInputFor = (
  todos: Todos,
): { records: CoreRowTodo[]; searchViews: CoreRowSearchView[] } => {
  const cached = rowInputCache.get(todos);
  if (cached) return cached;

  const records = todos.map(coreTodoRecord);
  const searchViews = records.map((record) => ({
    text: record.text.toLowerCase(),
    contexts: record.contexts.map((context) => context.toLowerCase()),
    projects: record.projects.map((project) => project.toLowerCase()),
  }));
  const parts = { records, searchViews };
  rowInputCache.set(todos, parts);
  return parts;
};

/**
 * One structural read of a `buildRows` response.
 *
 * `error` is the honest rejection envelope the core emits (`{ok:false,error:
 * {name,code,message}}`); `malformed` is everything else that is not the
 * documented row shape. The two are kept apart so a legitimate rejection is
 * logged with its typed code instead of being collapsed into "malformed
 * envelope".
 */
type CoreRowRead =
  | { kind: "rows"; rows: CoreRow[] }
  | { kind: "error"; name?: string; code: string }
  | { kind: "malformed" };

/**
 * Read `{ok:true,rows:[…]}` or `{ok:false,error:{…}}` structurally.
 *
 * Only the merged contract's field names are accepted (`type`, `contextName`,
 * `todoCount`, `index`, `number`): a package that emits a different shape must
 * fall back, not be guessed at.
 *
 * The envelope's `order` array is deliberately ignored: the per-row `index` is
 * the authoritative input position, and the grouping checks in
 * {@link toIndexEntries} reject an order that disagrees with those indexes.
 */
const readRowEnvelope = (raw: string): CoreRowRead => {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null)
    return { kind: "malformed" };
  const envelope = parsed as { ok?: unknown; rows?: unknown; error?: unknown };

  if (envelope.ok === false) {
    const error = envelope.error;
    if (typeof error !== "object" || error === null) {
      return { kind: "malformed" };
    }
    const fields = error as { name?: unknown; code?: unknown };
    if (typeof fields.code !== "string" || fields.code.length === 0) {
      return { kind: "malformed" };
    }
    return {
      kind: "error",
      code: fields.code,
      // The name is the error class; the core always sends it, but a code is
      // what the fallback logs, so a missing name is not fatal.
      ...(typeof fields.name === "string" && fields.name.length > 0
        ? { name: fields.name }
        : {}),
    };
  }

  if (envelope.ok !== true || !Array.isArray(envelope.rows)) {
    return { kind: "malformed" };
  }

  const rows: CoreRow[] = [];
  for (const entry of envelope.rows) {
    if (typeof entry !== "object" || entry === null) {
      return { kind: "malformed" };
    }
    const record = entry as Record<string, unknown>;
    if (record.type === "context") {
      const name = record.contextName;
      const count = record.todoCount;
      if (!isNonNegativeInteger(count) || count < 1) {
        return { kind: "malformed" };
      }
      if (typeof name !== "string") return { kind: "malformed" };
      rows.push({ type: "context", contextName: name, todoCount: count });
    } else if (record.type === "todo") {
      const index = record.index;
      const number = record.number;
      if (!isNonNegativeInteger(index) || typeof number !== "number") {
        return { kind: "malformed" };
      }
      rows.push({ type: "todo", index, number });
    } else {
      return { kind: "malformed" };
    }
  }
  return { kind: "rows", rows };
};

/**
 * Map Rust rows back to `IndexEntry`.
 *
 * The row ids must be consistent with the input: an index in range, used at
 * most once, headers whose `todoCount` matches the todo rows that follow, and
 * 1-based numbers in list order. Anything else is a shape error, so the
 * caller keeps the TypeScript indexes instead of rendering a half-valid list.
 */
const toIndexEntries = (
  rows: CoreRow[],
  todos: Todos,
): IndexEntry[] | undefined => {
  const entries: IndexEntry[] = [];
  const seen = new Set<number>();
  let header: { name: string; todoCount: number; seen: number } | undefined;
  let expectedNumber = 1;

  for (const row of rows) {
    if (row.type === "context") {
      if (header !== undefined && header.seen !== header.todoCount) {
        return undefined;
      }
      header = {
        name: row.contextName,
        todoCount: row.todoCount,
        seen: 0,
      };
      entries.push({
        type: IndexType.context,
        todoCount: row.todoCount,
        contextName: row.contextName,
      });
      continue;
    }

    // A todo row without a preceding header cannot be rendered, the number
    // must continue the global 1-based sequence, and the header must name the
    // todo's first context (`"None"` for an uncategorised todo).
    if (header === undefined) return undefined;
    if (row.number !== expectedNumber) return undefined;

    const todo = todos[row.index];
    if (todo === undefined || seen.has(row.index)) return undefined;
    const context = todo.contexts.values().next().value ?? "None";
    if (header.name !== context) return undefined;

    seen.add(row.index);
    header.seen++;
    expectedNumber++;
    entries.push({ type: IndexType.todo, todo, number: row.number });
  }

  if (header !== undefined && header.seen !== header.todoCount) {
    return undefined;
  }
  return entries;
};

const rowBuilderOf = (core: CoreModule): CoreRowBuilder | undefined => {
  const builder = core.buildRows;
  if (typeof builder !== "function") return undefined;
  return (input: string) => builder.call(core, input);
};

/**
 * The TypeScript pipeline for one call.
 *
 * Only the empty-result gate uses this, so the normal Rust path never pays for
 * it. It mirrors the hook's fallback exactly: the gate must decide against the
 * same result the caller would fall back to.
 */
const tsIndexEntries = (
  todos: Todos,
  query: string,
  showHidden: boolean,
): IndexEntry[] => {
  const sorted = sortByImportance(todos);
  const visible = showHidden ? sorted : filterHidden(sorted);
  return createIndexes(filterBySearch(visible, query));
};

/**
 * Build the main list's rows in Rust. This is the default wired row path since
 * CP5.
 *
 * Returns `undefined` for the `ts` mode, a host locale the Rust collation does
 * not implement, a missing package or export, and on any thrown error or
 * inconsistent output; the caller then keeps the TypeScript
 * `sortByImportance → filterHidden → filterBySearch → createIndexes` result.
 * The first problem in a process logs one bounded, content-free debug line;
 * nothing is ever thrown into the TUI and no todo content is logged.
 *
 * A well-formed empty result is gated rather than trusted: `{ok:true,rows:[]}`
 * for a non-empty todo list is accepted only when the TypeScript pipeline is
 * empty too (everything hidden, or a query that genuinely matches nothing).
 * Otherwise the TypeScript rows are used and one bounded line says so.
 *
 * `query` is normalized here with `extractSearchTerms`, and the per-todo search
 * views are lowercased here, because CP3a's core deliberately does no case
 * folding. `today` is the local `YYYY-MM-DD` day and must be passed from a
 * value that changes at midnight.
 */
export const buildRowsWithCore = (
  todos: Todos,
  query: string,
  showHidden: boolean,
  today: string,
): IndexEntry[] | undefined => {
  if (getCoreMode() !== "rust") return undefined;

  // The test seam bypasses the package, so the wiring is exercised without a
  // build. Production never injects a builder, hence the collation guard sits
  // on the real package path only: the seam is a deterministic fake, not a
  // second sort implementation.
  let builder = injectedRowBuilder;
  if (!builder) {
    const core = loadCoreModule();
    // `loadCoreModule` already logs the missing package once per process.
    if (!core) return undefined;

    builder = rowBuilderOf(core);
    if (!builder) {
      if (!rowBuilderLogged) {
        rowBuilderLogged = true;
        debugLog(
          "thar core: buildRows is not exported; using the TypeScript row builder",
        );
      }
      return undefined;
    }

    // The Rust sort implements en-US ICU. On a host whose `localeCompare`
    // default differs, the same contexts can order differently, so falling back
    // is a correctness guard (PLAN §13 decision 8), not a perf feature. Checked
    // after the package so a missing build is the more actionable diagnostic.
    const locale = injectedCollatorLocale ?? defaultCollatorLocale();
    if (!isEnglishCollator(locale)) {
      if (!rowBuilderLogged) {
        rowBuilderLogged = true;
        debugLog(
          `thar core: locale ${locale}, rust rows need en-US; ` +
            "using the TypeScript row builder",
        );
      }
      return undefined;
    }
  }

  try {
    const { records, searchViews } = rowInputFor(todos);
    const input: CoreRowInput = {
      todos: records,
      searchViews,
      terms: extractSearchTerms(query),
      showHidden,
      today,
    };
    const result = readRowEnvelope(builder(JSON.stringify(input)));

    if (result.kind === "error") {
      if (!rowBuilderLogged) {
        rowBuilderLogged = true;
        const label =
          result.name === undefined
            ? result.code
            : `${result.name}/${result.code}`;
        debugLog(
          `thar core: buildRows rejected (${label}); ` +
            "using the TypeScript row builder",
        );
      }
      return undefined;
    }

    if (result.kind === "malformed") {
      if (!rowBuilderLogged) {
        rowBuilderLogged = true;
        debugLog(
          "thar core: ignoring a malformed buildRows envelope; " +
            "using the TypeScript row builder",
        );
      }
      return undefined;
    }

    if (result.rows.length === 0 && todos.length > 0) {
      // A legitimate empty result (all hidden / no match) looks exactly like a
      // builder that dropped the list. Ask the TypeScript pipeline once, for
      // this call only.
      const tsEntries = tsIndexEntries(todos, query, showHidden);
      if (tsEntries.length > 0) {
        if (!rowBuilderLogged) {
          rowBuilderLogged = true;
          debugLog(
            `thar core: buildRows returned rows empty, ts=${tsEntries.length}; ` +
              "using the TypeScript row builder",
          );
        }
        return tsEntries;
      }
      // The TypeScript pipeline is empty too: the empty result is legitimate.
      return tsEntries;
    }

    const entries = toIndexEntries(result.rows, todos);
    if (!entries && !rowBuilderLogged) {
      rowBuilderLogged = true;
      debugLog(
        "thar core: buildRows returned rows that do not match the todo list; " +
          "using the TypeScript row builder",
      );
    }
    return entries;
  } catch (error) {
    if (!rowBuilderLogged) {
      rowBuilderLogged = true;
      // `errorName`, not `error.message`: a `JSON.parse` failure can quote the
      // request, and the request contains the todo list.
      debugLog(
        `thar core: buildRows failed (${errorName(error)}); ` +
          "using the TypeScript row builder",
      );
    }
    return undefined;
  }
};

/**
 * The JSON document `serializeFile` accepts.
 *
 * The same DTO `buildRows` takes, without the search fields: CP4's write path
 * only needs the records.
 */
export interface CoreSerializeInput {
  todos: CoreRowTodo[];
}

/**
 * The outcome of a real (non-fallback) `serializeFile` answer.
 *
 * `ok: false` is a typed rejection from the core (for example
 * `UNSAFE_CONTROL_CHARACTER`); the caller reports it once and keeps the
 * TypeScript text. A malformed request, an absent export, a malformed envelope
 * and a thrown error are all reported as `undefined` instead.
 */
export type SerializeCoreResult =
  | { ok: true; text: string }
  | { ok: false; error: { code: string } };

/** A `serializeFile`-shaped function; the test seam injects one of these. */
export type CoreSerializer = (input: string) => string;

/** Injected by {@link setSerializerForTests}; production leaves it unset. */
let injectedSerializer: CoreSerializer | undefined;

const serializerOf = (core: CoreModule): CoreSerializer | undefined => {
  const serializer = core.serializeFile;
  if (typeof serializer !== "function") return undefined;
  return (input: string) => serializer.call(core, input);
};

/**
 * Structural read of a `serializeFile` response.
 *
 * Only the merged contract's field names are accepted (`text`; `code`), so a
 * package that emits a different shape falls back instead of being guessed at.
 * Any `ok:false` code is reported once and then falls back to TypeScript: the
 * TypeScript guard has already accepted these lines, so a Rust-only rejection
 * means package divergence, not unsafe user input.
 */
const readSerializeEnvelope = (
  raw: string,
): SerializeCoreResult | undefined => {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const envelope = parsed as { ok?: unknown; text?: unknown; error?: unknown };

  if (envelope.ok === true) {
    return typeof envelope.text === "string"
      ? { ok: true, text: envelope.text }
      : undefined;
  }

  if (envelope.ok !== false) return undefined;
  const error = envelope.error;
  if (typeof error !== "object" || error === null) return undefined;
  const fields = error as { code?: unknown };
  if (typeof fields.code !== "string" || fields.code.length === 0) {
    return undefined;
  }
  return { ok: false, error: { code: fields.code } };
};

/**
 * Serialize the whole todo list in Rust. This is the default serializer since
 * CP5, and its text is byte-compared against the TypeScript oracle.
 *
 * Returns the Rust text (`{ok: true}`), the write-time guard's rejection
 * (`{ok: false}`, `UNSAFE_CONTROL_CHARACTER` only), or `undefined` for the `ts`
 * mode and every failure — a missing package or export, a thrown error, a
 * malformed envelope, and any other rejection. The caller
 * (`writeTodosToFile`) keeps the TypeScript text in that case, after a byte
 * compare, so this function never writes, throws, or changes state.
 *
 * The first problem in a process logs one bounded, content-free debug line.
 * The request body is never logged: it contains every todo line.
 */
export const serializeTodosWithCore = (
  todos: Todos,
): SerializeCoreResult | undefined => {
  if (getCoreMode() !== "rust") return undefined;

  let serializer = injectedSerializer;
  if (!serializer) {
    const core = loadCoreModule();
    // `loadCoreModule` already logs the missing package once per process.
    if (!core) return undefined;

    serializer = serializerOf(core);
    if (!serializer) {
      if (!serializerLogged) {
        serializerLogged = true;
        debugLog(
          "thar core: serializeFile is missing or not a function; " +
            "using the TypeScript serializer",
        );
      }
      return undefined;
    }
  }

  try {
    const input: CoreSerializeInput = { todos: todos.map(coreTodoRecord) };
    const result = readSerializeEnvelope(serializer(JSON.stringify(input)));
    if (result === undefined) {
      if (!serializerLogged) {
        serializerLogged = true;
        debugLog(
          "thar core: ignoring a malformed serializeFile envelope; " +
            "using the TypeScript serializer",
        );
      }
      return undefined;
    }
    if (!result.ok) {
      // The TypeScript guard already accepted these lines, so a Rust-only
      // rejection (even `UNSAFE_CONTROL_CHARACTER`) means the package diverged.
      // Report it once and keep the oracle text; never block the user's save.
      if (!serializerLogged) {
        serializerLogged = true;
        debugLog(
          `thar core: serializeFile rejected (${result.error.code}); ` +
            "using the TypeScript serializer",
        );
      }
      return undefined;
    }
    return result;
  } catch (error) {
    if (!serializerLogged) {
      serializerLogged = true;
      // `errorName`, not `error.message`: a `JSON.parse` failure can quote the
      // request, and the request contains every todo line.
      debugLog(
        `thar core: serializeFile failed (${errorName(error)}); ` +
          "using the TypeScript serializer",
      );
    }
    return undefined;
  }
};

/**
 * Test-only: inject a `serializeFile` stand-in, or clear it with `undefined`.
 *
 * The seam lets the write-path and data-safety tests drive the dual-write gate
 * without building a package. Production never calls it.
 *
 * @internal
 */
export const setSerializerForTests = (
  serializer: CoreSerializer | undefined,
): void => {
  injectedSerializer = serializer;
};

/**
 * Test-only: inject a `buildRows` stand-in, or clear it with `undefined`.
 *
 * The seam lets the wiring and the fallback tests run against a deterministic
 * fake. Production never calls it.
 *
 * @internal
 */
export const setRowBuilderForTests = (
  builder: CoreRowBuilder | undefined,
): void => {
  injectedRowBuilder = builder;
};

/**
 * Test-only: pretend the host default collator resolved to `locale`.
 *
 * `undefined` restores {@link defaultCollatorLocale}. The guard only runs on
 * the real package path, so a guard test also builds a fake package.
 *
 * @internal
 */
export const setCollatorLocaleForTests = (locale: string | undefined): void => {
  injectedCollatorLocale = locale;
};

/**
 * Test-only: forget the cached package, the injected row builder, the memoized
 * row input and the once-per-process log flags.
 *
 * Production code never calls this; tests need it because the module cache and
 * the log-once guards outlive a single test. It is not public API: the package
 * entry (`dist/main.js`) exports nothing, and `logic/` is not a published
 * subpath.
 *
 * @internal
 */
export const resetCoreBridgeForTests = (): void => {
  coreModule = undefined;
  packageLogged = false;
  adapterLogged = false;
  parseLogged = false;
  rowBuilderLogged = false;
  serializerLogged = false;
  unknownModeLogged = false;
  injectedRowBuilder = undefined;
  injectedSerializer = undefined;
  injectedCollatorLocale = undefined;
  rowInputCache = new WeakMap();
};
