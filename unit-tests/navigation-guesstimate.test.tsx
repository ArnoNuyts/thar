import { expect, test } from "vitest";

import { Text } from "ink";
import { render } from "ink-testing-library";
import { useEffect } from "react";
import {
  NavigationProvider,
  useNavigation,
} from "../contexts/navigation-context.tsx";
import { SearchProvider } from "../contexts/search-context.tsx";
import { Todo } from "../logic/todo.ts";
import type { Todos } from "../logic/Todos.ts";
import { waitFor } from "./test-utils.ts";

const TestWrapper = ({
  todos,
  onContext,
}: {
  todos: Todos;
  onContext: (ctx: any) => void;
}) => (
  <SearchProvider>
    <NavigationProvider todos={todos}>
      <NavigationTester onContext={onContext} />
    </NavigationProvider>
  </SearchProvider>
);

// Helper component to interact with NavigationContext
const NavigationTester = ({ onContext }: { onContext: (ctx: any) => void }) => {
  const nav = useNavigation();
  useEffect(() => {
    onContext(nav);
  });
  return <Text>Tester</Text>;
};

test("should select restored todo after undoing a delete", async () => {
  const todo1 = new Todo("Todo 1");
  const todo2 = new Todo("Todo 2");
  const todo3 = new Todo("Todo 3");

  // Initial state: 1 and 3 (2 was deleted)
  const initialTodos = [todo1, todo3];

  let navContext: any;

  const { rerender, unmount } = render(
    <TestWrapper
      todos={initialTodos}
      onContext={(ctx) => (navContext = ctx)}
    />,
  );

  // Currently Todo 1 is selected by default
  await waitFor(() =>
    expect(navContext.getSelectedTodo()?.text).toEqual("Todo 1"),
  );

  // Undo delete: Restore Todo 2
  const restoredTodos = [todo1, todo2, todo3];

  rerender(
    <TestWrapper
      todos={restoredTodos}
      onContext={(ctx) => (navContext = ctx)}
    />,
  );

  // Should now select Todo 2 because it was "added" (restored)
  await waitFor(() =>
    expect(navContext.getSelectedTodo()?.text).toEqual("Todo 2"),
  );

  unmount();
});

test("should select modified todo after undoing an edit", async () => {
  const todo1 = new Todo("Todo 1");
  const todo2 = new Todo("Todo 2");

  // Initial state: Select Todo 1
  const initialTodos = [todo1, todo2];

  let navContext: any;

  const { rerender, unmount } = render(
    <TestWrapper
      todos={initialTodos}
      onContext={(ctx) => (navContext = ctx)}
    />,
  );

  await waitFor(() =>
    expect(navContext.getSelectedTodo()?.text).toEqual("Todo 1"),
  );

  // Move selection to Todo 2
  navContext.navigateDown();
  await waitFor(() =>
    expect(navContext.getSelectedTodo()?.text).toEqual("Todo 2"),
  );

  // Undo edit on Todo 1 (while Todo 2 is selected)
  const undoEditedTodo1 = todo1.setText("Todo 1 Original");
  const undidTodos = [undoEditedTodo1, todo2];

  rerender(
    <TestWrapper todos={undidTodos} onContext={(ctx) => (navContext = ctx)} />,
  );

  // Should now jump to Todo 1 because it was modified
  await waitFor(() =>
    expect(navContext.getSelectedTodo()?.text).toEqual("Todo 1 Original"),
  );

  unmount();
});

test("should select newly added todo", async () => {
  const todo1 = new Todo("Todo 1");
  const initialTodos = [todo1];

  let navContext: any;

  const { rerender, unmount } = render(
    <TestWrapper
      todos={initialTodos}
      onContext={(ctx) => (navContext = ctx)}
    />,
  );

  await waitFor(() =>
    expect(navContext.getSelectedTodo()?.text).toEqual("Todo 1"),
  );

  // Add new todo
  const todo2 = new Todo("New Todo");
  const newTodos = [todo1, todo2];

  rerender(
    <TestWrapper todos={newTodos} onContext={(ctx) => (navContext = ctx)} />,
  );

  // Should select the new todo
  await waitFor(() =>
    expect(navContext.getSelectedTodo()?.text).toEqual("New Todo"),
  );

  unmount();
});

test("should select a modified todo in a large list", async () => {
  const todos = Array.from({ length: 300 }, (_, i) => new Todo(`Task ${i}`));
  const initialTodos = [...todos];

  let navContext: any;

  const { rerender, unmount } = render(
    <TestWrapper
      todos={initialTodos}
      onContext={(ctx) => (navContext = ctx)}
    />,
  );

  await waitFor(() =>
    expect(navContext.getSelectedTodo()?.text).toEqual("Task 0"),
  );

  // Modify a todo far down the list; guesstimate must find it.
  const modified = todos[250].setText("Task 250 modified");
  const modifiedTodos = [...todos.slice(0, 250), modified, ...todos.slice(251)];

  rerender(
    <TestWrapper
      todos={modifiedTodos}
      onContext={(ctx) => (navContext = ctx)}
    />,
  );

  await waitFor(() =>
    expect(navContext.getSelectedTodo()?.text).toEqual("Task 250 modified"),
  );

  unmount();
});
