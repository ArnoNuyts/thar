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
  const { showToaster } = useToaster();

  const addTodo = (text: string): Todo => {
    const newTodo = new Todo(text).setCreationDate(new Date());
    setTodos(new Todos(...todos, newTodo));
    return newTodo;
  };

  const updateTodo = (oldTodo: Todo, newTodo: Todo) => {
    setTodos(new Todos(...todos.map((t) => (t === oldTodo ? newTodo : t))));
  };

  const refreshTodos = () => {
    setTodos(new Todos(...todos));
  };

  const deleteTodo = (todo: Todo) => {
    const newTodos = todos.filter((t: Todo) => t !== todo);
    setTodos(new Todos(...newTodos));
  };

  const toggleTodo = (todo: Todo) => {
    const { updated, recurring } = todo.toggleState();
    if (recurring) {
      setTodos(
        new Todos(...todos.map((t) => (t === todo ? updated : t)), recurring),
      );
      showToaster("Recurring todo created");
    } else {
      updateTodo(todo, updated);
    }
  };

  const toggleHidden = (todo: Todo) => {
    const updated = todo.toggleHidden();
    updateTodo(todo, updated);
  };

  const archiveCompletedTodos = () => {
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
      }}
    >
      {children}
    </TodoContext.Provider>
  );
};
