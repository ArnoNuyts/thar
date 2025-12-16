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

const TestWrapper = (
  { children, todos }: {
    children: React.ReactNode;
    todos: Todos;
  },
) => (
  <SearchProvider>
    <NavigationProvider todos={todos}>
      {children}
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

Deno.test("should initialize with first todo selected", {
  sanitizeResources: false,
}, async () => {
  const todos = new Todos(
    new Todo("Todo 1"),
    new Todo("Todo 2"),
    new Todo("Todo 3"),
  );
  // deno-lint-ignore no-explicit-any
  let navContext: any;

  const { unmount } = render(
    <TestWrapper todos={todos}>
      <NavigationTester onContext={(ctx) => navContext = ctx} />
    </TestWrapper>,
  );

  await waitFor(() => {
    assertEquals(navContext?.indexes?.length, 4);
  });

  // Verify initial state
  // indexes should have 3 todos + 1 context header = 4
  // selectedTodoId should match Todo 1's ID
  // We can check if useSelectedTodo returns Todo 1
  await waitFor(() => {
    assertEquals(navContext.useSelectedTodo()?.text, "Todo 1");
  });

  unmount();
});

Deno.test("should navigate down", { sanitizeResources: false }, async () => {
  const todos = new Todos(
    new Todo("Todo 1"),
    new Todo("Todo 2"),
    new Todo("Todo 3"),
  );
  // deno-lint-ignore no-explicit-any
  let navContext: any;

  const { unmount } = render(
    <TestWrapper todos={todos}>
      <NavigationTester onContext={(ctx) => navContext = ctx} />
    </TestWrapper>,
  );

  await waitFor(() =>
    assertEquals(navContext.useSelectedTodo()?.text, "Todo 1")
  );

  navContext.navigateDown();

  await waitFor(() =>
    assertEquals(navContext.useSelectedTodo()?.text, "Todo 2")
  ); // State update

  unmount();
});

Deno.test("should navigate up", { sanitizeResources: false }, async () => {
  const todos = new Todos(
    new Todo("Todo 1"),
    new Todo("Todo 2"),
  );
  // deno-lint-ignore no-explicit-any
  let navContext: any;

  const { unmount } = render(
    <TestWrapper todos={todos}>
      <NavigationTester onContext={(ctx) => navContext = ctx} />
    </TestWrapper>,
  );

  await waitFor(() =>
    assertEquals(navContext.useSelectedTodo()?.text, "Todo 1")
  );

  // Start at 1
  navContext.navigateDown();

  await waitFor(() =>
    assertEquals(navContext.useSelectedTodo().text, "Todo 2")
  );

  navContext.navigateUp();

  await waitFor(() =>
    assertEquals(navContext.useSelectedTodo().text, "Todo 1")
  );

  unmount();
});

Deno.test(
  "should clamp navigation at bounds",
  { sanitizeResources: false },
  async () => {
    const todos = new Todos(
      new Todo("Todo 1"),
      new Todo("Todo 2"),
    );
    // deno-lint-ignore no-explicit-any
    let navContext: any;

    const { unmount } = render(
      <TestWrapper todos={todos}>
        <NavigationTester onContext={(ctx) => navContext = ctx} />
      </TestWrapper>,
    );

    await waitFor(() =>
      assertEquals(navContext.useSelectedTodo()?.text, "Todo 1")
    );

    // Up from top
    navContext.navigateUp();
    await waitFor(() =>
      assertEquals(navContext.useSelectedTodo().text, "Todo 1")
    );

    // Down to bottom
    navContext.navigateDown();
    await waitFor(() =>
      assertEquals(navContext.useSelectedTodo().text, "Todo 2")
    );

    // Down past bottom
    navContext.navigateDown(); // Should stay at 2
    await waitFor(() =>
      assertEquals(navContext.useSelectedTodo().text, "Todo 2")
    );

    unmount();
  },
);

Deno.test(
  "should preserve selection after todo update",
  { sanitizeResources: false },
  async () => {
    const todo1 = new Todo("Todo 1");
    const todo2 = new Todo("Todo 2"); // Target for selection
    const todo3 = new Todo("Todo 3");
    const todos = new Todos(todo1, todo2, todo3);
    // deno-lint-ignore no-explicit-any
    let navContext: any;

    const { rerender, unmount } = render(
      <TestWrapper todos={todos}>
        <NavigationTester onContext={(ctx) => navContext = ctx} />
      </TestWrapper>,
    );

    await waitFor(() =>
      assertEquals(navContext.useSelectedTodo()?.text, "Todo 1")
    );

    // Select Todo 2
    navContext.navigateDown(); // Selects Todo 2
    await waitFor(() =>
      assertEquals(navContext.useSelectedTodo()?.text, "Todo 2")
    );

    // Mutate Todo 2
    todo2.setText("Todo 2 Updated");
    const newTodos = new Todos(todo1, todo2, todo3);

    // Re-render
    rerender(
      <TestWrapper todos={newTodos}>
        <NavigationTester onContext={(ctx) => navContext = ctx} />
      </TestWrapper>,
    );

    await waitFor(() => {
      // Verify selection is preserved on the *same* todo
      const selected = navContext.useSelectedTodo();

      // If bug exists, it will likely select "Todo 1" (first item fallback)
      if (selected?.text === "Todo 1") {
        throw new Error(
          `Selection reset to first item! Expected "Todo 2 Updated", got "${selected?.text}"`,
        );
      }
      assertEquals(selected?.text, "Todo 2 Updated");
    });

    unmount();
  },
);

Deno.test(
  "should preserve selection after file reload (new instances, same hash)",
  { sanitizeResources: false },
  async () => {
    const todo1 = new Todo("Todo 1");
    const todo2 = new Todo("Todo 2");
    const todo3 = new Todo("Todo 3");
    // Initial set of todos
    const initialTodos = new Todos(todo1, todo2, todo3);

    // deno-lint-ignore no-explicit-any
    let navContext: any;

    const { rerender, unmount } = render(
      <TestWrapper todos={initialTodos}>
        <NavigationTester onContext={(ctx) => navContext = ctx} />
      </TestWrapper>,
    );

    await waitFor(() =>
      assertEquals(navContext.useSelectedTodo()?.text, "Todo 1")
    );

    // Select "Todo 2"
    navContext.navigateDown();
    await waitFor(() =>
      assertEquals(navContext.useSelectedTodo()?.text, "Todo 2")
    );

    // Simulate file reload: New instances, same content
    const newTodo1 = new Todo("Todo 1");
    const newTodo2 = new Todo("Todo 2"); // Same content as old selected
    const newTodo3 = new Todo("Todo 3");
    const reloadedTodos = new Todos(newTodo1, newTodo2, newTodo3);

    // Re-render with new instances
    rerender(
      <TestWrapper todos={reloadedTodos}>
        <NavigationTester onContext={(ctx) => navContext = ctx} />
      </TestWrapper>,
    );

    await waitFor(() => { // Verify "Todo 2" is still selected (by hash fallback)
      const selected = navContext.useSelectedTodo();

      if (selected?.text === "Todo 1") {
        throw new Error("Selection reset to first item after reload!");
      }
      assertEquals(selected?.text, "Todo 2");
      // Verify it is indeed the NEW instance
      assertEquals(selected === newTodo2, true);
    });

    unmount();
  },
);

Deno.test(
  "should select next todo after deletion",
  { sanitizeResources: false },
  async () => {
    const todo1 = new Todo("Todo 1");
    const todo2 = new Todo("Todo 2");
    const todo3 = new Todo("Todo 3");
    const todos = new Todos(todo1, todo2, todo3);
    // deno-lint-ignore no-explicit-any
    let navContext: any;

    const { rerender, unmount } = render(
      <TestWrapper todos={todos}>
        <NavigationTester onContext={(ctx) => navContext = ctx} />
      </TestWrapper>,
    );
    await waitFor(() =>
      assertEquals(navContext.useSelectedTodo()?.text, "Todo 1")
    );

    // Select Todo 2
    navContext.navigateDown();

    await waitFor(() =>
      assertEquals(navContext.useSelectedTodo()?.text, "Todo 2")
    );

    // Delete Todo 2
    const newTodos = new Todos(todo1, todo3);
    rerender(
      <TestWrapper todos={newTodos}>
        <NavigationTester onContext={(ctx) => navContext = ctx} />
      </TestWrapper>,
    );
    await waitFor(() => { // Should select Todo 3 (next item)
      const selected = navContext.useSelectedTodo();
      assertEquals(selected?.text, "Todo 3");
    });

    unmount();
  },
);

Deno.test(
  "should select previous todo when deleting last item",
  { sanitizeResources: false },
  async () => {
    const todo1 = new Todo("Todo 1");
    const todo2 = new Todo("Todo 2");
    const todos = new Todos(todo1, todo2);
    // deno-lint-ignore no-explicit-any
    let navContext: any;

    const { rerender, unmount } = render(
      <TestWrapper todos={todos}>
        <NavigationTester onContext={(ctx) => navContext = ctx} />
      </TestWrapper>,
    );
    await waitFor(() =>
      assertEquals(navContext.useSelectedTodo()?.text, "Todo 1")
    );

    // Select Todo 2 (last)
    navContext.navigateDown();
    await waitFor(() =>
      assertEquals(navContext.useSelectedTodo()?.text, "Todo 2")
    );

    // Delete Todo 2
    const newTodos = new Todos(todo1);
    rerender(
      <TestWrapper todos={newTodos}>
        <NavigationTester onContext={(ctx) => navContext = ctx} />
      </TestWrapper>,
    );
    await waitFor(() =>
      // Should select Todo 1 (previous/last remaining)
      assertEquals(navContext.useSelectedTodo()?.text, "Todo 1")
    );

    unmount();
  },
);

Deno.test(
  "should preserve selection after priority update",
  { sanitizeResources: false },
  async () => {
    const todo1 = new Todo("Todo 1");
    const todo2 = new Todo("Todo 2"); // Target
    const todo3 = new Todo("Todo 3");
    const todos = new Todos(todo1, todo2, todo3);
    // deno-lint-ignore no-explicit-any
    let navContext: any;

    const { rerender, unmount } = render(
      <TestWrapper todos={todos}>
        <NavigationTester onContext={(ctx) => navContext = ctx} />
      </TestWrapper>,
    );

    await waitFor(() => {
      assertEquals(navContext.useSelectedTodo()?.text, "Todo 1");
    });

    // Select Todo 2
    navContext.navigateDown();
    await waitFor(() => {
      assertEquals(navContext.useSelectedTodo()?.text, "Todo 2");
    });

    // Change Priority (mutating in place)
    todo2.setPriority("A");
    const newTodos = new Todos(todo1, todo2, todo3);

    // Re-render
    rerender(
      <TestWrapper todos={newTodos}>
        <NavigationTester onContext={(ctx) => navContext = ctx} />
      </TestWrapper>,
    );

    await waitFor(() => { // Selection should follow the todo
      const selected = navContext.useSelectedTodo();
      assertEquals(selected?.text, "Todo 2");
      assertEquals(selected?.priority, "A");
    });

    unmount();
  },
);

Deno.test(
  "should preserve selection after toggling completion",
  { sanitizeResources: false },
  async () => {
    const todo1 = new Todo("Todo 1");
    const todo2 = new Todo("Todo 2"); // Target
    const todo3 = new Todo("Todo 3");
    const todos = new Todos(todo1, todo2, todo3);
    // deno-lint-ignore no-explicit-any
    let navContext: any;

    const { rerender, unmount } = render(
      <TestWrapper todos={todos}>
        <NavigationTester onContext={(ctx) => navContext = ctx} />
      </TestWrapper>,
    );

    await waitFor(() => {
      assertEquals(navContext.useSelectedTodo()?.text, "Todo 1");
    });

    // Select Todo 2
    navContext.navigateDown();
    await waitFor(() => {
      assertEquals(navContext.useSelectedTodo()?.text, "Todo 2");
    });

    // Toggle completion (mutating in place)
    todo2.toggleState();
    const newTodos = new Todos(todo1, todo2, todo3);

    // Re-render
    rerender(
      <TestWrapper todos={newTodos}>
        <NavigationTester onContext={(ctx) => navContext = ctx} />
      </TestWrapper>,
    );

    await waitFor(() => {});

    // Selection should follow the todo
    const selected = navContext.useSelectedTodo();
    assertEquals(selected?.text, "Todo 2");
    assertEquals(selected?.isDone(), true);

    unmount();
  },
);
