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
import type { Todo } from "./todo.ts";

/**
 * Opt-in bridge to the Rust core compiled to WebAssembly (CP2b).
 *
 * The TypeScript implementation is still the source of truth at CP2: nothing
 * here changes what the TUI displays, saves, or exports. The module offers two
 * development-only entry points:
 *
 * - {@link parseFileWithCore}, a thin batch adapter over `thar-wasm`'s
 *   `parseFile`;
 * - {@link shadowCheckTodoFile}, the `THAR_SHADOW=1` differential check that
 *   compares Rust against the already-parsed TypeScript result.
 *
 * Both are defensive: a missing, unbuildable or broken package, a malformed
 * envelope, and a rejected `today` all resolve to `undefined` plus at most one
 * debug log. Nothing here may throw into the TUI, and nothing here writes to
 * the todo file.
 *
 * The package is loaded with `createRequire` and a runtime path, never with a
 * static `import`, so `npm run build`, `npm test` and `npm run check` work in a
 * clean checkout where `crates/thar-wasm/pkg/` (gitignored) does not exist.
 * Build it for local experiments with:
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
 * Explicit package entry (`THAR_CORE_WASM`), or the two checkout-relative
 * locations that work from `logic/` in a dev run and from `dist/` after
 * `vite build`.
 */
const packageCandidates = (): string[] => {
  const override = process.env.THAR_CORE_WASM;
  if (override) return [resolve(override)];
  return [
    join(process.cwd(), PACKAGE_ENTRY),
    join(resolve(MODULE_DIR, ".."), PACKAGE_ENTRY),
  ];
};

/** `undefined` = not tried yet, `null` = tried and unavailable. */
let coreModule: CoreModule | null | undefined;
let packageLogged = false;
let adapterLogged = false;

const debugOnce = (message: string): void => {
  console.debug(message);
};

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
        debugOnce(
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
    debugOnce(
      "thar core: WASM package not built; using the TypeScript core " +
        "(build crates/thar-wasm/pkg with wasm-pack to enable the shadow check)",
    );
  }
  return null;
};

const isCoreTodoRecord = (value: unknown): value is CoreTodoRecord =>
  typeof value === "object" && value !== null && "toString" in value;

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
    return typeof error === "object" && error !== null && "code" in error;
  }
  return false;
};

/**
 * Parse `text` with the Rust core, using default read limits.
 *
 * `today` is the local calendar day (`YYYY-MM-DD`). Returns `undefined` when
 * the package is unavailable or the call fails for any reason; it never throws.
 * The result is exactly the JSON envelope `thar-wasm` documents, parsed.
 */
export const parseFileWithCore = (
  text: string,
  today: string,
): CoreParseResult | undefined => {
  const core = loadCoreModule();
  if (!core) return undefined;

  try {
    const parsed: unknown = JSON.parse(core.parseFile(text, today));
    if (!isCoreParseResult(parsed)) {
      if (!adapterLogged) {
        adapterLogged = true;
        debugOnce("thar core: ignoring a malformed parseFile envelope");
      }
      return undefined;
    }
    return parsed;
  } catch (error) {
    if (!adapterLogged) {
      adapterLogged = true;
      debugOnce(
        `thar core: parseFile failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
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
 */
export const shadowLogPath = (): string => {
  const override = process.env.THAR_SHADOW_LOG;
  if (override) return resolve(override);

  const xdg = process.env.XDG_CACHE_HOME;
  const base =
    xdg && xdg.length > 0
      ? xdg
      : process.platform === "darwin"
        ? join(homedir(), "Library", "Caches")
        : process.platform === "win32"
          ? (process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"))
          : join(homedir(), ".cache");
  return join(base, "thar", "shadow.log");
};

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
 * Returns `undefined` when the two agree or when the Rust package is
 * unavailable. Only per-todo `toString`/`hash` and the whole-file serialized
 * bytes are compared; that is what CP1 freezes, and it keeps the check
 * independent of the ambient clock's sub-day drift.
 */
const compareWithCore = (
  text: string,
  todos: readonly Todo[],
): ShadowRecord | undefined => {
  const parsed = parseFileWithCore(text, todayFromClock());
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
 * No-op unless the variable is `1`. The todo file is never touched, and nothing
 * here may throw: a broken package or an unwritable cache path only produces one
 * debug line, and the TypeScript result is always what the app keeps using.
 */
export const shadowCheckTodoFile = (
  text: string,
  todos: readonly Todo[],
): void => {
  if (!isShadowEnabled()) return;

  try {
    const record = compareWithCore(text, todos);
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
      debugOnce(
        `thar shadow: check skipped: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
};

/**
 * Test-only: forget the cached package and the once-per-process log flags.
 *
 * Production code never calls this; tests need it because the module cache and
 * the log-once guards outlive a single test.
 *
 * @internal
 */
export const resetCoreBridgeForTests = (): void => {
  coreModule = undefined;
  packageLogged = false;
  adapterLogged = false;
  shadowLogLogged = false;
};
