import { dirname, join } from "node:path";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from "react";
import { debounce } from "../utils/debounce.ts";
import {
  readTodosFromFile,
  writeTodosToFile,
} from "../logic/todo-file-helpers.ts";
import type { Todos } from "../logic/Todos.ts";
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
  todos: [],
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
    todos: [...transformed, ...newInstances],
    recurringCount: newInstances.length,
  };
};

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
  const hasLoadedFileRef = useRef(false);
  const lastWriteTimeRef = useRef(0);

  // Initial load
  useEffect(() => {
    let cancelled = false;
    // Until the file has been read, `todos` is just the empty startup state.
    // Saving it would truncate the real file when the read is slow (the save
    // debounce is shorter than a slow disk access).
    hasLoadedFileRef.current = false;
    readTodosFromFile(filename)
      .then((initialTodos) => {
        if (cancelled) return;
        hasLoadedFileRef.current = true;
        justReadFileFlag.current = true;
        dispatch({ type: "load", todos: [...initialTodos] });
      })
      .catch((error) => {
        if (!cancelled) {
          console.error("Failed to load todos:", error);
        }
      });

    return () => {
      cancelled = true;
    };
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
        try {
          await writeTodosToFile(currentTodos, filename);
        } catch (error) {
          console.error("Failed to save todos:", error);
        } finally {
          lastWriteTimeRef.current = Date.now();
        }
      }, 50),
    [filename],
  );

  // Cancel a pending save only when the debounced function is replaced (for
  // example when `filename` changes) or the provider unmounts. Ordinary todo
  // updates must not cancel the debounce.
  useEffect(() => {
    return () => saveTodos.clear();
  }, [saveTodos]);

  useEffect(() => {
    // Do not persist the empty startup state before the initial load completes.
    if (!hasLoadedFileRef.current) return;
    saveTodos(todos);
  }, [todos, saveTodos]);

  // Watcher effect
  useEffect(() => {
    let cancelled = false;
    let watcher: Deno.FsWatcher | undefined;
    try {
      watcher = Deno.watchFs(filename);
    } catch (error) {
      console.error("Failed to watch file:", error);
    }

    const readTodosDebounced = debounce(async () => {
      try {
        const todosFromFile = await readTodosFromFile(filename);
        if (cancelled) return;
        justReadFileFlag.current = true;
        dispatch({ type: "load", todos: [...todosFromFile] });
        showToaster("File reloaded");
      } catch (error) {
        if (!cancelled) {
          console.error("Failed to reload todos:", error);
        }
      }
    }, 500);

    const processEvents = async () => {
      if (!watcher) return;
      try {
        for await (const event of watcher) {
          if (cancelled) break;
          if (event.kind === "modify") {
            // Prevent write-read loop
            if (Date.now() - lastWriteTimeRef.current < 1000) {
              continue;
            }
            readTodosDebounced();
          }
        }
      } catch (error) {
        if (!cancelled) {
          console.error("Failed to process file events:", error);
        }
      }
    };
    processEvents();

    return () => {
      cancelled = true;
      readTodosDebounced.clear();
      if (watcher) {
        try {
          watcher.close();
        } catch (error) {
          console.error("Failed to close file watcher:", error);
        }
      }
    };
  }, [filename, showToaster]);

  const canUndo = state.history.length > 0;
  const canRedo = state.redoStack.length > 0;

  const setTodos = useCallback((todos: Todos) => {
    dispatch({ type: "set", todos });
  }, []);

  const undo = useCallback(() => {
    if (!canUndo) return;
    dispatch({ type: "undo" });
    showToaster("Undo successful");
  }, [canUndo, showToaster]);

  const redo = useCallback(() => {
    if (!canRedo) return;
    dispatch({ type: "redo" });
    showToaster("Redo successful");
  }, [canRedo, showToaster]);

  const addTodos = useCallback((...texts: string[]): Todo[] => {
    if (texts.length === 0) return [];
    const newTodos = texts.map((text) =>
      new Todo(text).setCreationDate(new Date())
    );
    dispatch({
      type: "mutate",
      updater: (prev) => [...prev, ...newTodos],
    });
    return newTodos;
  }, []);

  const updateTodos = useCallback((
    todosToUpdate: Todo[],
    transform: (todo: Todo) => Todo,
  ) => {
    const idsToUpdate = new Set(todosToUpdate.map((t) => t.id));
    dispatch({
      type: "mutate",
      updater: (prev) => [
        ...prev.map((t) => (idsToUpdate.has(t.id) ? transform(t) : t)),
      ],
    });
  }, []);

  const deleteTodos = useCallback((todosToDelete: Todo[]) => {
    const idsToDelete = new Set(todosToDelete.map((t) => t.id));
    dispatch({
      type: "mutate",
      updater: (prev) => [...prev.filter((t) => !idsToDelete.has(t.id))],
    });
  }, []);

  const toggleTodos = useCallback((todosToToggle: Todo[]) => {
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
  }, [todos, showToaster]);

  const toggleHidden = useCallback((todosToToggle: Todo[]) => {
    updateTodos(todosToToggle, (t) => t.toggleHidden());
  }, [updateTodos]);

  const archiveCompletedTodos = useCallback(async () => {
    const completedTodos = todos.filter((t: Todo) => t.isDone());
    if (completedTodos.length === 0) return;

    // Append to done.txt next to the main file, using the platform separator.
    const doneFile = join(dirname(filename), "done.txt");

    await writeTodosToFile(completedTodos, doneFile, { append: true });

    // Remove completed todos from the current state
    dispatch({
      type: "mutate",
      updater: (prev) => [...prev.filter((t) => !t.isDone())],
    });
  }, [todos, filename]);

  const value = useMemo(
    () => ({
      todos,
      setTodos,
      addTodos,
      updateTodos,
      deleteTodos,
      toggleTodos,
      toggleHidden,
      archiveCompletedTodos,
      undo,
      canUndo,
      redo,
      canRedo,
    }),
    [
      todos,
      setTodos,
      addTodos,
      updateTodos,
      deleteTodos,
      toggleTodos,
      toggleHidden,
      archiveCompletedTodos,
      undo,
      canUndo,
      redo,
      canRedo,
    ],
  );

  return (
    <TodoContext.Provider value={value}>
      {children}
    </TodoContext.Provider>
  );
};
