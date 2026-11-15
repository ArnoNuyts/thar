import { Runtime } from "../utils/runtime.ts";
import { findUnsafeTodoTextCodePoint } from "./control-characters.ts";
import { serializeTodosWithCore, shadowCheckTodoFile } from "./core-wasm.ts";
import {
  getReadLimits,
  type ReadLimits,
  TodoControlCharacterError,
  TodoFileTooLargeError,
} from "./limits.ts";
import { Todo } from "./todo.ts";
import { validateTodoFileContent } from "./todo-file-validation.ts";

const hasErrorCode = (error: unknown, code: string) =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as NodeJS.ErrnoException).code === code;

const isNotFound = (error: unknown) => hasErrorCode(error, "ENOENT");

/**
 * Create a missing todo file without replacing content a concurrent sync
 * client may have written between our failed stat/read and this call.
 */
const createEmptyFileExclusively = async (filename: string) => {
  try {
    await Runtime.writeTextFile(filename, "", { exclusive: true });
  } catch (error) {
    // Another writer won the race; its content will be read below.
    if (!hasErrorCode(error, "EEXIST")) throw error;
  }
};

export async function readTodosFromFile(
  filename: string,
  limits: ReadLimits = getReadLimits(),
) {
  try {
    // Reject an oversized file before it is read into memory. `size` may be
    // absent in tests that provide a minimal Runtime.stat mock.
    const stats = await Runtime.stat(filename);
    if (typeof stats.size === "number" && stats.size > limits.maxFileBytes) {
      throw new TodoFileTooLargeError(stats.size, limits.maxFileBytes);
    }
  } catch (error) {
    if (isNotFound(error)) {
      await createEmptyFileExclusively(filename);
      // Fall through to the read: a concurrent sync client may have created
      // the file with content in the meantime.
    } else {
      throw error;
    }
  }

  let data: string;
  try {
    data = await Runtime.readTextFile(filename);
  } catch (error) {
    if (isNotFound(error)) {
      await createEmptyFileExclusively(filename);
      data = await Runtime.readTextFile(filename);
    } else {
      throw error;
    }
  }

  // Stat can race with a growing file (or be mocked), so re-check the bytes
  // that were actually decoded.
  const actualBytes = Buffer.byteLength(data, "utf8");
  if (actualBytes > limits.maxFileBytes) {
    throw new TodoFileTooLargeError(actualBytes, limits.maxFileBytes);
  }

  const todos = validateTodoFileContent(data, limits)
    .filter((x) => x.trim())
    .map((x) => new Todo(x));

  // Development-only differential check against the Rust core; a no-op unless
  // THAR_SHADOW=1. It never changes `todos` and never throws (see
  // `logic/core-wasm.ts`), so the TypeScript result stays the app's state. The
  // effective limits are passed through: Rust must judge this file by the same
  // `THAR_MAX_*` values the TypeScript reader just used.
  shadowCheckTodoFile(data, todos, limits);

  return todos;
}

export type WriteOptions = {
  append?: boolean;
};

/**
 * Serialize todos only when the result passes the same policy as the reader.
 * This is the last line of defense: an unsafe value that reaches state (for
 * example through an old programmatic caller) must never be persisted.
 *
 * Exported so the CP1 contract serializes through this exact function (the
 * write-time control-character guard) instead of re-implementing it.
 */
export const serializeTodosForWrite = (todos: Todo[]): string => {
  const lines = todos.map((todo) => todo.toString());

  for (let index = 0; index < lines.length; index++) {
    const codePoint = findUnsafeTodoTextCodePoint(lines[index]);
    if (codePoint !== undefined) {
      throw new TodoControlCharacterError(index + 1, codePoint);
    }
  }

  return lines.join("\n") + "\n";
};

export const writeTodosToFile = async (
  todos: Todo[],
  filename: string,
  writeOptions: WriteOptions | undefined = undefined,
) => {
  // The TypeScript serializer is always computed: it is the oracle the CP4
  // dual-write gate compares against and the text written when the Rust path is
  // off, unavailable, or disagrees. In `ts` mode this is the only serialization
  // that happens (the adapter returns before loading anything).
  const tsText = serializeTodosForWrite(todos);
  const data = chooseWriteText(todos, tsText);
  const limits = getReadLimits();

  // Keep the write invariant aligned with the read path: line length, line
  // count, and byte size must all be acceptable before anything is written.
  validateTodoFileContent(data, limits);
  const bytes = Buffer.byteLength(data, "utf8");
  if (bytes > limits.maxFileBytes) {
    throw new TodoFileTooLargeError(bytes, limits.maxFileBytes);
  }

  // Exactly one write, whether the text came from Rust or TypeScript. The
  // append path (`done.txt`) therefore appends once.
  await Runtime.writeTextFile(filename, data, writeOptions);
};

/**
 * Whether the first dual-write mismatch has been reported.
 *
 * Saves are user-driven and repeat: a package that serializes differently would
 * otherwise log on every save. One line per process is enough to notice, and it
 * is content-free.
 */
let writeMismatchLogged = false;

/** Test-only: forget the once-per-process mismatch log. @internal */
export const resetWriteFallbackForTests = (): void => {
  writeMismatchLogged = false;
};

/** Offset of the first byte where two UTF-8 buffers differ. */
const firstByteDifference = (left: Buffer, right: Buffer): number => {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index++) {
    if (left[index] !== right[index]) return index;
  }
  return shared;
};

/**
 * Pick the text to write: the TypeScript oracle, or Rust's copy of the same
 * bytes when `THAR_CORE=rust` and the two agree exactly.
 *
 * The rule is deliberately narrow:
 *
 * - `ts` mode, an unavailable adapter, a thrown error, a malformed envelope and
 *   any rejection (including a guard rejection) all keep `tsText`;
 * - Rust's text is **compared**, not written: when
 *   `Buffer.from(rust).equals(Buffer.from(ts))` the TypeScript bytes still go to
 *   disk. A byte compare, not a string compare, because the two strings can be
 *   equal as text but differ in bytes only through a bug, and this gate exists
 *   to catch bugs;
 * - a mismatch logs one bounded line (lengths and the first differing byte) and
 *   keeps `tsText`.
 *
 * A Rust-only guard rejection is unreachable unless the WASM package disagrees
 * with the already-run TypeScript guard, so blocking the save would be wrong:
 * the user's accepted line is written from `tsText` and the divergence is
 * logged once.
 *
 * Either way exactly one text reaches the single write below; the file never
 * contains a mix.
 */
const chooseWriteText = (todos: Todo[], tsText: string): string => {
  const result = serializeTodosWithCore(todos);
  if (result === undefined) return tsText;
  if (!result.ok) return tsText;

  const rustBytes = Buffer.from(result.text, "utf8");
  const tsBytes = Buffer.from(tsText, "utf8");
  if (rustBytes.equals(tsBytes)) return tsText;

  if (!writeMismatchLogged) {
    writeMismatchLogged = true;
    console.debug(
      `thar core: serializeFile differs from the TypeScript serializer ` +
        `(${rustBytes.length} vs ${tsBytes.length} bytes, first difference at ` +
        `byte ${firstByteDifference(rustBytes, tsBytes)}); ` +
        "using the TypeScript text",
    );
  }
  return tsText;
};
