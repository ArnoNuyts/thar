import { Runtime } from "../utils/runtime.ts";
import {
  getReadLimits,
  type ReadLimits,
  TodoFileTooLargeError,
} from "./limits.ts";
import { Todo } from "./todo.ts";
import { validateTodoFileContent } from "./todo-file-validation.ts";

const isNotFound = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as NodeJS.ErrnoException).code === "ENOENT";

const createEmptyFile = async (filename: string) => {
  await Runtime.writeTextFile(filename, ""); // Create the file if it doesn't exist
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
      await createEmptyFile(filename);
      return []; // Return an empty list after creating the file
    }
    throw error;
  }

  let data: string;
  try {
    data = await Runtime.readTextFile(filename);
  } catch (error) {
    if (isNotFound(error)) {
      await createEmptyFile(filename);
      return [];
    }
    throw error;
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

export const writeTodosToFile = async (
  todos: Todo[],
  filename: string,
  writeOptions: WriteOptions | undefined = undefined,
) =>
  await Runtime.writeTextFile(
    filename,
    todos.map((y) => y.toString()).join("\n") + "\n",
    writeOptions,
  );
