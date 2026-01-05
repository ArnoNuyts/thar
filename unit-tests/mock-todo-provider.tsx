import { useState } from "react";
import { Todos } from "../logic/Todos.ts";
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
  const [todos, setTodos] = useState<Todos>(new Todos(...initialTodos));
  const [history, setHistory] = useState<Todos[]>([]);
  const [redoStack, setRedoStack] = useState<Todos[]>([]);
  const { showToaster } = useToaster();

  const internalSetTodos = (newTodos: Todos) => {
    setTodos(newTodos);
    if (onTodosChange) {
      onTodosChange(newTodos);
    }
  };

  const pushHistory = () => {
    setHistory((prev) => [...prev, todos]);
    setRedoStack([]);
  };

  const undo = () => {
    if (history.length === 0) return;
    const previousTodos = history[history.length - 1];
    setHistory((prev) => prev.slice(0, -1));
    setRedoStack((prev) => [...prev, todos]);
    internalSetTodos(previousTodos);
  };

  const redo = () => {
    if (redoStack.length === 0) return;
    const nextTodos = redoStack[redoStack.length - 1];
    setRedoStack((prev) => prev.slice(0, -1));
    setHistory((prev) => [...prev, todos]);
    internalSetTodos(nextTodos);
  };

  const addTodos = (...texts: string[]): Todo[] => {
    if (texts.length === 0) return [];
    pushHistory();
    const newTodos = texts.map((text) =>
      new Todo(text).setCreationDate(new Date())
    );
    internalSetTodos(new Todos(...todos, ...newTodos));
    return newTodos;
  };

  const deleteTodos = (todosToDelete: Todo[]) => {
    pushHistory();
    const idsToDelete = new Set(todosToDelete.map((t) => t.id));
    const newTodos = todos.filter((t: Todo) => !idsToDelete.has(t.id));
    internalSetTodos(new Todos(...newTodos));
  };

  const toggleTodos = (todosToToggle: Todo[]) => {
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

    internalSetTodos(new Todos(...transformed, ...newInstances));

    if (newInstances.length === 1) {
      showToaster("Recurring todo created");
    } else if (newInstances.length > 1) {
      showToaster(`${newInstances.length} recurring todos created`);
    }
  };

  const toggleHidden = (todosToToggle: Todo[]) => {
    updateTodos(todosToToggle, (t) => t.toggleHidden());
  };

  const archiveCompletedTodos = () => {
    pushHistory();
    const remainingTodos = todos.filter((t: Todo) => !t.isDone());
    internalSetTodos(new Todos(...remainingTodos));
    // No-op for file writing in mock
    return Promise.resolve();
  };

  const updateTodos = (
    todosToUpdate: Todo[],
    transform: (todo: Todo) => Todo,
  ) => {
    pushHistory();
    const idsToUpdate = new Set(todosToUpdate.map((t) => t.id));
    internalSetTodos(
      new Todos(
        ...todos.map((t) => (idsToUpdate.has(t.id) ? transform(t) : t)),
      ),
    );
  };

  return (
    <TodoContext.Provider
      value={{
        todos,
        setTodos: internalSetTodos,
        addTodos,
        updateTodos,
        deleteTodos,
        toggleTodos,
        toggleHidden,
        archiveCompletedTodos,
        undo,
        canUndo: history.length > 0,
        redo,
        canRedo: redoStack.length > 0,
      }}
    >
      {children}
    </TodoContext.Provider>
  );
};
