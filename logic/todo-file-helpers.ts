import { Todo } from "./todo.ts";

export async function readTodosFromFile(filename: string) {
  let data: string;
  try {
    data = await Deno.readTextFile(filename);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      await Deno.writeTextFile(filename, ""); // Create the file if it doesn't exist
      return []; // Return an empty list after creating the file
    }
    throw error;
  }

  return data
    .split("\n")
    .filter((x) => x.trim())
    .map((x) => new Todo(x));
}

export const writeTodosToFile = async (
  todos: Todo[],
  filename: string,
  writeOptions: Deno.WriteFileOptions | undefined = undefined,
) =>
  await Deno.writeTextFile(
    filename,
    todos.map((y) => y.toString()).join("\n") + "\n",
    writeOptions,
  );
