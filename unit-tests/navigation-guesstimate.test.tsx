import { assertEquals } from "@std/assert";
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
  // deno-lint-ignore no-explicit-any
  onContext: (ctx: any) => void;
}) => (
  <SearchProvider>
    <NavigationProvider todos={todos}>
      <NavigationTester onContext={onContext} />
    </NavigationProvider>
  </SearchProvider>
);

// Helper component to interact with NavigationContext
// deno-lint-ignore no-explicit-any
const NavigationTester = ({ onContext }: { onContext: (ctx: any) => void }) => {
  const nav = useNavigation();
  useEffect(() => {
    onContext(nav);
  });
  return <Text>Tester</Text>;
};

Deno.test(
  "should select restored todo after undoing a delete",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const todo1 = new Todo("Todo 1");
    const todo2 = new Todo("Todo 2");
    const todo3 = new Todo("Todo 3");

    // Initial state: 1 and 3 (2 was deleted)
    const initialTodos = [todo1, todo3];

    // deno-lint-ignore no-explicit-any
    let navContext: any;

    const { rerender, unmount } = render(
      <TestWrapper
        todos={initialTodos}
        onContext={(ctx) => (navContext = ctx)}
      />,
    );

    // Currently Todo 1 is selected by default
    await waitFor(() =>
      assertEquals(navContext.getSelectedTodo()?.text, "Todo 1"),
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
      assertEquals(navContext.getSelectedTodo()?.text, "Todo 2"),
    );

    unmount();
  },
);

Deno.test(
  "should select modified todo after undoing an edit",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const todo1 = new Todo("Todo 1");
    const todo2 = new Todo("Todo 2");

    // Initial state: Select Todo 1
    const initialTodos = [todo1, todo2];

    // deno-lint-ignore no-explicit-any
    let navContext: any;

    const { rerender, unmount } = render(
      <TestWrapper
        todos={initialTodos}
        onContext={(ctx) => (navContext = ctx)}
      />,
    );

    await waitFor(() =>
      assertEquals(navContext.getSelectedTodo()?.text, "Todo 1"),
    );

    // Move selection to Todo 2
    navContext.navigateDown();
    await waitFor(() =>
      assertEquals(navContext.getSelectedTodo()?.text, "Todo 2"),
    );

    // Undo edit on Todo 1 (while Todo 2 is selected)
    const undoEditedTodo1 = todo1.setText("Todo 1 Original");
    const undidTodos = [undoEditedTodo1, todo2];

    rerender(
      <TestWrapper
        todos={undidTodos}
        onContext={(ctx) => (navContext = ctx)}
      />,
    );

    // Should now jump to Todo 1 because it was modified
    await waitFor(() =>
      assertEquals(navContext.getSelectedTodo()?.text, "Todo 1 Original"),
    );

    unmount();
  },
);

Deno.test(
  "should select newly added todo",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const todo1 = new Todo("Todo 1");
    const initialTodos = [todo1];

    // deno-lint-ignore no-explicit-any
    let navContext: any;

    const { rerender, unmount } = render(
      <TestWrapper
        todos={initialTodos}
        onContext={(ctx) => (navContext = ctx)}
      />,
    );

    await waitFor(() =>
      assertEquals(navContext.getSelectedTodo()?.text, "Todo 1"),
    );

    // Add new todo
    const todo2 = new Todo("New Todo");
    const newTodos = [todo1, todo2];

    rerender(
      <TestWrapper todos={newTodos} onContext={(ctx) => (navContext = ctx)} />,
    );

    // Should select the new todo
    await waitFor(() =>
      assertEquals(navContext.getSelectedTodo()?.text, "New Todo"),
    );

    unmount();
  },
);

Deno.test(
  "should select a modified todo in a large list",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const todos = Array.from({ length: 300 }, (_, i) => new Todo(`Task ${i}`));
    const initialTodos = [...todos];

    // deno-lint-ignore no-explicit-any
    let navContext: any;

    const { rerender, unmount } = render(
      <TestWrapper
        todos={initialTodos}
        onContext={(ctx) => (navContext = ctx)}
      />,
    );

    await waitFor(() =>
      assertEquals(navContext.getSelectedTodo()?.text, "Task 0"),
    );

    // Modify a todo far down the list; guesstimate must find it.
    const modified = todos[250].setText("Task 250 modified");
    const modifiedTodos = [
      ...todos.slice(0, 250),
      modified,
      ...todos.slice(251),
    ];

    rerender(
      <TestWrapper
        todos={modifiedTodos}
        onContext={(ctx) => (navContext = ctx)}
      />,
    );

    await waitFor(() =>
      assertEquals(navContext.getSelectedTodo()?.text, "Task 250 modified"),
    );

    unmount();
  },
);
