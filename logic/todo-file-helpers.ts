import { Runtime } from "../utils/runtime.ts";
import { findUnsafeTodoTextCodePoint } from "./control-characters.ts";
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

  return validateTodoFileContent(data, limits)
    .filter((x) => x.trim())
    .map((x) => new Todo(x));
}

export type WriteOptions = {
  append?: boolean;
};

/**
 * Serialize todos only when the result passes the same policy as the reader.
 * This is the last line of defense: an unsafe value that reaches state (for
 * example through an old programmatic caller) must never be persisted.
 */
const serializeTodosForWrite = (todos: Todo[]): string => {
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
  const data = serializeTodosForWrite(todos);
  const limits = getReadLimits();

  // Keep the write invariant aligned with the read path: line length, line
  // count, and byte size must all be acceptable before anything is written.
  validateTodoFileContent(data, limits);
  const bytes = Buffer.byteLength(data, "utf8");
  if (bytes > limits.maxFileBytes) {
    throw new TodoFileTooLargeError(bytes, limits.maxFileBytes);
  }

  await Runtime.writeTextFile(filename, data, writeOptions);
};
