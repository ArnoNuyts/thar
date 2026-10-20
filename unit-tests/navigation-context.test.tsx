import { expect, test } from "vitest";

import { Text } from "ink";
import { render } from "ink-testing-library";
import { useEffect } from "react";
import {
  NavigationContextType,
  NavigationProvider,
  useNavigation,
} from "../contexts/navigation-context.tsx";
import {
  SearchContextType,
  SearchProvider,
  useSearch,
} from "../contexts/search-context.tsx";
import { Todo } from "../logic/todo.ts";
import type { Todos } from "../logic/Todos.ts";
import { waitFor } from "./test-utils.ts";
import { IndexType } from "../types/enums.ts";
import { IndexEntry, TodoIndexEntry } from "../logic/indexes.ts";

const TestWrapper = ({
  todos,
  onContext,
}: {
  todos: Todos;
  onContext: (ctx: NavigationContextType) => void;
}) => (
  <SearchProvider>
    <NavigationProvider todos={todos}>
      <NavigationTester onContext={onContext} />
    </NavigationProvider>
  </SearchProvider>
);

// Helper component to interact with NavigationContext
const NavigationTester = ({
  onContext,
}: {
  onContext: (ctx: NavigationContextType) => void;
}) => {
  const nav = useNavigation();
  useEffect(() => {
    onContext(nav);
  });
  return <Text>Tester</Text>;
};

test("should initialize with first todo selected", async () => {
  const todos = [new Todo("Todo 1"), new Todo("Todo 2"), new Todo("Todo 3")];
  let navContext: NavigationContextType = null!;

  const { unmount } = render(
    <TestWrapper todos={todos} onContext={(ctx) => (navContext = ctx)} />,
  );

  await waitFor(() => {
    expect(navContext?.indexes?.length).toEqual(4);
  });

  // Verify initial state
  // indexes should have 3 todos + 1 context header = 4
  // selectedTodoId should match Todo 1's ID
  // We can check if getSelectedTodo returns Todo 1
  await waitFor(() => {
    expect(navContext.getSelectedTodo()?.text).toEqual("Todo 1");
  });

  unmount();
});

test("should navigate down", async () => {
  const todos = [new Todo("Todo 1"), new Todo("Todo 2"), new Todo("Todo 3")];
  let navContext: NavigationContextType = null!;

  const { unmount } = render(
    <TestWrapper todos={todos} onContext={(ctx) => (navContext = ctx)} />,
  );

  await waitFor(() =>
    expect(navContext.getSelectedTodo()?.text).toEqual("Todo 1"),
  );

  navContext.navigateDown();

  await waitFor(() =>
    expect(navContext.getSelectedTodo()?.text).toEqual("Todo 2"),
  ); // State update

  unmount();
});

test("should navigate up", async () => {
  const todos = [new Todo("Todo 1"), new Todo("Todo 2")];
  let navContext: NavigationContextType = null!;

  const { unmount } = render(
    <TestWrapper todos={todos} onContext={(ctx) => (navContext = ctx)} />,
  );

  await waitFor(() =>
    expect(navContext.getSelectedTodo()?.text).toEqual("Todo 1"),
  );

  // Start at 1
  navContext.navigateDown();

  await waitFor(() =>
    expect(navContext.getSelectedTodo()?.text).toEqual("Todo 2"),
  );

  navContext.navigateUp();

  await waitFor(() =>
    expect(navContext.getSelectedTodo()?.text).toEqual("Todo 1"),
  );

  unmount();
});

test("should jump between contexts", async () => {
  const todos = [
    new Todo("Alpha @A"),
    new Todo("Beta @A"),
    new Todo("Charlie @B"),
    new Todo("Delta @B"),
    new Todo("Echo @C"),
  ];
  let navContext: NavigationContextType = null!;

  const { unmount } = render(
    <TestWrapper todos={todos} onContext={(ctx) => (navContext = ctx)} />,
  );

  await waitFor(() =>
    expect(navContext.getSelectedTodo()?.text).toEqual("Alpha @A"),
  );

  navContext.navigateContextDown();

  await waitFor(() =>
    expect(navContext.getSelectedTodo()?.text).toEqual("Charlie @B"),
  );

  navContext.navigateContextDown();

  await waitFor(() =>
    expect(navContext.getSelectedTodo()?.text).toEqual("Echo @C"),
  );

  navContext.navigateContextDown();

  await waitFor(() =>
    expect(navContext.getSelectedTodo()?.text).toEqual("Echo @C"),
  );

  navContext.navigateContextUp();

  await waitFor(() =>
    expect(navContext.getSelectedTodo()?.text).toEqual("Charlie @B"),
  );

  navContext.navigateDown();
  await waitFor(() =>
    expect(navContext.getSelectedTodo()?.text).toEqual("Delta @B"),
  );

  navContext.navigateContextUp();

  await waitFor(() =>
    expect(navContext.getSelectedTodo()?.text).toEqual("Alpha @A"),
  );

  navContext.navigateContextUp();

  await waitFor(() =>
    expect(navContext.getSelectedTodo()?.text).toEqual("Alpha @A"),
  );

  unmount();
});

test("should clamp navigation at bounds", async () => {
  const todos = [new Todo("Todo 1"), new Todo("Todo 2")];
  let navContext: NavigationContextType = null!;

  const { unmount } = render(
    <TestWrapper todos={todos} onContext={(ctx) => (navContext = ctx)} />,
  );

  await waitFor(() =>
    expect(navContext.getSelectedTodo()?.text).toEqual("Todo 1"),
  );

  // Up from top
  navContext.navigateUp();
  await waitFor(() =>
    expect(navContext.getSelectedTodo()?.text).toEqual("Todo 1"),
  );

  // Down to bottom
  navContext.navigateDown();
  await waitFor(() =>
    expect(navContext.getSelectedTodo()?.text).toEqual("Todo 2"),
  );

  // Down past bottom
  navContext.navigateDown(); // Should stay at 2
  await waitFor(() =>
    expect(navContext.getSelectedTodo()?.text).toEqual("Todo 2"),
  );

  unmount();
});

test("should stay on first todo when navigating up past a leading context header", async () => {
  const todos = [new Todo("Alpha @A"), new Todo("Beta @A")];
  let navContext: NavigationContextType = null!;

  const { unmount } = render(
    <TestWrapper todos={todos} onContext={(ctx) => (navContext = ctx)} />,
  );

  await waitFor(() => {
    expect(navContext.getSelectedTodo()?.text).toEqual("Alpha @A");
    expect(navContext.indexes[0]?.type).toEqual(IndexType.context);
  });

  navContext.navigateUp();
  await waitFor(() =>
    expect(navContext.getSelectedTodo()?.text).toEqual("Alpha @A"),
  );

  navContext.navigatePageUp();
  await waitFor(() =>
    expect(navContext.getSelectedTodo()?.text).toEqual("Alpha @A"),
  );

  unmount();
});

test("should stay on last todo when navigating down at the end of a context group", async () => {
  const todos = [
    new Todo("Alpha @A"),
    new Todo("Beta @A"),
    new Todo("Gamma @B"),
  ];
  let navContext: NavigationContextType = null!;

  const { unmount } = render(
    <TestWrapper todos={todos} onContext={(ctx) => (navContext = ctx)} />,
  );

  await waitFor(() => {
    expect(navContext.getSelectedTodo()?.text).toEqual("Alpha @A");
    expect(navContext.indexes.at(-2)?.type).toEqual(IndexType.context);
  });

  navContext.navigateEnd();
  await waitFor(() =>
    expect(navContext.getSelectedTodo()?.text).toEqual("Gamma @B"),
  );

  navContext.navigateDown();
  await waitFor(() =>
    expect(navContext.getSelectedTodo()?.text).toEqual("Gamma @B"),
  );

  navContext.navigatePageDown();
  await waitFor(() =>
    expect(navContext.getSelectedTodo()?.text).toEqual("Gamma @B"),
  );

  unmount();
});

test("should preserve selection after todo update", async () => {
  const todo1 = new Todo("Todo 1");
  const todo2 = new Todo("Todo 2"); // Target for selection
  const todo3 = new Todo("Todo 3");
  const todos = [todo1, todo2, todo3];
  let navContext: NavigationContextType = null!;

  const { rerender, unmount } = render(
    <TestWrapper todos={todos} onContext={(ctx) => (navContext = ctx)} />,
  );

  // Select Todo 2
  navContext.navigateDown(); // Selects Todo 2
  await waitFor(() =>
    expect(navContext.getSelectedTodo()?.text).toEqual("Todo 2"),
  );

  // Mutate Todo 2
  const updatedTodo2 = todo2.setText("Todo 2 Updated");
  const newTodos = [todo1, updatedTodo2, todo3];

  // Re-render
  rerender(
    <TestWrapper todos={newTodos} onContext={(ctx) => (navContext = ctx)} />,
  );

  await waitFor(() => {
    // Verify selection is preserved on the *same* todo
    const selected = navContext.getSelectedTodo();

    // If bug exists, it will likely select "Todo 1" (first item fallback)
    if (selected?.text === "Todo 1") {
      throw new Error(
        `Selection reset to first item! Expected "Todo 2 Updated", got "${selected?.text}"`,
      );
    }
    expect(selected?.text).toEqual("Todo 2 Updated");
  });

  unmount();
});

test("should preserve selection after file reload (new instances, same hash)", async () => {
  const todo1 = new Todo("Todo 1");
  const todo2 = new Todo("Todo 2");
  const todo3 = new Todo("Todo 3");
  // Initial set of todos
  const initialTodos = [todo1, todo2, todo3];

  let navContext: NavigationContextType = null!;

  const { rerender, unmount } = render(
    <TestWrapper
      todos={initialTodos}
      onContext={(ctx) => (navContext = ctx)}
    />,
  );

  // Select "Todo 2"
  navContext.navigateDown();

  await waitFor(() =>
    expect(navContext.getSelectedTodo()?.text).toEqual("Todo 2"),
  );

  // Simulate file reload: New instances, same content
  const newTodo1 = new Todo("Todo 1");
  const newTodo2 = new Todo("Todo 2"); // Same content as old selected
  const newTodo3 = new Todo("Todo 3");
  const reloadedTodos = [newTodo1, newTodo2, newTodo3];

  // Re-render with new instances
  rerender(
    <TestWrapper
      todos={reloadedTodos}
      onContext={(ctx) => (navContext = ctx)}
    />,
  );

  await waitFor(() => {
    // Verify "Todo 2" is still selected (by hash fallback)
    const selected = navContext.getSelectedTodo();

    if (selected?.text === "Todo 1") {
      throw new Error("Selection reset to first item after reload!");
    }
    expect(selected?.text).toEqual("Todo 2");
    // Verify it is indeed the NEW instance
    expect(selected === newTodo2).toEqual(true);
  });

  unmount();
});

test("should select next todo after deletion", async () => {
  const todo1 = new Todo("Todo 1");
  const todo2 = new Todo("Todo 2");
  const todo3 = new Todo("Todo 3");
  const todos = [todo1, todo2, todo3];
  let navContext: NavigationContextType = null!;

  const { rerender, unmount } = render(
    <TestWrapper todos={todos} onContext={(ctx) => (navContext = ctx)} />,
  );

  // Select Todo 2
  navContext.navigateDown();

  await waitFor(() =>
    expect(navContext.getSelectedTodo()?.text).toEqual("Todo 2"),
  );

  // Delete Todo 2
  const newTodos = [todo1, todo3];
  rerender(
    <TestWrapper todos={newTodos} onContext={(ctx) => (navContext = ctx)} />,
  );
  await waitFor(() => {
    // Should select Todo 3 (next item)
    const selected = navContext.getSelectedTodo();
    expect(selected?.text).toEqual("Todo 3");
  });

  unmount();
});

test("should select previous todo when deleting last item", async () => {
  const todo1 = new Todo("Todo 1");
  const todo2 = new Todo("Todo 2");
  const todos = [todo1, todo2];
  let navContext: NavigationContextType = null!;

  const { rerender, unmount } = render(
    <TestWrapper todos={todos} onContext={(ctx) => (navContext = ctx)} />,
  );

  // Select Todo 2 (last)
  navContext.navigateDown();
  await waitFor(() =>
    expect(navContext.getSelectedTodo()?.text).toEqual("Todo 2"),
  );

  // Delete Todo 2
  const newTodos = [todo1];
  rerender(
    <TestWrapper todos={newTodos} onContext={(ctx) => (navContext = ctx)} />,
  );
  await waitFor(() =>
    // Should select Todo 1 (previous/last remaining)
    expect(navContext.getSelectedTodo()?.text).toEqual("Todo 1"),
  );

  unmount();
});

test("should preserve selection after priority update", async () => {
  const todo1 = new Todo("Todo 1");
  const todo2 = new Todo("Todo 2"); // Target
  const todo3 = new Todo("Todo 3");
  const todos = [todo1, todo2, todo3];
  let navContext: NavigationContextType = null!;

  const { rerender, unmount } = render(
    <TestWrapper todos={todos} onContext={(ctx) => (navContext = ctx)} />,
  );

  // Select Todo 2
  navContext.navigateDown();

  await waitFor(() => {
    expect(navContext.getSelectedTodo()?.text).toEqual("Todo 2");
  });

  // Change Priority
  const updatedTodo2 = todo2.setPriority("A");
  const newTodos = [todo1, updatedTodo2, todo3];

  // Re-render
  rerender(
    <TestWrapper todos={newTodos} onContext={(ctx) => (navContext = ctx)} />,
  );

  await waitFor(() => {
    // Selection should follow the todo
    const selected = navContext.getSelectedTodo();
    expect(selected?.text).toEqual("Todo 2");
    expect(selected?.priority).toEqual("A");
  });

  unmount();
});

test("should preserve selection after toggling completion", async () => {
  const todo1 = new Todo("Todo 1");
  const todo2 = new Todo("Todo 2"); // Target
  const todo3 = new Todo("Todo 3");
  const todos = [todo1, todo2, todo3];
  let navContext: NavigationContextType = null!;

  const { rerender, unmount } = render(
    <TestWrapper todos={todos} onContext={(ctx) => (navContext = ctx)} />,
  );

  // Select Todo 2
  navContext.navigateDown();
  await waitFor(() => {
    expect(navContext.getSelectedTodo()?.text).toEqual("Todo 2");
  });

  // Toggle completion
  const { updated: updatedTodo2 } = todo2.toggleState();
  const newTodos = [todo1, updatedTodo2, todo3];

  // Re-render
  rerender(
    <TestWrapper todos={newTodos} onContext={(ctx) => (navContext = ctx)} />,
  );

  await waitFor(() => {});

  // Selection should follow the todo
  const selected = navContext.getSelectedTodo();
  expect(selected?.text).toEqual("Todo 2");
  expect(selected?.isDone()).toEqual(true);

  unmount();
});

test("should navigate home (first item)", async () => {
  const todos = [new Todo("Todo 1"), new Todo("Todo 2"), new Todo("Todo 3")];
  let navContext: NavigationContextType = null!;

  const { unmount } = render(
    <TestWrapper todos={todos} onContext={(ctx) => (navContext = ctx)} />,
  );

  await waitFor(() => {
    expect(navContext.getSelectedTodo()?.text).toEqual("Todo 1");
  });

  navContext.navigateDown();
  navContext.navigateDown();

  await waitFor(() => {
    expect(navContext.getSelectedTodo()?.text).toEqual("Todo 3");
  });

  navContext.navigateHome();

  await waitFor(() => {
    expect(navContext.getSelectedTodo()?.text).toEqual("Todo 1");
  });

  unmount();
});

test("should navigate to end (last item)", async () => {
  const todos = [new Todo("Todo 1"), new Todo("Todo 2"), new Todo("Todo 3")];
  let navContext: NavigationContextType = null!;

  const { unmount } = render(
    <TestWrapper todos={todos} onContext={(ctx) => (navContext = ctx)} />,
  );

  await waitFor(() => {
    expect(navContext.getSelectedTodo()?.text).toEqual("Todo 1");
  });

  navContext.navigateEnd();

  await waitFor(() => {
    expect(navContext.getSelectedTodo()?.text).toEqual("Todo 3");
  });

  unmount();
});

test("should navigate page up to first item if less than a page of todos", async () => {
  const todos = [new Todo("Todo 1"), new Todo("Todo 2"), new Todo("Todo 3")];
  let navContext: NavigationContextType = null!;

  const { unmount } = render(
    <TestWrapper todos={todos} onContext={(ctx) => (navContext = ctx)} />,
  );

  await waitFor(() => {
    expect(navContext.getSelectedTodo()?.text).toEqual("Todo 1");
  });

  // Go to last item
  navContext.navigateEnd();

  await waitFor(() => {
    expect(navContext.getSelectedTodo()?.text).toEqual("Todo 3");
  });

  // Page up
  navContext.navigatePageUp();

  await waitFor(() => {
    expect(navContext.getSelectedTodo()?.text).toEqual("Todo 1");
  });

  unmount();
});

test("should navigate page down to last item if less than a page of todos", async () => {
  const todos = [new Todo("Todo 1"), new Todo("Todo 2"), new Todo("Todo 3")];
  let navContext: NavigationContextType = null!;

  const { unmount } = render(
    <TestWrapper todos={todos} onContext={(ctx) => (navContext = ctx)} />,
  );

  await waitFor(() => {
    expect(navContext.getSelectedTodo()?.text).toEqual("Todo 1");
  });

  // Page down
  navContext.navigatePageDown();

  await waitFor(() => {
    expect(navContext.getSelectedTodo()?.text).toEqual("Todo 3");
  });

  unmount();
});

test("NavigationContext: should filter by context", async () => {
  const todos = [
    new Todo("Buy groceries @Home +Shopping"),
    new Todo("Fix bug @Work +Development"),
    new Todo("Call mom @Home"),
  ];
  let navContext: NavigationContextType = null!;
  let searchContext: SearchContextType = null!;

  const SearchTester = ({
    onContext,
  }: {
    onContext: (ctx: SearchContextType) => void;
  }) => {
    const ctx = useSearch();
    useEffect(() => {
      onContext(ctx);
    });
    return null;
  };

  const { unmount } = render(
    <SearchProvider>
      <SearchTester onContext={(ctx) => (searchContext = ctx)} />
      <NavigationProvider todos={todos}>
        <NavigationTester onContext={(ctx) => (navContext = ctx)} />
      </NavigationProvider>
    </SearchProvider>,
  );

  await waitFor(() => {
    if (!searchContext) throw new Error("Search context not ready");
  });

  searchContext.setSearchQuery("@work");

  await waitFor(() => {
    const filtered = navContext.indexes.filter(
      (i: IndexEntry): i is TodoIndexEntry => i.type === IndexType.todo,
    );
    expect(filtered.length).toEqual(1);
    expect(filtered[0].todo.text).toContain("Fix bug");
  });

  unmount();
});

test("NavigationContext: should filter by project", async () => {
  const todos = [
    new Todo("Buy groceries @Home +Shopping"),
    new Todo("Fix bug @Work +Development"),
    new Todo("Call mom @Home"),
  ];
  let navContext: NavigationContextType = null!;
  let searchContext: SearchContextType = null!;

  const SearchTester = ({
    onContext,
  }: {
    onContext: (ctx: SearchContextType) => void;
  }) => {
    const ctx = useSearch();
    useEffect(() => {
      onContext(ctx);
    });
    return null;
  };

  const { unmount } = render(
    <SearchProvider>
      <SearchTester onContext={(ctx) => (searchContext = ctx)} />
      <NavigationProvider todos={todos}>
        <NavigationTester onContext={(ctx) => (navContext = ctx)} />
      </NavigationProvider>
    </SearchProvider>,
  );

  await waitFor(() => {
    if (!searchContext) throw new Error("Search context not ready");
  });

  searchContext.setSearchQuery("+shopping");

  await waitFor(() => {
    const filtered = navContext.indexes.filter(
      (i: IndexEntry): i is TodoIndexEntry => i.type === IndexType.todo,
    );
    expect(filtered.length).toEqual(1);
    expect(filtered[0].todo.text).toContain("Buy groceries");
  });

  unmount();
});

test("NavigationContext: should filter by text content (case-insensitive)", async () => {
  const todos = [
    new Todo("Buy groceries @Home +Shopping"),
    new Todo("Fix bug @Work +Development"),
    new Todo("Call mom @Home"),
  ];
  let navContext: NavigationContextType = null!;
  let searchContext: SearchContextType = null!;

  const SearchTester = ({
    onContext,
  }: {
    onContext: (ctx: SearchContextType) => void;
  }) => {
    const ctx = useSearch();
    useEffect(() => {
      onContext(ctx);
    });
    return null;
  };

  const { unmount } = render(
    <SearchProvider>
      <SearchTester onContext={(ctx) => (searchContext = ctx)} />
      <NavigationProvider todos={todos}>
        <NavigationTester onContext={(ctx) => (navContext = ctx)} />
      </NavigationProvider>
    </SearchProvider>,
  );

  await waitFor(() => {
    if (!searchContext) throw new Error("Search context not ready");
  });

  searchContext.setSearchQuery("grocer");

  await waitFor(() => {
    const filtered = navContext.indexes.filter(
      (i: IndexEntry): i is TodoIndexEntry => i.type === IndexType.todo,
    );
    expect(filtered.length).toEqual(1);
    expect(filtered[0].todo.text).toContain("Buy groceries");
  });

  unmount();
});

test("NavigationContext: should match whitespace-separated terms in any order", async () => {
  const todos = [
    new Todo("bla @Work doing +Bug"),
    new Todo("bla @Work doing +Feature"),
    new Todo("random @Home +Bug"),
  ];
  let navContext: NavigationContextType = null!;
  let searchContext: SearchContextType = null!;

  const SearchTester = ({
    onContext,
  }: {
    onContext: (ctx: SearchContextType) => void;
  }) => {
    const ctx = useSearch();
    useEffect(() => {
      onContext(ctx);
    });
    return null;
  };

  const { unmount } = render(
    <SearchProvider>
      <SearchTester onContext={(ctx) => (searchContext = ctx)} />
      <NavigationProvider todos={todos}>
        <NavigationTester onContext={(ctx) => (navContext = ctx)} />
      </NavigationProvider>
    </SearchProvider>,
  );

  await waitFor(() => {
    if (!searchContext) throw new Error("Search context not ready");
  });

  searchContext.setSearchQuery("/@work +bug/");

  await waitFor(() => {
    const filtered = navContext.indexes.filter(
      (i: IndexEntry): i is TodoIndexEntry => i.type === IndexType.todo,
    );
    expect(filtered.length).toEqual(1);
    expect(filtered[0].todo.text).toContain("@Work");
    expect(filtered[0].todo.text).toContain("+Bug");
  });

  unmount();
});

test("should update offset when navigating home/end", async () => {
  const todos = [
    ...Array.from({ length: 15 }, (_, i) => new Todo(`Todo ${i}`)),
  ];
  let navContext: NavigationContextType = null!;

  const { unmount } = render(
    <SearchProvider>
      <NavigationProvider todos={todos} listHeightForTest={5}>
        <NavigationTester onContext={(ctx) => (navContext = ctx)} />
      </NavigationProvider>
    </SearchProvider>,
  );

  // Initial state: Todo 0, offset 0
  await waitFor(() => {
    expect(navContext.getSelectedTodo()?.text).toEqual("Todo 0");
    expect(navContext.offsetRow).toEqual(0);
  });

  // Navigate End
  navContext.navigateEnd();

  await waitFor(() => {
    expect(navContext.getSelectedTodo()?.text).toEqual("Todo 14");
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
    expect(navContext.getSelectedTodo()?.text).toEqual("Todo 0");
  });

  await waitFor(() => {
    if (navContext.offsetRow !== 0) {
      throw new Error(
        `Offset Row did not reset to 0! Got ${navContext.offsetRow}`,
      );
    }
  });

  unmount();
});

test("should enforce scroll padding for last item of first page (snap-to-zero bug)", async () => {
  // 10 items. Height 6 (header + 5 todos).
  // Visible initially: Index 0 (Header), 1, 2, 3, 4, 5.
  const todos = [
    ...Array.from({ length: 10 }, (_, i) => new Todo(`Todo ${i}`)),
  ];
  let navContext: NavigationContextType = null!;

  const { unmount } = render(
    <SearchProvider>
      <NavigationProvider todos={todos} listHeightForTest={6}>
        <NavigationTester onContext={(ctx) => (navContext = ctx)} />
      </NavigationProvider>
    </SearchProvider>,
  );

  await waitFor(() => {
    expect(navContext.getSelectedTodo()?.text).toEqual("Todo 0");
  });

  // Navigate down 4 times to select Todo 4
  navContext.navigateDown();
  navContext.navigateDown();
  navContext.navigateDown();
  navContext.navigateDown();

  await waitFor(() => {
    expect(navContext.getSelectedTodo()?.text).toEqual("Todo 4");
  });

  // Todo 4 is at index 5 (0 is header).
  // ListHeight 6.
  // Window [offset, offset+6].
  // If offset 0: [0, 1, 2, 3, 4, 5]. Index 6 NOT visible.
  // Padding (1) requires 1 item below selected.
  // Selected Index 5. Need Index 6 (Todo 5).
  // Expect offset > 0.

  await waitFor(() => {
    if (navContext.offsetRow === 0) {
      throw new Error(
        `Offset should handle padding for last item! Expected > 0, got 0`,
      );
    }
  });

  unmount();
});

test("should clear multi-selection when search hides selected items", async () => {
  const todos = [new Todo("Apple"), new Todo("Banana"), new Todo("Cherry")];
  let context: { nav: NavigationContextType; search: SearchContextType } =
    null!;

  const CombinedTester = ({
    onContext,
  }: {
    onContext: (ctx: {
      nav: NavigationContextType;
      search: SearchContextType;
    }) => void;
  }) => {
    const nav = useNavigation();
    const search = useSearch();
    useEffect(() => {
      onContext({ nav, search });
    });
    return <Text>Tester</Text>;
  };

  const { unmount } = render(
    <SearchProvider>
      <NavigationProvider todos={todos}>
        <CombinedTester onContext={(ctx) => (context = ctx)} />
      </NavigationProvider>
    </SearchProvider>,
  );

  // Initial state: Apple selected (Index 1, 0 is header)
  await waitFor(() => {
    expect(context.nav.getSelectedTodo()?.text).toEqual("Apple");
  });

  // Select Banana (Shift+Down)
  // Apple is currently selected. Down -> Banana.
  context.nav.navigateDown(true); // shift=true

  await waitFor(() => {
    expect(context.nav.getSelectedTodo()?.text).toEqual("Banana");
    // Verify multi-select (Range should have 2 items: Apple and Banana)
    expect(context.nav.selectedTodoIds.size).toEqual(2);
  });

  // Apply search "Apple". This should hide Banana.
  context.search.setSearchQuery("Apple");

  // Expectation: because Banana is hidden, multi-select is invalid/confusing.
  // It should be cleared.
  // Cursor should probably move to Apple (only visible match)? Or stay on valid item.

  await waitFor(() => {
    // Assert rangeIds is empty or size 0
    if (context.nav.selectedTodoIds.size !== 0) {
      throw new Error(
        `Multi-select should be cleared! Got size ${context.nav.selectedTodoIds.size}`,
      );
    }
    // Assert selected item is Apple (only one left)
    expect(context.nav.getSelectedTodo()?.text).toEqual("Apple");
  });

  unmount();
});

test("should PRESERVE multi-selection when search keeps all selected items visible", async () => {
  const todos = [new Todo("Apple"), new Todo("Apricot"), new Todo("Banana")];
  let context: { nav: NavigationContextType; search: SearchContextType } =
    null!;

  const CombinedTester = ({
    onContext,
  }: {
    onContext: (ctx: {
      nav: NavigationContextType;
      search: SearchContextType;
    }) => void;
  }) => {
    const nav = useNavigation();
    const search = useSearch();
    useEffect(() => {
      onContext({ nav, search });
    });
    return <Text>Tester</Text>;
  };

  const { unmount } = render(
    <SearchProvider>
      <NavigationProvider todos={todos}>
        <CombinedTester onContext={(ctx) => (context = ctx)} />
      </NavigationProvider>
    </SearchProvider>,
  );

  // Initial state: Apple selected
  await waitFor(() => {
    expect(context.nav.getSelectedTodo()?.text).toEqual("Apple");
  });

  // Select Apricot (Shift+Down)
  context.nav.navigateDown(true);

  await waitFor(() => {
    expect(context.nav.getSelectedTodo()?.text).toEqual("Apricot");
    expect(context.nav.selectedTodoIds.size).toEqual(2); // Apple + Apricot
  });

  // Apply search "Ap". Both Apple and Apricot match. Banana hidden.
  // Selection should remain.
  context.search.setSearchQuery("Ap");

  await waitFor(() => {
    // Assert rangeIds is preserved
    if (context.nav.selectedTodoIds.size !== 2) {
      throw new Error(
        `Multi-select should be preserved (size 2)! Got size ${context.nav.selectedTodoIds.size}`,
      );
    }
    // Assert selection is still Apricot (or Apple, but cursor usually stays)
    // Since Apricot is visible, cursor should stay on it.
    expect(context.nav.getSelectedTodo()?.text).toEqual("Apricot");
  });

  unmount();
});

test("should scroll to keep selection visible when search is cleared", async () => {
  // 20 items. Height 5.
  const todos = [
    ...Array.from({ length: 20 }, (_, i) => new Todo(`Todo ${i}`)),
  ];
  let context: { nav: NavigationContextType; search: SearchContextType } =
    null!;

  const CombinedTester = ({
    onContext,
  }: {
    onContext: (ctx: {
      nav: NavigationContextType;
      search: SearchContextType;
    }) => void;
  }) => {
    const nav = useNavigation();
    const search = useSearch();
    useEffect(() => {
      onContext({ nav, search });
    }, [nav, search]);
    return <Text>Tester</Text>;
  };

  const { unmount } = render(
    <SearchProvider>
      <NavigationProvider todos={todos} listHeightForTest={5}>
        <CombinedTester onContext={(ctx) => (context = ctx)} />
      </NavigationProvider>
    </SearchProvider>,
  );

  // Initial state
  await waitFor(() => {
    expect(!!context?.nav?.indexes).toEqual(true);
  });

  // Search for "Todo 15". Only 1 match.
  context.search.setSearchQuery("Todo 15");

  await waitFor(() => {
    expect(context.nav.getSelectedTodo()?.text).toEqual("Todo 15");
    // Offset should be 0 because list is short (1 match + 1 date header maybe?)
    expect(context.nav.offsetRow).toEqual(0);
  });

  // Clear Search.
  // List becomes 20 items + 1 header = 21. Todo 15 is at Index 16.
  // Index 16 must be visible.
  context.search.setSearchQuery("");

  await waitFor(() => {
    expect(context.nav.getSelectedTodo()?.text).toEqual("Todo 15");
    const offset = context.nav.offsetRow;
    const visible = 16 >= offset && 16 < offset + 5;
    if (!visible) {
      throw new Error(`Item 16 should be visible. Current offset: ${offset}`);
    }
  });

  unmount();
});

test("should scroll to keep multi-select visible when search is cleared", async () => {
  const todos = [
    ...Array.from({ length: 20 }, (_, i) => new Todo(`Todo ${i}`)),
  ];
  let context: { nav: NavigationContextType; search: SearchContextType } =
    null!;

  const CombinedTester = ({
    onContext,
  }: {
    onContext: (ctx: {
      nav: NavigationContextType;
      search: SearchContextType;
    }) => void;
  }) => {
    const nav = useNavigation();
    const search = useSearch();
    useEffect(() => {
      onContext({ nav, search });
    }, [nav, search]);
    return <Text>Tester</Text>;
  };

  // Height 10 to fit both if possible
  const { unmount } = render(
    <SearchProvider>
      <NavigationProvider todos={todos} listHeightForTest={10}>
        <CombinedTester onContext={(ctx) => (context = ctx)} />
      </NavigationProvider>
    </SearchProvider>,
  );

  // Initial
  await waitFor(() => expect(!!context).toEqual(true));

  // Search matches "Todo 1" -> 1, 10, 11...
  context.search.setSearchQuery("Todo 1");

  await waitFor(() => {
    expect(context.nav.getSelectedTodo()?.text).toEqual("Todo 1");
  });

  // Select down once. "Todo 1" is item 1. next matches...
  context.nav.navigateDown(true); // select Todo 10

  await waitFor(() => {
    expect(context.nav.selectedTodoIds.size).toEqual(2);
  });

  // Clear search.
  // Todo 1: Index 2. Todo 10: Index 11.
  // Range [2, 11] fits in Height 10.
  context.search.setSearchQuery("");

  await waitFor(() => {
    // Both ends should be visible. Offset should be 2.
    expect(context.nav.offsetRow).toEqual(2);
  });

  unmount();
});

test("should prioritize cursor visibility over multi-select range when search is cleared", async () => {
  const todos = [
    ...Array.from({ length: 20 }, (_, i) => new Todo(`Todo ${i}`)),
  ];
  let context: { nav: NavigationContextType; search: SearchContextType } =
    null!;

  const CombinedTester = ({
    onContext,
  }: {
    onContext: (ctx: {
      nav: NavigationContextType;
      search: SearchContextType;
    }) => void;
  }) => {
    const nav = useNavigation();
    const search = useSearch();
    useEffect(() => {
      onContext({ nav, search });
    }, [nav, search]);
    return <Text>Tester</Text>;
  };

  // Small height 5. Range cannot fit.
  const { unmount } = render(
    <SearchProvider>
      <NavigationProvider todos={todos} listHeightForTest={5}>
        <CombinedTester onContext={(ctx) => (context = ctx)} />
      </NavigationProvider>
    </SearchProvider>,
  );

  await waitFor(() => expect(!!context).toEqual(true));

  context.search.setSearchQuery("Todo 1");
  await waitFor(() =>
    expect(context.nav.getSelectedTodo()?.text).toEqual("Todo 1"),
  );

  // Select down twice.
  context.nav.navigateDown(true);
  context.nav.navigateDown(true);

  await waitFor(() => {
    expect(context.nav.selectedTodoIds.size).toEqual(3);
  });

  const cursorId = context.nav.selectedTodoId;

  // Clear search.
  context.search.setSearchQuery("");

  await waitFor(() => {
    // Cursor MUST be visible.
    const cursorRow = context.nav.indexes.findIndex(
      (e: IndexEntry) => e.type === IndexType.todo && e.todo.id === cursorId,
    );
    const offset = context.nav.offsetRow;
    const visible = cursorRow >= offset && cursorRow < offset + 5;
    if (!visible) {
      throw new Error(
        `Cursor at row ${cursorRow} should be visible. Offset: ${offset}`,
      );
    }
  });

  unmount();
});

test("should fit exact 10-item multi-selection in 10-row window after clearing search", async () => {
  // 30 items: 10 'Match' items in the middle, surrounded by 'Other' items.
  const todos = [
    ...Array.from({ length: 10 }, (_, i) => new Todo(`OtherA ${i}`)),
    ...Array.from({ length: 10 }, (_, i) => new Todo(`Match ${i}`)),
    ...Array.from({ length: 10 }, (_, i) => new Todo(`OtherB ${i}`)),
  ];
  let context: { nav: NavigationContextType; search: SearchContextType } =
    null!;

  const CombinedTester = ({
    onContext,
  }: {
    onContext: (ctx: {
      nav: NavigationContextType;
      search: SearchContextType;
    }) => void;
  }) => {
    const nav = useNavigation();
    const search = useSearch();
    useEffect(() => {
      onContext({ nav, search });
    }, [nav, search]);
    return <Text>Tester</Text>;
  };

  const { unmount } = render(
    <SearchProvider>
      <NavigationProvider todos={todos} listHeightForTest={10}>
        <CombinedTester onContext={(ctx) => (context = ctx)} />
      </NavigationProvider>
    </SearchProvider>,
  );

  // Initial state
  await waitFor(() => {
    expect(!!context?.nav?.indexes).toEqual(true);
  });

  // 1. Search for "Match". Filters list to exactly 10 items (+ 1 date header = 11 rows total)
  context.search.setSearchQuery("Match");

  await waitFor(() => {
    // Should show Match 0
    expect(context.nav.getSelectedTodo()?.text).toEqual("Match 0");
  });

  // 2. Select all 10 "Match" items.
  for (let i = 0; i < 9; i++) {
    context.nav.navigateDown(true);
  }

  await waitFor(() => {
    expect(context.nav.selectedTodoIds.size).toEqual(10);
    expect(context.nav.getSelectedTodo()?.text).toEqual("Match 9");
  });

  // 3. Clear search.
  // In the full list (31 rows total: 1 header + 30 todos):
  // OtherA 0..9 are indices 1..10.
  // Match 0..9 are indices 11..20.
  // Range [11, 20] size 10. Height 10.
  context.search.setSearchQuery("");

  await waitFor(() => {
    expect(context.nav.selectedTodoIds.size).toEqual(10);
    // Row 11 to Row 20 should be visible.
    // With Height 10, offset MUST be Row 11.
    expect(context.nav.offsetRow).toEqual(11);
  });

  unmount();
});
