import { dirname, join } from "node:path";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { debounce } from "../utils/debounce.ts";
import { toBoundedDisplayMessage } from "../logic/display-safety.ts";
import {
  readTodosFromFile,
  writeTodosToFile,
} from "../logic/todo-file-helpers.ts";
import type { Todos } from "../logic/Todos.ts";
import { Todo } from "../logic/todo.ts";
import { Runtime, type FsWatcher } from "../utils/runtime.ts";
import { useToaster } from "./toaster-context.tsx";

export interface TodoContextType {
  todos: Todos;
  setTodos: (todos: Todos) => void;
  addTodos: (...texts: string[]) => Todo[];
  updateTodos: (todosToUpdate: Todo[], transform: (todo: Todo) => Todo) => void;
  deleteTodos: (todosToDelete: Todo[]) => void;
  toggleTodos: (todosToToggle: Todo[]) => void;
  toggleHidden: (todosToToggle: Todo[]) => void;
  archiveCompletedTodos: () => Promise<void>;
  undo: () => void;
  canUndo: boolean;
  redo: () => void;
  canRedo: boolean;
  /** Last read failure, bounded and safe to display; undefined when healthy. */
  loadError: string | undefined;
  /** True while the last load/reload failed; mutations must not be saved. */
  readOnly: boolean;
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
  const justReadFileRef = useRef<Todos | null>(null);
  const hasLoadedFileRef = useRef(false);
  const lastWriteTimeRef = useRef(0);
  const [loadError, setLoadErrorState] = useState<string | undefined>(
    undefined,
  );
  const loadErrorRef = useRef<string | undefined>(undefined);
  const readOnly = loadError !== undefined;

  const setLoadError = useCallback((message: string | undefined) => {
    loadErrorRef.current = message;
    setLoadErrorState(message);
  }, []);

  // Initial load
  useEffect(() => {
    let cancelled = false;
    // Until the file has been read, `todos` is just the empty startup state.
    // Saving it would truncate the real file when the read is slow (the save
    // debounce is shorter than a slow disk access).
    hasLoadedFileRef.current = false;
    setLoadError(undefined);
    readTodosFromFile(filename)
      .then((initialTodos) => {
        if (cancelled) return;
        const loadedTodos = [...initialTodos];
        hasLoadedFileRef.current = true;
        justReadFileRef.current = loadedTodos;
        setLoadError(undefined);
        dispatch({ type: "load", todos: loadedTodos });
      })
      .catch((error) => {
        if (cancelled) return;
        // Stay unloaded and read-only so the empty startup state (or stale
        // state from a previous file) cannot be written over the file.
        const message = toBoundedDisplayMessage(error);
        setLoadError(message);
        showToaster(message);
      });

    return () => {
      cancelled = true;
    };
  }, [filename, setLoadError, showToaster]);

  // Save effect
  const saveTodos = useMemo(
    () =>
      debounce(async (currentTodos: Todos) => {
        // A failed load/reload puts the provider in read-only mode until a
        // later read succeeds. Check at execution time too: a save scheduled
        // just before the failure must not overwrite the rejected file.
        if (loadErrorRef.current) return;
        if (justReadFileRef.current === currentTodos) {
          justReadFileRef.current = null;
          return;
        }
        lastWriteTimeRef.current = Date.now();
        try {
          await writeTodosToFile(currentTodos, filename);
        } catch (error) {
          console.error(
            "Failed to save todos:",
            toBoundedDisplayMessage(error),
          );
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
    // Do not persist the empty startup state before the initial load completes,
    // and never persist stale in-memory todos while the file is rejected.
    if (!hasLoadedFileRef.current || readOnly) return;
    saveTodos(todos);
  }, [todos, saveTodos, readOnly]);

  // Watcher effect
  useEffect(() => {
    let cancelled = false;
    let watcher: FsWatcher | undefined;
    try {
      watcher = Runtime.watchFs(filename);
    } catch (error) {
      console.error("Failed to watch file:", error);
    }

    const readTodosDebounced = debounce(async () => {
      try {
        const todosFromFile = await readTodosFromFile(filename);
        if (cancelled) return;
        const loadedTodos = [...todosFromFile];
        hasLoadedFileRef.current = true;
        justReadFileRef.current = loadedTodos;
        setLoadError(undefined);
        dispatch({ type: "load", todos: loadedTodos });
        showToaster("File reloaded");
      } catch (error) {
        if (cancelled) return;
        // Keep the last known good list, but stop saving it until the file is
        // valid again. Cancel a pending save from before the failure.
        saveTodos.clear();
        const message = toBoundedDisplayMessage(error);
        setLoadError(message);
        showToaster(message);
      }
    }, 500);

    const processEvents = async () => {
      if (!watcher) return;
      try {
        for await (const event of watcher) {
          if (cancelled) break;
          // Ignore startup events (for example creating a missing todo file)
          // until the initial load has settled. Once a load has failed, keep
          // processing so a fixed file can recover the provider.
          if (!hasLoadedFileRef.current && !loadErrorRef.current) continue;
          if (event.kind === "modify" || event.kind === "rename") {
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
  }, [filename, setLoadError, saveTodos, showToaster]);

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
      new Todo(text).setCreationDate(new Date()),
    );
    dispatch({
      type: "mutate",
      updater: (prev) => [...prev, ...newTodos],
    });
    return newTodos;
  }, []);

  const updateTodos = useCallback(
    (todosToUpdate: Todo[], transform: (todo: Todo) => Todo) => {
      const idsToUpdate = new Set(todosToUpdate.map((t) => t.id));
      dispatch({
        type: "mutate",
        updater: (prev) => [
          ...prev.map((t) => (idsToUpdate.has(t.id) ? transform(t) : t)),
        ],
      });
    },
    [],
  );

  const deleteTodos = useCallback((todosToDelete: Todo[]) => {
    const idsToDelete = new Set(todosToDelete.map((t) => t.id));
    dispatch({
      type: "mutate",
      updater: (prev) => [...prev.filter((t) => !idsToDelete.has(t.id))],
    });
  }, []);

  const toggleTodos = useCallback(
    (todosToToggle: Todo[]) => {
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
    },
    [todos, showToaster],
  );

  const toggleHidden = useCallback(
    (todosToToggle: Todo[]) => {
      updateTodos(todosToToggle, (t) => t.toggleHidden());
    },
    [updateTodos],
  );

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
      loadError,
      readOnly,
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
      loadError,
      readOnly,
    ],
  );

  return <TodoContext.Provider value={value}>{children}</TodoContext.Provider>;
};
