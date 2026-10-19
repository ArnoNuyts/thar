import { Todo } from "./todo.ts";
import { IndexType } from "../types/enums.ts";

export type ContextIndexEntry = {
  type: IndexType.context;
  todoCount: number;
  contextName: string;
};

export type TodoIndexEntry = {
  type: IndexType.todo;
  todo: Todo;
  /** 1-based position among todo entries, ignoring context headers. */
  number: number;
};

export type IndexEntry = ContextIndexEntry | TodoIndexEntry;

type TodoGroup = {
  context: string | undefined;
  todos: Todo[];
};

export const createIndexes = (todos: Todo[]): IndexEntry[] => {
  // Group consecutive todos by context first so headers are emitted once with
  // their final count instead of being mutated after insertion.
  const groups: TodoGroup[] = [];

  for (const todo of todos) {
    const context = todo.contexts.values().next().value;
    const currentGroup = groups[groups.length - 1];

    if (!currentGroup || currentGroup.context !== context) {
      groups.push({ context, todos: [todo] });
    } else {
      currentGroup.todos.push(todo);
    }
  }

  const indexArray: IndexEntry[] = [];
  let number = 0;

  for (const group of groups) {
    indexArray.push({
      type: IndexType.context,
      todoCount: group.todos.length,
      contextName: group.context ?? "None",
    });

    for (const todo of group.todos) {
      indexArray.push({ type: IndexType.todo, todo, number: ++number });
    }
  }

  return indexArray;
};
