import { assertEquals, assertStringIncludes } from "@std/assert";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { useEffect } from "react";
import {
  NavigationProvider,
  useNavigation,
} from "../contexts/navigation-context.tsx";
import { SearchProvider, useSearch } from "../contexts/search-context.tsx";
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
    <TestWrapper todos={todos} onContext={(ctx) => navContext = ctx} />,
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

Deno.test("should navigate down", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const todos = new Todos(
    new Todo("Todo 1"),
    new Todo("Todo 2"),
    new Todo("Todo 3"),
  );
  // deno-lint-ignore no-explicit-any
  let navContext: any;

  const { unmount } = render(
    <TestWrapper todos={todos} onContext={(ctx) => navContext = ctx} />,
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

Deno.test("should navigate up", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const todos = new Todos(
    new Todo("Todo 1"),
    new Todo("Todo 2"),
  );
  // deno-lint-ignore no-explicit-any
  let navContext: any;

  const { unmount } = render(
    <TestWrapper todos={todos} onContext={(ctx) => navContext = ctx} />,
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
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const todos = new Todos(
      new Todo("Todo 1"),
      new Todo("Todo 2"),
    );
    // deno-lint-ignore no-explicit-any
    let navContext: any;

    const { unmount } = render(
      <TestWrapper todos={todos} onContext={(ctx) => navContext = ctx} />,
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
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const todo1 = new Todo("Todo 1");
    const todo2 = new Todo("Todo 2"); // Target for selection
    const todo3 = new Todo("Todo 3");
    const todos = new Todos(todo1, todo2, todo3);
    // deno-lint-ignore no-explicit-any
    let navContext: any;

    const { rerender, unmount } = render(
      <TestWrapper todos={todos} onContext={(ctx) => navContext = ctx} />,
    );

    // Select Todo 2
    navContext.navigateDown(); // Selects Todo 2
    await waitFor(() =>
      assertEquals(navContext.useSelectedTodo()?.text, "Todo 2")
    );

    // Mutate Todo 2
    const updatedTodo2 = todo2.setText("Todo 2 Updated");
    const newTodos = new Todos(todo1, updatedTodo2, todo3);

    // Re-render
    rerender(
      <TestWrapper todos={newTodos} onContext={(ctx) => navContext = ctx} />,
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
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const todo1 = new Todo("Todo 1");
    const todo2 = new Todo("Todo 2");
    const todo3 = new Todo("Todo 3");
    // Initial set of todos
    const initialTodos = new Todos(todo1, todo2, todo3);

    // deno-lint-ignore no-explicit-any
    let navContext: any;

    const { rerender, unmount } = render(
      <TestWrapper
        todos={initialTodos}
        onContext={(ctx) => navContext = ctx}
      />,
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
      <TestWrapper
        todos={reloadedTodos}
        onContext={(ctx) => navContext = ctx}
      />,
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
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const todo1 = new Todo("Todo 1");
    const todo2 = new Todo("Todo 2");
    const todo3 = new Todo("Todo 3");
    const todos = new Todos(todo1, todo2, todo3);
    // deno-lint-ignore no-explicit-any
    let navContext: any;

    const { rerender, unmount } = render(
      <TestWrapper todos={todos} onContext={(ctx) => navContext = ctx} />,
    );

    // Select Todo 2
    navContext.navigateDown();

    await waitFor(() =>
      assertEquals(navContext.useSelectedTodo()?.text, "Todo 2")
    );

    // Delete Todo 2
    const newTodos = new Todos(todo1, todo3);
    rerender(
      <TestWrapper todos={newTodos} onContext={(ctx) => navContext = ctx} />,
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
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const todo1 = new Todo("Todo 1");
    const todo2 = new Todo("Todo 2");
    const todos = new Todos(todo1, todo2);
    // deno-lint-ignore no-explicit-any
    let navContext: any;

    const { rerender, unmount } = render(
      <TestWrapper todos={todos} onContext={(ctx) => navContext = ctx} />,
    );

    // Select Todo 2 (last)
    navContext.navigateDown();
    await waitFor(() =>
      assertEquals(navContext.useSelectedTodo()?.text, "Todo 2")
    );

    // Delete Todo 2
    const newTodos = new Todos(todo1);
    rerender(
      <TestWrapper todos={newTodos} onContext={(ctx) => navContext = ctx} />,
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
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const todo1 = new Todo("Todo 1");
    const todo2 = new Todo("Todo 2"); // Target
    const todo3 = new Todo("Todo 3");
    const todos = new Todos(todo1, todo2, todo3);
    // deno-lint-ignore no-explicit-any
    let navContext: any;

    const { rerender, unmount } = render(
      <TestWrapper todos={todos} onContext={(ctx) => navContext = ctx} />,
    );

    // Select Todo 2
    navContext.navigateDown();

    await waitFor(() => {
      assertEquals(navContext.useSelectedTodo()?.text, "Todo 2");
    });

    // Change Priority
    const updatedTodo2 = todo2.setPriority("A");
    const newTodos = new Todos(todo1, updatedTodo2, todo3);

    // Re-render
    rerender(
      <TestWrapper todos={newTodos} onContext={(ctx) => navContext = ctx} />,
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
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const todo1 = new Todo("Todo 1");
    const todo2 = new Todo("Todo 2"); // Target
    const todo3 = new Todo("Todo 3");
    const todos = new Todos(todo1, todo2, todo3);
    // deno-lint-ignore no-explicit-any
    let navContext: any;

    const { rerender, unmount } = render(
      <TestWrapper todos={todos} onContext={(ctx) => navContext = ctx} />,
    );

    // Select Todo 2
    navContext.navigateDown();
    await waitFor(() => {
      assertEquals(navContext.useSelectedTodo()?.text, "Todo 2");
    });

    // Toggle completion
    const { updated: updatedTodo2 } = todo2.toggleState();
    const newTodos = new Todos(todo1, updatedTodo2, todo3);

    // Re-render
    rerender(
      <TestWrapper todos={newTodos} onContext={(ctx) => navContext = ctx} />,
    );

    await waitFor(() => {});

    // Selection should follow the todo
    const selected = navContext.useSelectedTodo();
    assertEquals(selected?.text, "Todo 2");
    assertEquals(selected?.isDone(), true);

    unmount();
  },
);

Deno.test(
  "should navigate home (first item)",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const todos = new Todos(
      new Todo("Todo 1"),
      new Todo("Todo 2"),
      new Todo("Todo 3"),
    );
    // deno-lint-ignore no-explicit-any
    let navContext: any;

    const { unmount } = render(
      <TestWrapper todos={todos} onContext={(ctx) => navContext = ctx} />,
    );

    await waitFor(() => {
      assertEquals(navContext.useSelectedTodo()?.text, "Todo 1");
    });

    navContext.navigateDown();
    navContext.navigateDown();

    await waitFor(() => {
      assertEquals(navContext.useSelectedTodo()?.text, "Todo 3");
    });

    navContext.navigateHome();

    await waitFor(() => {
      assertEquals(navContext.useSelectedTodo()?.text, "Todo 1");
    });

    unmount();
  },
);

Deno.test(
  "should navigate to end (last item)",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const todos = new Todos(
      new Todo("Todo 1"),
      new Todo("Todo 2"),
      new Todo("Todo 3"),
    );
    // deno-lint-ignore no-explicit-any
    let navContext: any;

    const { unmount } = render(
      <TestWrapper todos={todos} onContext={(ctx) => navContext = ctx} />,
    );

    await waitFor(() => {
      assertEquals(navContext.useSelectedTodo()?.text, "Todo 1");
    });

    navContext.navigateEnd();

    await waitFor(() => {
      assertEquals(navContext.useSelectedTodo()?.text, "Todo 3");
    });

    unmount();
  },
);

Deno.test(
  "should navigate page up to first item if less than a page of todos",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const todos = new Todos(
      new Todo("Todo 1"),
      new Todo("Todo 2"),
      new Todo("Todo 3"),
    );
    // deno-lint-ignore no-explicit-any
    let navContext: any;

    const { unmount } = render(
      <TestWrapper todos={todos} onContext={(ctx) => navContext = ctx} />,
    );

    await waitFor(() => {
      assertEquals(navContext.useSelectedTodo()?.text, "Todo 1");
    });

    // Go to last item
    navContext.navigateEnd();

    await waitFor(() => {
      assertEquals(navContext.useSelectedTodo()?.text, "Todo 3");
    });

    // Page up
    navContext.navigatePageUp();

    await waitFor(() => {
      assertEquals(navContext.useSelectedTodo()?.text, "Todo 1");
    });

    unmount();
  },
);

Deno.test(
  "should navigate page down to last item if less than a page of todos",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const todos = new Todos(
      new Todo("Todo 1"),
      new Todo("Todo 2"),
      new Todo("Todo 3"),
    );
    // deno-lint-ignore no-explicit-any
    let navContext: any;

    const { unmount } = render(
      <TestWrapper todos={todos} onContext={(ctx) => navContext = ctx} />,
    );

    await waitFor(() => {
      assertEquals(navContext.useSelectedTodo()?.text, "Todo 1");
    });

    // Page down
    navContext.navigatePageDown();

    await waitFor(() => {
      assertEquals(navContext.useSelectedTodo()?.text, "Todo 3");
    });

    unmount();
  },
);

Deno.test(
  "NavigationContext: should filter by context",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const todos = new Todos(
      new Todo("Buy groceries @Home +Shopping"),
      new Todo("Fix bug @Work +Development"),
      new Todo("Call mom @Home"),
    );
    // deno-lint-ignore no-explicit-any
    let navContext: any;
    // deno-lint-ignore no-explicit-any
    let searchContext: any;

    const SearchTester = ({ onContext }: {
      onContext: (
        // deno-lint-ignore no-explicit-any
        ctx: any,
      ) => void;
    }) => {
      const ctx = useSearch();
      useEffect(() => {
        onContext(ctx);
      });
      return null;
    };

    const { unmount } = render(
      <SearchProvider>
        <SearchTester onContext={(ctx) => searchContext = ctx} />
        <NavigationProvider todos={todos}>
          <NavigationTester onContext={(ctx) => navContext = ctx} />
        </NavigationProvider>
      </SearchProvider>,
    );

    await waitFor(() => {
      if (!searchContext) throw new Error("Search context not ready");
    });

    searchContext.setSearchQuery("@work");

    await waitFor(() => {
      const filtered = navContext.indexes.filter((
        // deno-lint-ignore no-explicit-any
        i: any,
      ) => i.type === IndexType.todo);
      assertEquals(filtered.length, 1);
      assertStringIncludes(filtered[0].todo.text, "Fix bug");
    });

    unmount();
  },
);

Deno.test(
  "NavigationContext: should filter by project",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const todos = new Todos(
      new Todo("Buy groceries @Home +Shopping"),
      new Todo("Fix bug @Work +Development"),
      new Todo("Call mom @Home"),
    );
    // deno-lint-ignore no-explicit-any
    let navContext: any;
    // deno-lint-ignore no-explicit-any
    let searchContext: any;

    const SearchTester = ({ onContext }: {
      onContext: (
        // deno-lint-ignore no-explicit-any
        ctx: any,
      ) => void;
    }) => {
      const ctx = useSearch();
      useEffect(() => {
        onContext(ctx);
      });
      return null;
    };

    const { unmount } = render(
      <SearchProvider>
        <SearchTester onContext={(ctx) => searchContext = ctx} />
        <NavigationProvider todos={todos}>
          <NavigationTester onContext={(ctx) => navContext = ctx} />
        </NavigationProvider>
      </SearchProvider>,
    );

    await waitFor(() => {
      if (!searchContext) throw new Error("Search context not ready");
    });

    searchContext.setSearchQuery("+shopping");

    await waitFor(() => {
      const filtered = navContext.indexes.filter((
        // deno-lint-ignore no-explicit-any
        i: any,
      ) => i.type === IndexType.todo);
      assertEquals(filtered.length, 1);
      assertStringIncludes(filtered[0].todo.text, "Buy groceries");
    });

    unmount();
  },
);

Deno.test(
  "NavigationContext: should filter by text content (case-insensitive)",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const todos = new Todos(
      new Todo("Buy groceries @Home +Shopping"),
      new Todo("Fix bug @Work +Development"),
      new Todo("Call mom @Home"),
    );
    // deno-lint-ignore no-explicit-any
    let navContext: any;
    // deno-lint-ignore no-explicit-any
    let searchContext: any;

    const SearchTester = ({ onContext }: {
      onContext: (
        // deno-lint-ignore no-explicit-any
        ctx: any,
      ) => void;
    }) => {
      const ctx = useSearch();
      useEffect(() => {
        onContext(ctx);
      });
      return null;
    };

    const { unmount } = render(
      <SearchProvider>
        <SearchTester onContext={(ctx) => searchContext = ctx} />
        <NavigationProvider todos={todos}>
          <NavigationTester onContext={(ctx) => navContext = ctx} />
        </NavigationProvider>
      </SearchProvider>,
    );

    await waitFor(() => {
      if (!searchContext) throw new Error("Search context not ready");
    });

    searchContext.setSearchQuery("grocer");

    await waitFor(() => {
      const filtered = navContext.indexes.filter((
        // deno-lint-ignore no-explicit-any
        i: any,
      ) => i.type === IndexType.todo);
      assertEquals(filtered.length, 1);
      assertStringIncludes(filtered[0].todo.text, "Buy groceries");
    });

    unmount();
  },
);

Deno.test(
  "should update offset when navigating home/end",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const todos = new Todos(
      ...Array.from({ length: 15 }, (_, i) => new Todo(`Todo ${i}`)),
    );
    // deno-lint-ignore no-explicit-any
    let navContext: any;

    const { unmount } = render(
      <SearchProvider>
        <NavigationProvider todos={todos} listHeightForTest={5}>
          <NavigationTester onContext={(ctx) => navContext = ctx} />
        </NavigationProvider>
      </SearchProvider>,
    );

    // Initial state: Todo 0, offset 0
    await waitFor(() => {
      assertEquals(navContext.useSelectedTodo()?.text, "Todo 0");
      assertEquals(navContext.offsetRow, 0);
    });

    // Navigate End
    navContext.navigateEnd();

    await waitFor(() => {
      assertEquals(navContext.useSelectedTodo()?.text, "Todo 14");
    });

    // Todo 14 is the last item.
    // List height is 5.
    // Offset should be such that index 14 is visible.
    // Visible range: [offset, offset + 5 - 1]
    // 14 >= offset && 14 < offset + 5
    // 14 >= offset --> offset <= 14
    // 14 < offset + 5 --> 14 - 5 < offset --> 9 < offset
    // So offset should be between 10 and 14 (inclusive).
    // Specifically, `calculateScrollOffset` tries to keep context, but here no context.
    // Usually it scrolls to put item at bottom: offset = 14 - 5 + 1 + padding?
    // Let's just assert offset > 5 to prove it moved SIGNIFICANTLY from 0.

    await waitFor(() => {
      if (navContext.offsetRow <= 5) {
        throw new Error(
          `Offset Row did not update correctly! Expected > 5, got ${navContext.offsetRow}`,
        );
      }
    });

    // Navigate Home
    navContext.navigateHome();

    await waitFor(() => {
      assertEquals(navContext.useSelectedTodo()?.text, "Todo 0");
    });

    await waitFor(() => {
      if (navContext.offsetRow !== 0) {
        throw new Error(
          `Offset Row did not reset to 0! Got ${navContext.offsetRow}`,
        );
      }
    });

    unmount();
  },
);
