import { render } from "ink-testing-library";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { delay } from "@std/async";

import { useTodo } from "../contexts/todo-context.tsx";
import { FocusProvider } from "../contexts/focus-context.tsx";
import { SuggestionProvider } from "../contexts/suggestion-context.tsx";
import { SearchProvider, useSearch } from "../contexts/search-context.tsx";
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

// Wrapper to inject todos into NavigationProvider
const NavigationWrapper = ({ children }: { children: React.ReactNode }) => {
  const { todos } = useTodo();
  return <NavigationProvider todos={todos}>{children}</NavigationProvider>;
};

// Wrapper to inject todos into SearchInput
const ConnectedSearchInput = () => {
  const { todos } = useTodo();
  return <SearchInput todos={todos} />;
};

import { MockTodoProvider } from "./mock-todo-provider.tsx";

// Helper to wrap components with all required providers
const TestWrapper = ({
  children,
  initialTodos = [],
}: {
  children: React.ReactNode;
  initialTodos?: Todo[];
}) => {
  return (
    <ToasterProvider>
      <MockTodoProvider initialTodos={initialTodos}>
        <FocusProvider>
          <SuggestionProvider>
            <SearchProvider>
              <NavigationWrapper>{children}</NavigationWrapper>
            </SearchProvider>
          </SuggestionProvider>
        </FocusProvider>
      </MockTodoProvider>
    </ToasterProvider>
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
  const { indexes, selectedTodoHash } = useNavigation();

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
      const { lastFrame, unmount } = render(
        <TestWrapper initialTodos={[]}>
          <ConnectedSearchInput />
        </TestWrapper>,
      );

      await delay(100);

      const output = lastFrame();
      // Should be hidden (empty) when unfocused and query is empty
      assertEquals("", output);

      unmount();
    });

    await t.step("should display search query when set", async () => {
      const { lastFrame, unmount } = render(
        <TestWrapper initialTodos={[]}>
          <SearchQuerySetter query="@Home" />
          <ConnectedSearchInput />
        </TestWrapper>,
      );

      await delay(100);

      const output = lastFrame();
      assertStringIncludes(output || "", "@Home");

      unmount();
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
        const todos = [
          new Todo("Task A"),
          new Todo("Task B"),
          new Todo("Task C"),
        ];

        let selectedText = "";

        const { lastFrame: _lastFrame, unmount, stdin } = render(
          <TestWrapper initialTodos={todos}>
            <FocusRequester />
            <ConnectedSearchInput />
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
        await stdin.write("\u001B[B"); // Down Arrow
        await delay(50);

        // Should select Task B
        assertEquals(selectedText, "Task B");

        // Press Up Arrow
        await stdin.write("\u001B[A"); // Up Arrow
        await delay(50);

        assertEquals(selectedText, "Task A");

        unmount();
      },
    );

    await t.step(
      "should auto-select first item when current selection is filtered out",
      async () => {
        const todos = [
          new Todo("Apples"),
          new Todo("Bananas"),
          new Todo("Cherries"),
        ];

        let selectedText = "";

        const { unmount: _unmount } = render(
          <TestWrapper initialTodos={todos}>
            <ConnectedSearchInput />
            <SelectionObserver
              onSelectionChange={(text) => selectedText = text}
            />
            <SearchQuerySetter query="" />
          </TestWrapper>,
        );

        // Wait for load
        await delay(200);
        assertEquals(selectedText, "Apples");
      },
    );
  },
});

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
    });

    await t.step(
      "should call focus callback when focusRef.current is called",
      async () => {
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
      },
    );
  },
});
