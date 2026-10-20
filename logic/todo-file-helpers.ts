import { Runtime } from "../utils/runtime.ts";
import { Todo } from "./todo.ts";

const isNotFound = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as NodeJS.ErrnoException).code === "ENOENT";

export async function readTodosFromFile(filename: string) {
  let data: string;
  try {
    data = await Runtime.readTextFile(filename);
  } catch (error) {
    if (isNotFound(error)) {
      await Runtime.writeTextFile(filename, ""); // Create the file if it doesn't exist
      return []; // Return an empty list after creating the file
    }
    throw error;
  }

  return data
    .split("\n")
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
