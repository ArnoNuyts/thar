import { Todo } from "./todo.ts";
import { Todos } from "./Todos.ts";
import { IndexType } from "../types/enums.ts";

export type ContextIndexEntry = {
  type: IndexType.context;
  todoCount: number;
  contextName: string;
};

export type TodoIndexEntry = {
  type: IndexType.todo;
  todo: Todo;
};

export type IndexEntry = ContextIndexEntry | TodoIndexEntry;

export const createIndexes = (todos: Todos): IndexEntry[] => {
  const indexArray: IndexEntry[] = [];
  let prevTodo: Todo | null = null;
  let currHeader: ContextIndexEntry | null = null;
  let currHeaderTodoCounter = 0;

  for (const todo of todos) {
    if (!todo?.id) {
      continue;
    }

    const currentContext = todo?.contexts?.values().next().value;
    const prevContext = prevTodo?.contexts?.values().next().value;

    if (prevTodo === null || currentContext != prevContext) {
      if (currHeader) {
        currHeader.todoCount = currHeaderTodoCounter;
        currHeaderTodoCounter = 0;
      }

      currHeader = {
        type: IndexType.context,
        todoCount: 0,
        contextName: currentContext ?? "None",
      };
      indexArray.push(currHeader);
    }

    indexArray.push({ type: IndexType.todo, todo });
    currHeaderTodoCounter++;
    prevTodo = todo;
  }

  if (currHeader) {
    currHeader.todoCount = currHeaderTodoCounter;
  }

  return indexArray;
};
