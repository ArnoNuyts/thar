import { useState } from "react";
import { Todos } from "../logic/Todos.ts";
import { Todo } from "../logic/todo.ts";
import { TodoContext } from "../contexts/todo-context.tsx";
import { useToaster } from "../contexts/toaster-context.tsx";

// Mock TodoProvider that doesn't use file system
export const MockTodoProvider = ({
  children,
  initialTodos = [],
}: {
  children: React.ReactNode;
  initialTodos?: Todo[];
}) => {
  const [todos, setTodos] = useState<Todos>(new Todos(...initialTodos));
  const [history, setHistory] = useState<Todos[]>([]);
  const [redoStack, setRedoStack] = useState<Todos[]>([]);
  const { showToaster } = useToaster();

  const pushHistory = () => {
    setHistory((prev) => [...prev, todos]);
    setRedoStack([]);
  };

  const undo = () => {
    if (history.length === 0) return;
    const previousTodos = history[history.length - 1];
    setHistory((prev) => prev.slice(0, -1));
    setRedoStack((prev) => [...prev, todos]);
    setTodos(previousTodos);
  };

  const redo = () => {
    if (redoStack.length === 0) return;
    const nextTodos = redoStack[redoStack.length - 1];
    setRedoStack((prev) => prev.slice(0, -1));
    setHistory((prev) => [...prev, todos]);
    setTodos(nextTodos);
  };

  const addTodo = (text: string): Todo => {
    pushHistory();
    const newTodo = new Todo(text).setCreationDate(new Date());
    setTodos(new Todos(...todos, newTodo));
    return newTodo;
  };

  const updateTodo = (oldTodo: Todo, newTodo: Todo) => {
    pushHistory();
    setTodos(new Todos(...todos.map((t) => (t === oldTodo ? newTodo : t))));
  };

  const refreshTodos = () => {
    setTodos(new Todos(...todos));
  };

  const deleteTodo = (todo: Todo) => {
    pushHistory();
    const newTodos = todos.filter((t: Todo) => t !== todo);
    setTodos(new Todos(...newTodos));
  };

  const toggleTodo = (todo: Todo) => {
    pushHistory();
    const { updated, recurring } = todo.toggleState();
    if (recurring) {
      setTodos(
        new Todos(...todos.map((t) => (t === todo ? updated : t)), recurring),
      );
      showToaster("Recurring todo created");
    } else {
      // updateTodo already calls pushHistory, but we're calling setTodos manually in updateTodo
      // Wait, let's copy the logic from the real provider for consistency.
      // In MockTodoProvider, updateTodo calls pushHistory.
      // In real provider, I removed pushHistory from toggleTodo start, and let sub-calls handle it or handle it manually.
      // Here I added pushHistory at the start.

      // If I call updateTodo below:
      /*
      updateTodo(todo, updated);
      */
      // It calls pushHistory(). So double push.

      // Let's remove pushHistory() from here and match real provider logic roughly.
      setTodos(new Todos(...todos.map((t) => (t === todo ? updated : t))));
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
    setTodos(new Todos(...remainingTodos));
    // No-op for file writing in mock
    return Promise.resolve();
  };

  return (
    <TodoContext.Provider
      value={{
        todos,
        setTodos,
        addTodo,
        updateTodo,
        refreshTodos,
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
