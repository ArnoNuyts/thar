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

  const updateTodos = (newTodos: Todos) => {
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
    updateTodos(previousTodos);
  };

  const redo = () => {
    if (redoStack.length === 0) return;
    const nextTodos = redoStack[redoStack.length - 1];
    setRedoStack((prev) => prev.slice(0, -1));
    setHistory((prev) => [...prev, todos]);
    updateTodos(nextTodos);
  };

  const addTodos = (...texts: string[]): Todo[] => {
    if (texts.length === 0) return [];
    pushHistory();
    const newTodos = texts.map((text) =>
      new Todo(text).setCreationDate(new Date())
    );
    updateTodos(new Todos(...todos, ...newTodos));
    return newTodos;
  };

  const updateTodo = (oldTodo: Todo, newTodo: Todo) => {
    pushHistory();
    updateTodos(new Todos(...todos.map((t) => (t === oldTodo ? newTodo : t))));
  };

  const deleteTodo = (todo: Todo) => {
    pushHistory();
    const newTodos = todos.filter((t: Todo) => t !== todo);
    updateTodos(new Todos(...newTodos));
  };

  const toggleTodo = (todo: Todo) => {
    pushHistory();
    const { updated, recurring } = todo.toggleState();
    if (recurring) {
      updateTodos(
        new Todos(...todos.map((t) => (t === todo ? updated : t)), recurring),
      );
      showToaster("Recurring todo created");
    } else {
      // Direct state update to avoid double pushHistory call
      updateTodos(new Todos(...todos.map((t) => (t === todo ? updated : t))));
    }
  };

  const toggleHidden = (todo: Todo) => {
    // pushHistory via updateTodo
    const updated = todo.toggleHidden();
    updateTodo(todo, updated);
  };

  const archiveCompletedTodos = () => {
    pushHistory();
    const remainingTodos = todos.filter((t: Todo) => !t.isDone());
    updateTodos(new Todos(...remainingTodos));
    // No-op for file writing in mock
    return Promise.resolve();
  };

  return (
    <TodoContext.Provider
      value={{
        todos,
        setTodos: updateTodos,
        addTodos,
        updateTodo,
        deleteTodo,
        toggleTodo,
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
