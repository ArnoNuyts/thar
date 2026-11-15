import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startOfDay } from "date-fns";

import { formatDateTag } from "./dates.ts";
import { getReadLimits, type ReadLimits } from "./limits.ts";
import type { Todo } from "./todo.ts";

/**
 * Opt-in bridge to the Rust core compiled to WebAssembly (CP2b).
 *
 * The TypeScript implementation is still the source of truth at CP2: nothing
 * here changes what the TUI displays, saves, or exports. The module offers two
 * development-only entry points:
 *
 * - {@link parseFileWithCore}, a thin batch adapter over `thar-wasm`'s
 *   `parseFile`/`parseFileWithLimits`;
 * - {@link shadowCheckTodoFile}, the `THAR_SHADOW=1` differential check that
 *   compares Rust against the already-parsed TypeScript result.
 *
 * Both are defensive: a missing, unbuildable or broken package, a malformed
 * envelope, and a rejected `today` all resolve to `undefined` plus at most one
 * debug log. Nothing here may throw into the TUI, and nothing here writes to
 * the todo file. Debug lines never include the parse input: a todo line is its
 * own `hash`, so a Node `JSON.parse` snippet would leak content.
 *
 * The package is loaded with `createRequire` and a module-relative runtime
 * path, never with a static `import`, so `npm run build`, `npm test` and
 * `npm run check` work in a clean checkout where `crates/thar-wasm/pkg/`
 * (gitignored) does not exist. Build it for local experiments with:
 *
 * ```sh
 * wasm-pack build crates/thar-wasm --release --target nodejs --out-dir pkg
 * ```
 *
 * See `docs/rust-port/PLAN.md` §5 (CP2) and §9.1.
 */

/** Which implementation the read path should use; only `ts` is live at CP2. */
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
}

/** Successful or rejected envelope from the Rust parse. */
export type CoreParseResult =
  | { ok: true; todos: CoreTodoRecord[] }
  | { ok: false; error: { name: string; code: string; message: string } };

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
 * that directory — loading it would run foreign code and make the shadow check
 * compare against a package this checkout never built. `THAR_CORE_WASM` is the
 * dev-only escape hatch for pointing the bridge at another build; it goes
 * through `resolve`, so a relative value is relative to `process.cwd()`.
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
 * The requested implementation, from `THAR_CORE=ts|rust`.
 *
 * At CP2 both values keep the TypeScript implementation as the source of truth;
 * the switch itself is CP3. The flag is read now so the CP3 change is a smaller
 * step and so tests can prove the values are behaviourally identical.
 * Anything other than `rust` means `ts`.
 */
export const getCoreMode = (): CoreMode =>
  process.env.THAR_CORE === "rust" ? "rust" : "ts";

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
        "(build crates/thar-wasm/pkg with wasm-pack to enable the shadow check)",
    );
  }
  return null;
};

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

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
 * returns the wrong shape must be ignored, not fed into the shadow comparison
 * where a missing field would read as a mismatch.
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
    typeof record.hash === "string"
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

/** True when `THAR_SHADOW=1` is exported. Off by default. */
export const isShadowEnabled = (): boolean => process.env.THAR_SHADOW === "1";

/** Upper bound on one shadow log file; older records are dropped by truncation. */
export const MAX_SHADOW_LOG_BYTES = 64 * 1024;

/** Upper bound on per-line detail in one shadow record. */
export const MAX_SHADOW_LINE_DETAILS = 20;

/** Hex characters kept from a SHA-256 digest in a shadow record. */
const SHADOW_HASH_CHARS = 16;

/**
 * Where mismatch records are appended.
 *
 * `THAR_SHADOW_LOG` wins; otherwise `<user cache dir>/thar/shadow.log`
 * (`$XDG_CACHE_HOME`, `~/Library/Caches` on macOS, `%LOCALAPPDATA%` on Windows,
 * `~/.cache` elsewhere).
 *
 * The environment, platform and home directory are parameters rather than
 * globals so the platform branches are testable on any host: `os.homedir()`
 * ignores a faked `process.platform` and reads `USERPROFILE` on Windows.
 */
export const resolveShadowLogPath = (
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  homeDir: string,
): string => {
  const override = env.THAR_SHADOW_LOG;
  if (override) return resolve(override);

  const xdg = env.XDG_CACHE_HOME;
  const base =
    xdg && xdg.length > 0
      ? xdg
      : platform === "darwin"
        ? join(homeDir, "Library", "Caches")
        : platform === "win32"
          ? (env.LOCALAPPDATA ?? join(homeDir, "AppData", "Local"))
          : join(homeDir, ".cache");
  return join(base, "thar", "shadow.log");
};

/** {@link resolveShadowLogPath} for the current process. */
export const shadowLogPath = (): string =>
  resolveShadowLogPath(process.env, process.platform, homedir());

/**
 * A content-free diagnostic record.
 *
 * Counts, indexes, and truncated SHA-256 digests only: a todo line *is* its own
 * `hash`, so the raw line (and therefore any todo text) must never be written.
 */
interface ShadowMismatch {
  at: string;
  kind: "mismatch";
  tsTodoCount: number;
  rustTodoCount: number;
  mismatchCount: number;
  lines: {
    index: number;
    fields: string[];
    tsHash: string;
    rustHash: string;
  }[];
  linesTruncated: boolean;
  serialized: { equal: boolean; tsHash: string; rustHash: string };
}

interface ShadowRejected {
  at: string;
  kind: "rejected";
  tsTodoCount: number;
  error: { name: string; code: string };
}

type ShadowRecord = ShadowMismatch | ShadowRejected;

/** Local calendar day, matching `startOfDay(new Date())` in `logic/todo.ts`. */
const todayFromClock = (): string => formatDateTag(startOfDay(new Date()));

/** Stable, content-free digest of one serialized todo line. */
const shortHash = (line: string): string =>
  createHash("sha256")
    .update(line, "utf8")
    .digest("hex")
    .slice(0, SHADOW_HASH_CHARS);

/**
 * Compare the Rust parse with the TypeScript result the app is about to use.
 *
 * `limits` are the effective read limits of the load that produced `todos`;
 * passing them keeps Rust from rejecting a file the TypeScript reader accepted
 * under a `THAR_MAX_*` override.
 *
 * Returns `undefined` when the two agree or when the Rust package is
 * unavailable. Only per-todo `toString`/`hash` and the whole-file serialized
 * bytes are compared; that is what CP1 freezes, and it keeps the check
 * independent of the ambient clock's sub-day drift.
 */
const compareWithCore = (
  text: string,
  todos: readonly Todo[],
  limits: ReadLimits,
): ShadowRecord | undefined => {
  const parsed = parseFileWithCore(text, todayFromClock(), limits);
  if (!parsed) return undefined;

  const at = new Date().toISOString();
  const tsLines = todos.map((todo) => todo.toString());

  if (!parsed.ok) {
    return {
      at,
      kind: "rejected",
      tsTodoCount: tsLines.length,
      error: { name: parsed.error.name, code: parsed.error.code },
    };
  }

  const rustLines = parsed.todos.map((todo) => todo.toString);
  const lines: ShadowMismatch["lines"] = [];
  let mismatchCount = 0;

  for (
    let index = 0;
    index < Math.max(tsLines.length, rustLines.length);
    index++
  ) {
    const tsLine = tsLines[index];
    const todo = parsed.todos[index];
    const rustLine = rustLines[index];
    const fields: string[] = [];
    if (tsLine !== rustLine) fields.push("toString");
    // `getHash()` is `toString()`, so `hash` duplicates `toString` on both
    // sides. It is still compared because it is a contract field: a record
    // that carries the right line in `toString` and a wrong one in `hash`
    // must not pass.
    if (todo !== undefined && todo.hash !== tsLine) fields.push("hash");
    if (fields.length === 0) continue;

    mismatchCount++;
    if (lines.length < MAX_SHADOW_LINE_DETAILS) {
      lines.push({
        index,
        fields,
        tsHash: tsLine === undefined ? "" : shortHash(tsLine),
        rustHash: rustLine === undefined ? "" : shortHash(rustLine),
      });
    }
  }

  // The write shape is CP1's `todos.map(toString).join("\n") + "\n"`.
  const tsSerialized = tsLines.join("\n") + "\n";
  const rustSerialized = rustLines.join("\n") + "\n";
  const serializedEqual = tsSerialized === rustSerialized;

  if (mismatchCount === 0 && serializedEqual) return undefined;

  return {
    at,
    kind: "mismatch",
    tsTodoCount: tsLines.length,
    rustTodoCount: rustLines.length,
    mismatchCount,
    lines,
    linesTruncated: mismatchCount > lines.length,
    serialized: {
      equal: serializedEqual,
      tsHash: shortHash(tsSerialized),
      rustHash: shortHash(rustSerialized),
    },
  };
};

let shadowLogLogged = false;

/** Append one record, truncating the file first when it would exceed the cap. */
const appendShadowRecord = (record: ShadowRecord): void => {
  const path = shadowLogPath();
  const line = `${JSON.stringify(record)}\n`;

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    // Missing file: the append creates it below.
  }
  if (size + Buffer.byteLength(line, "utf8") > MAX_SHADOW_LOG_BYTES) {
    writeFileSync(path, "", { mode: 0o600 });
  }
  appendFileSync(path, line, { mode: 0o600 });
};

/**
 * `THAR_SHADOW=1`: compare the Rust parse of `text` with `todos` and record a
 * bounded, content-free diagnostic on any difference.
 *
 * `limits` must be the effective read limits of the load that produced `todos`
 * — normally the same `ReadLimits` the caller read the file with. Omit it only
 * for a standalone call; the current environment's `getReadLimits()` is then
 * used, and a `THAR_MAX_*` override still cannot cause a spurious rejection.
 *
 * No-op unless the variable is `1`. The todo file is never touched, and nothing
 * here may throw: a broken package or an unwritable cache path only produces one
 * debug line, and the TypeScript result is always what the app keeps using.
 *
 * The record is written **per load**, not once per process: a file that keeps
 * disagreeing appends one record on every load, and the 64 KiB cap eventually
 * truncates the oldest ones. That is deliberate for the CP2 dogfood — the log
 * shows how often a real file mismatches, not just that it once did. Only the
 * `console.warn` summary is once per process (`shadowLogLogged`).
 */
export const shadowCheckTodoFile = (
  text: string,
  todos: readonly Todo[],
  limits?: ReadLimits,
): void => {
  if (!isShadowEnabled()) return;

  try {
    // Inside the `try`: `getReadLimits` rejects an invalid `THAR_MAX_*` and
    // the shadow must never throw into the read path.
    const record = compareWithCore(text, todos, limits ?? getReadLimits());
    if (!record) return;
    appendShadowRecord(record);

    if (!shadowLogLogged) {
      shadowLogLogged = true;
      const detail =
        record.kind === "rejected"
          ? `Rust rejected a file TypeScript loaded (${record.error.code})`
          : `${record.mismatchCount} line(s) differ from TypeScript`;
      console.warn(`thar shadow: ${detail}; see ${shadowLogPath()}`);
    }
  } catch (error) {
    if (!adapterLogged) {
      adapterLogged = true;
      // `errorName`, not `error.message`: a `JSON.parse` failure can quote
      // the input, and the input here is a todo file.
      debugLog(
        `thar shadow: check skipped (${errorName(error)}); the TypeScript ` +
          "result is unchanged",
      );
    }
  }
};

/**
 * Test-only: forget the cached package and the once-per-process log flags.
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
  shadowLogLogged = false;
};
