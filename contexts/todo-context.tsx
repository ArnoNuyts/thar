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
import { writeTodosToFile } from "../logic/todo-file-helpers.ts";
import type { TodoFileRepository } from "../logic/todo-file-repository.ts";
import type { Todos } from "../logic/Todos.ts";
import { Todo } from "../logic/todo.ts";
import { useTodoFileSync } from "../hooks/useTodoFileSync.ts";
import { MAX_TODOS } from "../logic/limits.ts";
import { validateTodoBatch } from "../logic/todo-input.ts";
import { useToaster } from "./toaster-context.tsx";

const NOT_SAVED_READ_ONLY = "Not saved: read-only";

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
): {
  todos: Todos;
  recurringCount: number;
  recurrenceErrors: string[];
} => {
  const newInstances: Todo[] = [];
  const recurrenceErrors: string[] = [];
  const transformed = prev.map((t) => {
    if (idsToToggle.has(t.id)) {
      const { updated, recurring, recurrenceError } = t.toggleState();
      if (recurring) {
        newInstances.push(recurring);
      }
      if (recurrenceError) {
        recurrenceErrors.push(recurrenceError);
      }
      return updated;
    }
    return t;
  });
  return {
    todos: [...transformed, ...newInstances],
    recurringCount: newInstances.length,
    recurrenceErrors: [...new Set(recurrenceErrors)],
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
  repository,
  children,
}: {
  filename: string;
  /** File access port; defaults to the real filesystem repository. */
  repository?: TodoFileRepository;
  children?: React.ReactNode;
}) => {
  const [state, dispatch] = useReducer(
    todoReducer,
    undefined,
    createInitialState,
  );
  const { todos } = state;
  const { showToaster } = useToaster();
  const loadTodos = useCallback((loadedTodos: Todos) => {
    dispatch({ type: "load", todos: loadedTodos });
  }, []);

  const { loadError, readOnly } = useTodoFileSync({
    filename,
    todos,
    onLoad: loadTodos,
    showToaster,
    repository,
  });

  // Tracks the current count so consecutive addTodos calls in one tick cannot
  // race past MAX_TODOS before React re-renders. Syncing in an effect keeps
  // the ref out of the render path (discarded renders cannot corrupt it).
  const todoCountRef = useRef(todos.length);
  useEffect(() => {
    todoCountRef.current = todos.length;
  }, [todos]);

  const notifyReadOnly = useCallback(() => {
    if (readOnly) showToaster(NOT_SAVED_READ_ONLY);
  }, [readOnly, showToaster]);

  const canUndo = state.history.length > 0;
  const canRedo = state.redoStack.length > 0;

  const setTodos = useCallback((todos: Todos) => {
    dispatch({ type: "set", todos });
  }, []);

  const undo = useCallback(() => {
    if (!canUndo) return;
    dispatch({ type: "undo" });
    showToaster(readOnly ? NOT_SAVED_READ_ONLY : "Undo successful");
  }, [canUndo, readOnly, showToaster]);

  const redo = useCallback(() => {
    if (!canRedo) return;
    dispatch({ type: "redo" });
    showToaster(readOnly ? NOT_SAVED_READ_ONLY : "Redo successful");
  }, [canRedo, readOnly, showToaster]);

  const addTodos = useCallback(
    (...texts: string[]): Todo[] => {
      if (texts.length === 0) return [];

      // Defense in depth: validate the whole batch before constructing
      // anything, so a rejected call never partially mutates the list.
      // UI callers validate earlier and catch TodoInputError; programmatic
      // callers get the error so a rejected batch is never silently dropped.
      validateTodoBatch(texts, todoCountRef.current);

      notifyReadOnly();

      const newTodos = texts.map((text) =>
        new Todo(text).setCreationDate(new Date()),
      );
      todoCountRef.current += newTodos.length;
      dispatch({
        type: "mutate",
        updater: (prev) => [...prev, ...newTodos],
      });
      return newTodos;
    },
    [notifyReadOnly],
  );

  const updateTodos = useCallback(
    (todosToUpdate: Todo[], transform: (todo: Todo) => Todo) => {
      const idsToUpdate = new Set(todosToUpdate.map((t) => t.id));
      notifyReadOnly();
      dispatch({
        type: "mutate",
        updater: (prev) => [
          ...prev.map((t) => (idsToUpdate.has(t.id) ? transform(t) : t)),
        ],
      });
    },
    [notifyReadOnly],
  );

  const deleteTodos = useCallback(
    (todosToDelete: Todo[]) => {
      if (todosToDelete.length === 0) return;
      notifyReadOnly();
      const idsToDelete = new Set(todosToDelete.map((t) => t.id));
      dispatch({
        type: "mutate",
        updater: (prev) => [...prev.filter((t) => !idsToDelete.has(t.id))],
      });
    },
    [notifyReadOnly],
  );

  const toggleTodos = useCallback(
    (todosToToggle: Todo[]) => {
      if (todosToToggle.length === 0) return;
      notifyReadOnly();
      const idsToToggle = new Set(todosToToggle.map((t) => t.id));
      // Compute the toast count from the current state; the reducer updater
      // stays pure so StrictMode's double invocation cannot duplicate instances.
      const {
        todos: candidateTodos,
        recurringCount,
        recurrenceErrors,
      } = buildToggledTodos(todos, idsToToggle);

      if (candidateTodos.length > MAX_TODOS) {
        showToaster(`Too many todos; the limit is ${MAX_TODOS}`);
        return;
      }

      dispatch({
        type: "mutate",
        updater: (prev) => buildToggledTodos(prev, idsToToggle).todos,
      });

      if (recurrenceErrors.length > 0) {
        showToaster(recurrenceErrors[0]);
      } else if (!readOnly && recurringCount === 1) {
        showToaster("Recurring todo created");
      } else if (!readOnly && recurringCount > 1) {
        showToaster(`${recurringCount} recurring todos created`);
      }
    },
    [todos, notifyReadOnly, readOnly, showToaster],
  );

  const toggleHidden = useCallback(
    (todosToToggle: Todo[]) => {
      updateTodos(todosToToggle, (t) => t.toggleHidden());
    },
    [updateTodos],
  );

  const archiveCompletedTodos = useCallback(async () => {
    if (readOnly) {
      showToaster(NOT_SAVED_READ_ONLY);
      return;
    }

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
  }, [todos, filename, readOnly, showToaster]);

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
