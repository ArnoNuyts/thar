import { assertEquals } from "@std/assert";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { useEffect } from "react";
import {
  NavigationContextType,
  NavigationProvider,
  useNavigation,
} from "../contexts/navigation-context.tsx";
import { SearchProvider } from "../contexts/search-context.tsx";
import { Todo } from "../logic/todo.ts";
import type { Todos } from "../logic/Todos.ts";
import { waitFor } from "./test-utils.ts";

const TestWrapper = (
  { todos, onContext }: {
    todos: Todos;
    onContext: (ctx: NavigationContextType) => void;
  },
) => (
  <SearchProvider>
    <NavigationProvider todos={todos}>
      <NavigationTester onContext={onContext} />
    </NavigationProvider>
  </SearchProvider>
);

// Helper component to interact with NavigationContext
const NavigationTester = (
  { onContext }: { onContext: (ctx: NavigationContextType) => void },
) => {
  const nav = useNavigation();
  useEffect(() => {
    onContext(nav);
  });
  return <Text>Tester</Text>;
};

Deno.test(
  "Multi-selection: Shift+Down from first item selects both first and second",
  {
    sanitizeResources: false,
    sanitizeOps: false,
  },
  async () => {
    const todos = [
      new Todo("Todo 1"),
      new Todo("Todo 2"),
      new Todo("Todo 3"),
    ];
    let navContext: NavigationContextType | undefined;
    const { unmount } = render(
      <TestWrapper todos={todos} onContext={(c) => navContext = c} />,
    );

    await waitFor(() =>
      assertEquals(navContext!.getSelectedTodo()?.text, "Todo 1")
    );

    navContext!.navigateDown(true);

    await waitFor(() => {
      assertEquals(navContext!.getSelectedTodo()?.text, "Todo 2");
      assertEquals(navContext!.selectedTodoIds.size, 2);
    });

    unmount();
  },
);

Deno.test(
  "Multi-selection: Shift+Up from second item selects both first and second",
  {
    sanitizeResources: false,
    sanitizeOps: false,
  },
  async () => {
    const todos = [new Todo("1"), new Todo("2"), new Todo("3")];
    let navContext: NavigationContextType | undefined;
    const { unmount } = render(
      <TestWrapper todos={todos} onContext={(c) => navContext = c} />,
    );

    await waitFor(() => assertEquals(navContext!.getSelectedTodo()?.text, "1"));

    navContext!.navigateDown(false);
    await waitFor(() => assertEquals(navContext!.getSelectedTodo()?.text, "2"));

    navContext!.navigateUp(true);

    await waitFor(() => {
      assertEquals(navContext!.getSelectedTodo()?.text, "1");
      assertEquals(navContext!.selectedTodoIds.size, 2);
    });

    unmount();
  },
);

Deno.test("Multi-selection: Moving without shift clears selection", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const todos = [new Todo("1"), new Todo("2"), new Todo("3")];
  let navContext: NavigationContextType | undefined;
  const { unmount } = render(
    <TestWrapper todos={todos} onContext={(c) => navContext = c} />,
  );

  await waitFor(() => assertEquals(navContext!.getSelectedTodo()?.text, "1"));

  navContext!.navigateDown(true);
  await waitFor(() => assertEquals(navContext!.selectedTodoIds.size, 2));

  navContext!.navigateDown(false);
  await waitFor(() => {
    assertEquals(navContext!.getSelectedTodo()?.text, "3");
    assertEquals(navContext!.selectedTodoIds.size, 0);
  });

  unmount();
});

Deno.test("Multi-selection: Selection across context headers works", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  // Use names that don't reorder if possible, or expect reordered
  // Home (H) comes before Work (W)
  const todos = [
    new Todo("B @Home"),
    new Todo("A @Work"),
  ];
  let navContext: NavigationContextType | undefined;
  const { unmount } = render(
    <TestWrapper todos={todos} onContext={(c) => navContext = c} />,
  );

  await waitFor(() =>
    assertEquals(navContext!.getSelectedTodo()?.text, "B @Home")
  );

  navContext!.navigateDown(true);

  await waitFor(() => {
    assertEquals(navContext!.getSelectedTodo()?.text, "A @Work");
    assertEquals(navContext!.selectedTodoIds.size, 2);
  });

  unmount();
});

Deno.test("Multi-selection: Continuous Shift+Down expands range", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const todos = [new Todo("1"), new Todo("2"), new Todo("3")];
  let navContext: NavigationContextType | undefined;
  const { unmount } = render(
    <TestWrapper todos={todos} onContext={(c) => navContext = c} />,
  );

  await waitFor(() => assertEquals(navContext!.getSelectedTodo()?.text, "1"));

  navContext!.navigateDown(true);
  await waitFor(() => assertEquals(navContext!.selectedTodoIds.size, 2));

  navContext!.navigateDown(true);
  await waitFor(() => {
    assertEquals(navContext!.getSelectedTodo()?.text, "3");
    assertEquals(navContext!.selectedTodoIds.size, 3);
  });

  unmount();
});

Deno.test("Multi-selection: Pressing Esc clears selection", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const todos = [new Todo("1"), new Todo("2"), new Todo("3")];
  let navContext: NavigationContextType | undefined;
  const { unmount } = render(
    <TestWrapper todos={todos} onContext={(c) => navContext = c} />,
  );

  await waitFor(() => assertEquals(navContext!.getSelectedTodo()?.text, "1"));

  navContext!.navigateDown(true); // 1, 2 selected
  await waitFor(() => assertEquals(navContext!.selectedTodoIds.size, 2));

  // Simulate Esc key press
  navContext!.clearMultiSelect();

  await waitFor(() => {
    assertEquals(navContext!.selectedTodoIds.size, 0);
    assertEquals(navContext!.getSelectedTodo()?.text, "2"); // Cursor should stay at 2
  });

  unmount();
});
