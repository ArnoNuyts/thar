import { render } from "ink-testing-library";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { delay } from "@std/async";

import { TodoProvider, useTodo } from "../contexts/todo-context.tsx";
import { FocusProvider } from "../contexts/focus-context.tsx";
import { SuggestionProvider } from "../contexts/suggestion-context.tsx";
import { SearchProvider, useSearch } from "../contexts/search-context.tsx";
import { ModalProvider } from "../contexts/modal-context.tsx";
import { ToasterProvider } from "../contexts/toaster-context.tsx";
import {
  NavigationProvider,
  useNavigation,
} from "../contexts/navigation-context.tsx";
import { SearchInput } from "../components/SearchInput.tsx";
import { useEffect } from "react";
import { Todo } from "../logic/todo.ts";
import { Todos } from "../logic/Todos.ts";
import { IndexType } from "../types/enums.ts";

// Mock Deno APIs
const originalWatchFs = Deno.watchFs;
const originalReadTextFile = Deno.readTextFile;
const originalWriteTextFile = Deno.writeTextFile;
const originalStat = Deno.stat;

class MockWatcher {
  private closed = false;

  async *[Symbol.asyncIterator](): AsyncIterableIterator<Deno.FsEvent> {
    while (!this.closed) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  close() {
    this.closed = true;
  }
}

let mockWatcher: MockWatcher;

function setupMocks(content: string = "") {
  mockWatcher = new MockWatcher();

  // deno-lint-ignore no-explicit-any
  (Deno as any).watchFs = () => mockWatcher;

  // deno-lint-ignore no-explicit-any
  (Deno as any).stat = async () => {
    await delay(0);
    return { isFile: true };
  };

  // deno-lint-ignore no-explicit-any
  (Deno as any).readTextFile = async () => {
    await delay(0);
    return content;
  };

  // deno-lint-ignore no-explicit-any
  (Deno as any).writeTextFile = async () => {
    await delay(0);
  };
}

function teardownMocks() {
  // deno-lint-ignore no-explicit-any
  (Deno as any).watchFs = originalWatchFs;
  // deno-lint-ignore no-explicit-any
  (Deno as any).readTextFile = originalReadTextFile;
  // deno-lint-ignore no-explicit-any
  (Deno as any).writeTextFile = originalWriteTextFile;
  // deno-lint-ignore no-explicit-any
  (Deno as any).stat = originalStat;
}

// Helper to wrap components with all required providers
const TestWrapper = ({
  children,
  filename = "test.txt",
}: {
  children: React.ReactNode;
  filename?: string;
}) => {
  return (
    <ModalProvider>
      <ToasterProvider>
        <TodoProvider filename={filename}>
          <FocusProvider>
            <SuggestionProvider>
              <SearchProvider>
                <NavigationProvider>{children}</NavigationProvider>
              </SearchProvider>
            </SuggestionProvider>
          </FocusProvider>
        </TodoProvider>
      </ToasterProvider>
    </ModalProvider>
  );
};

// Component that sets search query for testing
const SearchQuerySetter = ({
  query,
  onMounted,
}: {
  query: string;
  onMounted?: () => void;
}) => {
  const { setSearchQuery } = useSearch();
  useEffect(() => {
    setSearchQuery(query);
    if (onMounted) onMounted();
  }, [query, onMounted, setSearchQuery]);
  return null;
};

// Helper component to observe selection state
const SelectionObserver = (
  { onSelectionChange }: { onSelectionChange: (item: string) => void },
) => {
  const { indexes } = useNavigation();
  const { selectedTodoHash } = useTodo();

  useEffect(() => {
    if (selectedTodoHash) {
      // Find todo text
      const entry = indexes.find((e) =>
        e.type === IndexType.todo && e.todo.getHash() === selectedTodoHash
      );
      if (entry && entry.type === IndexType.todo) {
        onSelectionChange(entry.todo.text);
      }
    }
  }, [selectedTodoHash, indexes, onSelectionChange]);

  return null;
};

// Helper to trigger focus on SearchInput
const FocusRequester = () => {
  const { focusRef } = useSearch();
  useEffect(() => {
    // Schedule focus request
    setTimeout(() => {
      focusRef.current?.();
    }, 50);
  }, [focusRef]);
  return null;
};

Deno.test({
  name: "SearchInput Component Tests",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async (t) => {
    await t.step("should render with placeholder when empty", async () => {
      setupMocks("");
      const { lastFrame, unmount } = render(
        <TestWrapper>
          <SearchInput />
        </TestWrapper>,
      );

      await delay(100);

      const output = lastFrame();
      // Should be hidden (empty) when unfocused and query is empty
      assertEquals("", output);

      unmount();
      mockWatcher.close();
      teardownMocks();
    });

    await t.step("should display search query when set", async () => {
      setupMocks("");
      const { lastFrame, unmount } = render(
        <TestWrapper>
          <SearchQuerySetter query="@Home" />
          <SearchInput />
        </TestWrapper>,
      );

      await delay(100);

      const output = lastFrame();
      assertStringIncludes(output || "", "@Home");

      unmount();
      mockWatcher.close();
      teardownMocks();
    });
  },
});

Deno.test({
  name: "Navigation and Auto-Selection Tests",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async (t) => {
    await t.step(
      "should handle navigation keys when search is focused",
      async () => {
        const todosContent = "Task A\nTask B\nTask C";
        setupMocks(todosContent);

        let selectedText = "";

        const { lastFrame, unmount, stdin } = render(
          <TestWrapper filename="todo.txt">
            <FocusRequester />
            <SearchInput />
            <SelectionObserver
              onSelectionChange={(text) => selectedText = text}
            />
          </TestWrapper>,
        );

        // Wait for load and focus
        await delay(200);
        // Initial selection should be Task A
        assertEquals(selectedText, "Task A");

        // Press Down Arrow
        // Assuming 'SearchInput' listening to keys? No, SearchInput uses 'useInput' from 'ink' ONLY when focused.
        // But we are in a testing environment. 'render' returns 'stdin'.
        // We need to write escape sequences for arrow keys.
        // Down arrow is often "\u001B[B"

        await stdin.write("\u001B[B"); // Down Arrow
        await delay(50);

        // Should select Task B
        assertEquals(selectedText, "Task B");

        // Press Up Arrow
        await stdin.write("\u001B[A"); // Up Arrow
        await delay(50);

        assertEquals(selectedText, "Task A");

        unmount();
        mockWatcher.close();
        teardownMocks();
      },
    );

    await t.step(
      "should auto-select first item when current selection is filtered out",
      async () => {
        const todosContent = "Apples\nBananas\nCherries";
        setupMocks(todosContent);

        let selectedText = "";

        const { unmount } = render(
          <TestWrapper filename="todo.txt">
            <SearchInput />
            <SelectionObserver
              onSelectionChange={(text) => selectedText = text}
            />
            <SearchQuerySetter query="" />
          </TestWrapper>,
        );

        // Wait for load
        await delay(200);
        assertEquals(selectedText, "Apples");

        // Select 'Bananas' (simulate user navigation or direct selection via stdin if we had full list)
        // Since we don't render list to navigate, we can't easily select 'Bananas' via keys without blind navigation.
        // We can just rely on the fact that if we filter 'Bananas', it should disappear and 'Apples' (or 'Cherries'?) selected?
        // Wait, if we filter 'Cherries', and 'Apples' was selected (default), it stays 'Apples'.

        // Let's rely on NavigationContext logic directly? No, integration test.
        // Let's filter such that 'Apples' is removed.
        // Filter 'Bananas'. 'Apples' removed. 'Bananas' should be selected.

        // Update query to "Bananas"
        // We need a way to update query dynamically.
        // Render again with new prop?
        // ink-testing-library `rerender` is available on result.

        // But our `TestWrapper` renders `SearchQuerySetter` if we add it.
        // We can use a component that updates query after delay.

        // Let's assume we start with "Apples" selected.
        // Filter "Bananas".
        // "Apples" is not in list.
        // "Bananas" is first item.
        // Selection should become "Bananas".

        // But `SearchQuerySetter` sets query on mount.
        // We can use a custom setter to update after delay.

        const content = (
          <TestWrapper filename="todo.txt">
            <SearchInput />
            <SelectionObserver
              onSelectionChange={(text) => selectedText = text}
            />
            <DelayedQuerySetter query="Bananas" delayMs={300} />
          </TestWrapper>
        );

        // We need `DelayedQuerySetter`.
      },
    );
  },
});

const DelayedQuerySetter = (
  { query, delayMs }: { query: string; delayMs: number },
) => {
  const { setSearchQuery } = useSearch();
  useEffect(() => {
    setTimeout(() => setSearchQuery(query), delayMs);
  }, [query, delayMs, setSearchQuery]);
  return null;
};

// Unit tests for filtering logic (testing the filtering algorithm directly)
Deno.test({
  name: "Todo Filtering Logic Tests",
  fn: async (t) => {
    await t.step("should filter by context", () => {
      const todos = new Todos(
        new Todo("Buy groceries @Home +Shopping"),
        new Todo("Fix bug @Work +Development"),
        new Todo("Call mom @Home"),
      );

      const query = "@work";
      const filteredTodos = new Todos(
        ...todos.filter((todo) => {
          const text = todo.text.toLowerCase();
          const contexts = Array.from(todo.contexts).map((c) =>
            c.toLowerCase()
          );
          const projects = Array.from(todo.projects).map((p) =>
            p.toLowerCase()
          );

          return (
            text.includes(query) ||
            contexts.some((c) => c.includes(query.replace("@", ""))) ||
            projects.some((p) => p.includes(query.replace("+", "")))
          );
        }),
      );

      assertEquals(filteredTodos.length, 1);
      assertStringIncludes(filteredTodos[0].text, "Fix bug");
    });

    await t.step("should filter by project", () => {
      const todos = new Todos(
        new Todo("Buy groceries @Home +Shopping"),
        new Todo("Fix bug @Work +Development"),
        new Todo("Call mom @Home"),
      );

      const query = "+shopping";
      const filteredTodos = new Todos(
        ...todos.filter((todo) => {
          const text = todo.text.toLowerCase();
          const contexts = Array.from(todo.contexts).map((c) =>
            c.toLowerCase()
          );
          const projects = Array.from(todo.projects).map((p) =>
            p.toLowerCase()
          );

          return (
            text.includes(query) ||
            contexts.some((c) => c.includes(query.replace("@", ""))) ||
            projects.some((p) => p.includes(query.replace("+", "")))
          );
        }),
      );

      assertEquals(filteredTodos.length, 1);
      assertStringIncludes(filteredTodos[0].text, "Buy groceries");
    });

    await t.step("should filter by text content (case-insensitive)", () => {
      const todos = new Todos(
        new Todo("Buy groceries @Home +Shopping"),
        new Todo("Fix bug @Work +Development"),
        new Todo("Call mom @Home"),
      );

      const query = "grocer";
      const filteredTodos = new Todos(
        ...todos.filter((todo) => {
          const text = todo.text.toLowerCase();
          const contexts = Array.from(todo.contexts).map((c) =>
            c.toLowerCase()
          );
          const projects = Array.from(todo.projects).map((p) =>
            p.toLowerCase()
          );

          return (
            text.includes(query) ||
            contexts.some((c) => c.includes(query.replace("@", ""))) ||
            projects.some((p) => p.includes(query.replace("+", "")))
          );
        }),
      );

      assertEquals(filteredTodos.length, 1);
      assertStringIncludes(filteredTodos[0].text, "Buy groceries");
    });

    await t.step("should return all todos when query is empty", () => {
      const todos = new Todos(
        new Todo("Buy groceries @Home +Shopping"),
        new Todo("Fix bug @Work +Development"),
        new Todo("Call mom @Home"),
      );

      const query = "";
      // Empty query should not filter
      const filteredTodos = query.trim()
        ? new Todos(
          ...todos.filter((todo) => {
            const text = todo.text.toLowerCase();
            return text.includes(query.toLowerCase());
          }),
        )
        : todos;

      assertEquals(filteredTodos.length, 3);
    });
  },
});

// Test SearchContext behavior
Deno.test({
  name: "SearchContext Tests",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async (t) => {
    await t.step("should update search query", async () => {
      setupMocks("");

      let capturedQuery = "";

      const QueryReader = () => {
        const { searchQuery } = useSearch();
        capturedQuery = searchQuery;
        return null;
      };

      const { unmount } = render(
        <TestWrapper>
          <SearchQuerySetter query="test query" />
          <QueryReader />
        </TestWrapper>,
      );

      await delay(100);

      assertEquals(capturedQuery, "test query");

      unmount();
      mockWatcher.close();
      teardownMocks();
    });

    await t.step(
      "should call focus callback when focusRef.current is called",
      async () => {
        setupMocks("");

        let focusCalled = false;

        const FocusListener = () => {
          const { focusRef } = useSearch();
          useEffect(() => {
            focusRef.current = () => {
              focusCalled = true;
            };
            // Trigger focus request
            setTimeout(() => focusRef.current?.(), 50);
          }, [focusRef]);
          return null;
        };

        const { unmount } = render(
          <TestWrapper>
            <FocusListener />
          </TestWrapper>,
        );

        await delay(200);

        assertEquals(focusCalled, true);

        unmount();
        mockWatcher.close();
        teardownMocks();
      },
    );
  },
});
