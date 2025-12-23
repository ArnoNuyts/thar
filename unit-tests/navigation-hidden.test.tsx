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
import { Todos } from "../logic/Todos.ts";
import { waitFor } from "./test-utils.ts";
import { IndexType } from "../types/enums.ts";

const TestWrapper = (
  { todos, onContext }: {
    todos: Todos;
    // deno-lint-ignore no-explicit-any
    onContext: (ctx: any) => void;
  },
) => (
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
  "NavigationContext: should initialize with showHidden = false and filter hidden todos",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const todoVisible = new Todo("visible todo");
    const todoHidden = new Todo("h:1 hidden todo");
    const todos = new Todos(todoVisible, todoHidden);
    // deno-lint-ignore no-explicit-any
    let navContext: any;

    const { unmount } = render(
      <TestWrapper todos={todos} onContext={(ctx) => navContext = ctx} />,
    );

    await waitFor(() => {
      assertEquals(navContext?.showHidden, false);
      // Wait for indexes to populate
      if (!navContext?.indexes) throw new Error("Indexes not ready");
    });

    // Check visible todos
    const visibleTodos = navContext.indexes.filter((i: any) =>
      i.type === IndexType.todo
    );
    assertEquals(visibleTodos.length, 1);
    assertEquals(visibleTodos[0].todo.text, "visible todo");

    unmount();
  },
);

Deno.test(
  "NavigationContext: should toggle showHidden and show all todos",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const todoVisible = new Todo("visible todo");
    const todoHidden = new Todo("h:1 hidden todo");
    const todos = new Todos(todoVisible, todoHidden);
    // deno-lint-ignore no-explicit-any
    let navContext: any;

    const { unmount } = render(
      <TestWrapper todos={todos} onContext={(ctx) => navContext = ctx} />,
    );

    await waitFor(() => {
      assertEquals(navContext?.showHidden, false);
    });

    navContext.toggleShowHidden();

    await waitFor(() => {
      assertEquals(navContext.showHidden, true);
      const allTodos = navContext.indexes.filter((i: any) =>
        i.type === IndexType.todo
      );
      assertEquals(allTodos.length, 2);
    });

    unmount();
  },
);

Deno.test(
  "NavigationContext: should toggle back to hidden",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const todoVisible = new Todo("visible todo");
    const todoHidden = new Todo("h:1 hidden todo");
    const todos = new Todos(todoVisible, todoHidden);
    // deno-lint-ignore no-explicit-any
    let navContext: any;

    const { unmount } = render(
      <TestWrapper todos={todos} onContext={(ctx) => navContext = ctx} />,
    );

    // First toggle
    await waitFor(() => {
      if (!navContext) throw new Error("Context not ready");
    });

    navContext.toggleShowHidden();
    await waitFor(() => assertEquals(navContext.showHidden, true));

    // Second toggle
    navContext.toggleShowHidden();
    await waitFor(() => assertEquals(navContext.showHidden, false));

    const visibleTodos = navContext.indexes.filter((i: any) =>
      i.type === IndexType.todo
    );
    assertEquals(visibleTodos.length, 1);
    assertEquals(visibleTodos[0].todo.text, "visible todo");

    unmount();
  },
);
