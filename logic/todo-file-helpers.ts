import { Todo } from "./todo.ts";
import { Todos } from "./Todos.ts";

export async function readTodosFromFile(filename: string) {
  try {
    // Read the file content
    const data = await Deno.readTextFile(filename);

    return new Todos(
      ...data.split("\n").filter((x) => x.trim()).map((x) => new Todo(x)),
    );

    // deno-lint-ignore no-explicit-any
  } catch (err: any) {
    console.error(`Error reading file "${filename}":`, err.message);
    Deno.exit(1);
  }
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
