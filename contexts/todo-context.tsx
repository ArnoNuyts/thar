import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from "react";
import { debounce } from "@std/async/debounce";
import {
  readTodosFromFile,
  writeTodosToFile,
} from "../logic/todo-file-helpers.ts";
import { Todos } from "../logic/Todos.ts";
import { Todo } from "../logic/todo.ts";
import { useToaster } from "./toaster-context.tsx";

export interface TodoContextType {
  todos: Todos;
  setTodos: (todos: Todos) => void;
  addTodos: (...texts: string[]) => Todo[];
  updateTodos: (
    todosToUpdate: Todo[],
    transform: (todo: Todo) => Todo,
  ) => void;
  deleteTodos: (todosToDelete: Todo[]) => void;
  toggleTodos: (todosToToggle: Todo[]) => void;
  toggleHidden: (todosToToggle: Todo[]) => void;
  archiveCompletedTodos: () => Promise<void>;
  undo: () => void;
  canUndo: boolean;
  redo: () => void;
  canRedo: boolean;
}

interface TodoHistoryState {
  todos: Todos;
  history: Todos[];
  redoStack: Todos[];
}

type TodoAction =
  | { type: "load"; todos: Todos }
  | { type: "set"; todos: Todos }
  | { type: "mutate"; updater: (todos: Todos) => Todos }
  | { type: "undo" }
  | { type: "redo" };

const createInitialState = (): TodoHistoryState => ({
  todos: new Todos(),
  history: [],
  redoStack: [],
});

const todoReducer = (
  state: TodoHistoryState,
  action: TodoAction,
): TodoHistoryState => {
  switch (action.type) {
    case "load":
      return { todos: action.todos, history: [], redoStack: [] };
    case "set":
      return { ...state, todos: action.todos };
    case "mutate": {
      // The updater runs against the latest state, so consecutive mutations in
      // the same tick each snapshot the exact state produced before them.
      const nextTodos = action.updater(state.todos);
      if (nextTodos === state.todos) return state;
      return {
        todos: nextTodos,
        history: [...state.history, state.todos],
        redoStack: [],
      };
    }
    case "undo": {
      if (state.history.length === 0) return state;
      const previousTodos = state.history[state.history.length - 1];
      return {
        todos: previousTodos,
        history: state.history.slice(0, -1),
        redoStack: [...state.redoStack, state.todos],
      };
    }
    case "redo": {
      if (state.redoStack.length === 0) return state;
      const nextTodos = state.redoStack[state.redoStack.length - 1];
      return {
        todos: nextTodos,
        history: [...state.history, state.todos],
        redoStack: state.redoStack.slice(0, -1),
      };
    }
  }
};

export const TodoContext = createContext<TodoContextType | undefined>(
  undefined,
);

export const useTodo = () => {
  const context = useContext(TodoContext);
  if (!context) {
    throw new Error("useTodo must be used within a TodoProvider");
  }
  return context;
};

export const TodoProvider = ({
  filename,
  children,
}: {
  filename: string;
  children?: React.ReactNode;
}) => {
  const [state, dispatch] = useReducer(
    todoReducer,
    undefined,
    createInitialState,
  );
  const { todos } = state;
  const { showToaster } = useToaster();
  const justReadFileFlag = useRef(false);
  const lastWriteTimeRef = useRef(0);

  // Initial load
  useEffect(() => {
    readTodosFromFile(filename).then((initialTodos) => {
      justReadFileFlag.current = true;
      dispatch({ type: "load", todos: new Todos(...initialTodos) });
    });
  }, [filename]);

  // Save effect
  const saveTodos = useMemo(
    () =>
      debounce(async (currentTodos: Todos) => {
        if (justReadFileFlag.current) {
          justReadFileFlag.current = false;
          return;
        }
        lastWriteTimeRef.current = Date.now();
        await writeTodosToFile(currentTodos, filename);
        lastWriteTimeRef.current = Date.now();
      }, 50),
    [filename],
  );

  useEffect(() => {
    saveTodos(todos);
  }, [todos, saveTodos]);

  // Watcher effect
  useEffect(() => {
    let watcher: Deno.FsWatcher | undefined;
    try {
      watcher = Deno.watchFs(filename);
    } catch (error) {
      console.error("Failed to watch file:", error);
    }

    const readTodosDebounced = debounce(async () => {
      justReadFileFlag.current = true;
      const todosFromFile = await readTodosFromFile(filename);
      dispatch({ type: "load", todos: new Todos(...todosFromFile) });
      showToaster("File reloaded");
    }, 500);

    const processEvents = async () => {
      if (!watcher) return;
      for await (const event of watcher) {
        if (event.kind === "modify") {
          // Prevent write-read loop
          if (Date.now() - lastWriteTimeRef.current < 1000) {
            continue;
          }
          readTodosDebounced();
        }
      }
    };
    processEvents();

    return () => {
      if (watcher) {
        watcher.close();
      }
    };
  }, [filename]);

  const setTodos = (todos: Todos) => {
    dispatch({ type: "set", todos });
  };

  const undo = () => {
    if (state.history.length === 0) return;
    dispatch({ type: "undo" });
    showToaster("Undo successful");
  };

  const redo = () => {
    if (state.redoStack.length === 0) return;
    dispatch({ type: "redo" });
    showToaster("Redo successful");
  };

  const addTodos = (...texts: string[]): Todo[] => {
    if (texts.length === 0) return [];
    const newTodos = texts.map((text) =>
      new Todo(text).setCreationDate(new Date())
    );
    dispatch({
      type: "mutate",
      updater: (prev) => new Todos(...prev, ...newTodos),
    });
    return newTodos;
  };

  const updateTodos = (
    todosToUpdate: Todo[],
    transform: (todo: Todo) => Todo,
  ) => {
    const idsToUpdate = new Set(todosToUpdate.map((t) => t.id));
    dispatch({
      type: "mutate",
      updater: (prev) =>
        new Todos(
          ...prev.map((t) => (idsToUpdate.has(t.id) ? transform(t) : t)),
        ),
    });
  };

  const deleteTodos = (todosToDelete: Todo[]) => {
    const idsToDelete = new Set(todosToDelete.map((t) => t.id));
    dispatch({
      type: "mutate",
      updater: (prev) =>
        new Todos(...prev.filter((t) => !idsToDelete.has(t.id))),
    });
  };

  const buildToggledTodos = (
    prev: Todos,
    idsToToggle: Set<symbol>,
  ): { todos: Todos; recurringCount: number } => {
    const newInstances: Todo[] = [];
    const transformed = prev.map((t) => {
      if (idsToToggle.has(t.id)) {
        const { updated, recurring } = t.toggleState();
        if (recurring) {
          newInstances.push(recurring);
        }
        return updated;
      }
      return t;
    });
    return {
      todos: new Todos(...transformed, ...newInstances),
      recurringCount: newInstances.length,
    };
  };

  const toggleTodos = (todosToToggle: Todo[]) => {
    const idsToToggle = new Set(todosToToggle.map((t) => t.id));
    // Compute the toast count from the current state; the reducer updater
    // stays pure so StrictMode's double invocation cannot duplicate instances.
    const { recurringCount } = buildToggledTodos(todos, idsToToggle);

    dispatch({
      type: "mutate",
      updater: (prev) => buildToggledTodos(prev, idsToToggle).todos,
    });

    if (recurringCount === 1) {
      showToaster("Recurring todo created");
    } else if (recurringCount > 1) {
      showToaster(`${recurringCount} recurring todos created`);
    }
  };

  const toggleHidden = (todosToToggle: Todo[]) => {
    updateTodos(todosToToggle, (t) => t.toggleHidden());
  };

  const archiveCompletedTodos = async () => {
    const completedTodos = todos.filter((t: Todo) => t.isDone());
    if (completedTodos.length === 0) return;

    // Append to done.txt
    // Assuming done.txt is in the same directory as the main file
    const separator = filename.includes("\\") ? "\\" : "/";
    const lastIndex = filename.lastIndexOf(separator);
    let doneFile = "done.txt";

    if (lastIndex !== -1) {
      const dir = filename.substring(0, lastIndex);
      doneFile = `${dir}${separator}done.txt`;
    }

    await writeTodosToFile(completedTodos, doneFile, {
      append: true,
      create: true,
    });

    // Remove completed todos from the current state
    dispatch({
      type: "mutate",
      updater: (prev) => new Todos(...prev.filter((t) => !t.isDone())),
    });
  };

  return (
    <TodoContext.Provider
      value={{
        todos,
        setTodos,
        addTodos,
        updateTodos,
        deleteTodos,
        toggleTodos,
        toggleHidden,
        archiveCompletedTodos,
        undo,
        canUndo: state.history.length > 0,
        redo,
        canRedo: state.redoStack.length > 0,
      }}
    >
      {children}
    </TodoContext.Provider>
  );
};
