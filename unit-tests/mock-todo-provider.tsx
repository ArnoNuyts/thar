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
    const newTodo = new Todo(text);
    newTodo.setCreationDate(new Date());
    setTodos(new Todos(...todos, newTodo));
    return newTodo;
  };

  const refreshTodos = () => {
    setTodos(new Todos(...todos));
  };

  const deleteTodo = (todo: Todo) => {
    const newTodos = todos.filter((t: Todo) => t !== todo);
    setTodos(new Todos(...newTodos));
  };

  const toggleTodo = (todo: Todo) => {
    const recurring = todo.toggleState();
    if (recurring) {
      setTodos(new Todos(...todos, recurring));
      showToaster("Recurring todo created");
    } else {
      setTodos(new Todos(...todos));
    }
  };

  const toggleHidden = (todo: Todo) => {
    todo.toggleHidden();
    setTodos(new Todos(...todos));
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
