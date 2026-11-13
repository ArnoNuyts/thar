import type { Todos } from "./Todos.ts";
import { readTodosFromFile, writeTodosToFile } from "./todo-file-helpers.ts";
import { Runtime, type FsWatcher } from "../utils/runtime.ts";

/**
 * Port for todo file access used by `useTodoFileSync`.
 *
 * The sync hook depends on this interface rather than the concrete file
 * helpers, so callers can inject a repository (tests, alternative storage)
 * without patching the runtime adapter.
 */
export interface TodoFileRepository {
  load(filename: string): Promise<Todos>;
  save(filename: string, todos: Todos): Promise<void>;
  watch(filename: string): FsWatcher;
}

/**
 * Default repository backed by the real filesystem through the runtime
 * adapter. Members are resolved on each call so existing runtime mocks keep
 * working through this default.
 */
export const createTodoFileRepository = (): TodoFileRepository => ({
  load: (filename) => readTodosFromFile(filename),
  save: (filename, todos) => writeTodosToFile(todos, filename),
  watch: (filename) => Runtime.watchFs(filename),
});

export const todoFileRepository: TodoFileRepository =
  createTodoFileRepository();
