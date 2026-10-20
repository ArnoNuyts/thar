import { useCallback, useMemo, useState } from "react";
import type { Todos } from "../logic/Todos.ts";
import { Todo } from "../logic/todo.ts";
import { TodoContext } from "../contexts/todo-context.tsx";
import { useToaster } from "../contexts/toaster-context.tsx";

// Mock TodoProvider that doesn't use file system
export const MockTodoProvider = ({
  children,
  initialTodos = [],
  onTodosChange,
}: {
  children: React.ReactNode;
  initialTodos?: Todo[];
  onTodosChange?: (todos: Todos) => void;
}) => {
  const [todos, setTodos] = useState<Todos>([...initialTodos]);
  const [history, setHistory] = useState<Todos[]>([]);
  const [redoStack, setRedoStack] = useState<Todos[]>([]);
  const { showToaster } = useToaster();

  const internalSetTodos = useCallback(
    (newTodos: Todos) => {
      setTodos(newTodos);
      if (onTodosChange) {
        onTodosChange(newTodos);
      }
    },
    [onTodosChange],
  );

  const pushHistory = useCallback(() => {
    setHistory((prev) => [...prev, todos]);
    setRedoStack([]);
  }, [todos]);

  const undo = useCallback(() => {
    if (history.length === 0) return;
    const previousTodos = history[history.length - 1];
    setHistory((prev) => prev.slice(0, -1));
    setRedoStack((prev) => [...prev, todos]);
    internalSetTodos(previousTodos);
  }, [history, todos, internalSetTodos]);

  const redo = useCallback(() => {
    if (redoStack.length === 0) return;
    const nextTodos = redoStack[redoStack.length - 1];
    setRedoStack((prev) => prev.slice(0, -1));
    setHistory((prev) => [...prev, todos]);
    internalSetTodos(nextTodos);
  }, [redoStack, todos, internalSetTodos]);

  const addTodos = useCallback(
    (...texts: string[]): Todo[] => {
      if (texts.length === 0) return [];
      pushHistory();
      const newTodos = texts.map((text) =>
        new Todo(text).setCreationDate(new Date()),
      );
      internalSetTodos([...todos, ...newTodos]);
      return newTodos;
    },
    [pushHistory, todos, internalSetTodos],
  );

  const deleteTodos = useCallback(
    (todosToDelete: Todo[]) => {
      pushHistory();
      const idsToDelete = new Set(todosToDelete.map((t) => t.id));
      const newTodos = todos.filter((t: Todo) => !idsToDelete.has(t.id));
      internalSetTodos([...newTodos]);
    },
    [pushHistory, todos, internalSetTodos],
  );

  const toggleTodos = useCallback(
    (todosToToggle: Todo[]) => {
      pushHistory();
      const idsToToggle = new Set(todosToToggle.map((t) => t.id));
      const newInstances: Todo[] = [];

      const transformed = todos.map((t) => {
        if (idsToToggle.has(t.id)) {
          const { updated, recurring } = t.toggleState();
          if (recurring) {
            newInstances.push(recurring);
          }
          return updated;
        }
        return t;
      });

      internalSetTodos([...transformed, ...newInstances]);

      if (newInstances.length === 1) {
        showToaster("Recurring todo created");
      } else if (newInstances.length > 1) {
        showToaster(`${newInstances.length} recurring todos created`);
      }
    },
    [pushHistory, todos, internalSetTodos, showToaster],
  );

  const updateTodos = useCallback(
    (todosToUpdate: Todo[], transform: (todo: Todo) => Todo) => {
      pushHistory();
      const idsToUpdate = new Set(todosToUpdate.map((t) => t.id));
      internalSetTodos([
        ...todos.map((t) => (idsToUpdate.has(t.id) ? transform(t) : t)),
      ]);
    },
    [pushHistory, todos, internalSetTodos],
  );

  const toggleHidden = useCallback(
    (todosToToggle: Todo[]) => {
      updateTodos(todosToToggle, (t) => t.toggleHidden());
    },
    [updateTodos],
  );

  const archiveCompletedTodos = useCallback(() => {
    pushHistory();
    const remainingTodos = todos.filter((t: Todo) => !t.isDone());
    internalSetTodos([...remainingTodos]);
    // No-op for file writing in mock
    return Promise.resolve();
  }, [pushHistory, todos, internalSetTodos]);

  const canUndo = history.length > 0;
  const canRedo = redoStack.length > 0;

  const contextValue = useMemo(
    () => ({
      todos,
      setTodos: internalSetTodos,
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
      internalSetTodos,
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
    <TodoContext.Provider value={contextValue}>{children}</TodoContext.Provider>
  );
};
