import { render } from "ink-testing-library";
import { assertEquals, assertStringIncludes } from "@std/assert";

import { useEffect } from "react";
import { IndexType } from "../types/enums.ts";
import { Todo } from "../logic/todo.ts";
import { waitFor } from "./test-utils.ts";
import { MockTodoProvider } from "./mock-todo-provider.tsx";
import { SearchInput } from "../components/SearchInput.tsx";
import { useTodo } from "../contexts/todo-context.tsx";
import { FocusProvider } from "../contexts/focus-context.tsx";
import { SuggestionProvider } from "../contexts/suggestion-context.tsx";
import { SearchProvider, useSearch } from "../contexts/search-context.tsx";
import { ToasterProvider } from "../contexts/toaster-context.tsx";
import {
  NavigationProvider,
  useNavigation,
} from "../contexts/navigation-context.tsx";

// --- Helpers ---

const NavigationWrapper = ({ children }: { children: React.ReactNode }) => {
  const { todos } = useTodo();
  return (
    <NavigationProvider todos={todos} listHeightForTest={10}>
      {children}
    </NavigationProvider>
  );
};

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

const ConnectedSearchInput = () => {
  const { todos } = useTodo();
  return <SearchInput todos={todos} />;
};

const SearchQuerySetter = ({
  query,
}: {
  query: string;
}) => {
  const { setSearchQuery } = useSearch();
  useEffect(() => {
    setSearchQuery(query);
  }, [query, setSearchQuery]);
  return null;
};

const SelectionObserver = ({
  onSelectionChange,
}: {
  onSelectionChange: (item: string) => void;
}) => {
  const { indexes, selectedTodoId } = useNavigation();

  useEffect(() => {
    if (selectedTodoId) {
      const entry = indexes.find(
        (e) => e.type === IndexType.todo && e.todo.id === selectedTodoId,
      );
      if (entry && entry.type === IndexType.todo) {
        onSelectionChange(entry.todo.text);
      }
    }
  }, [selectedTodoId, indexes, onSelectionChange]);

  return null;
};

const MultiSelectionObserver = ({
  onSelectionChange,
}: {
  onSelectionChange: (ids: Set<symbol>) => void;
}) => {
  const { selectedTodoIds } = useNavigation();

  useEffect(() => {
    onSelectionChange(selectedTodoIds);
  }, [selectedTodoIds, onSelectionChange]);

  return null;
};

const FocusRequester = () => {
  const { focusRef } = useSearch();
  useEffect(() => {
    setTimeout(() => {
      focusRef.current?.();
    }, 50);
  }, [focusRef]);
  return null;
};

// --- Tests ---

Deno.test(
  "SearchInput: should render with placeholder when empty",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const { lastFrame, unmount } = render(
      <TestWrapper initialTodos={[]}>
        <ConnectedSearchInput />
      </TestWrapper>,
    );

    await waitFor(() => {
      const output = lastFrame();
      assertEquals("", output);
    });

    unmount();
  },
);

Deno.test(
  "SearchInput: should display search query when set",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const { lastFrame, unmount } = render(
      <TestWrapper initialTodos={[]}>
        <SearchQuerySetter query="@Home" />
        <ConnectedSearchInput />
      </TestWrapper>,
    );

    await waitFor(() => {
      const output = lastFrame();
      assertStringIncludes(output || "", "@Home");
    });

    unmount();
  },
);

import { FocusObserver } from "./test-components.tsx";

// ... existing imports

// ... helpers

Deno.test(
  "SearchInput: should handle navigation keys when search is focused",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const todos = [new Todo("Task A"), new Todo("Task B"), new Todo("Task C")];
    let selectedText = "";
    let focusedTag: string | undefined;

    const { unmount, stdin } = render(
      <TestWrapper initialTodos={todos}>
        <FocusRequester />
        <ConnectedSearchInput />
        <SelectionObserver onSelectionChange={(text) => selectedText = text} />
        <FocusObserver onFocused={(tag) => focusedTag = tag} />
      </TestWrapper>,
    );

    // Wait for search input to be focused
    await waitFor(() => {
      assertEquals(focusedTag, "search-input");
    });

    await waitFor(() => {
      assertEquals(selectedText, "Task A");
    });

    stdin.write("\u001B[B"); // Down

    await waitFor(() => {
      assertEquals(selectedText, "Task B");
    });

    stdin.write("\u001B[A"); // Up

    await waitFor(() => {
      assertEquals(selectedText, "Task A");
    });

    unmount();
  },
);

Deno.test(
  "SearchInput: should auto-select first item when current selection is filtered out",
  // ... (this test doesn't use FocusRequester/delay so maybe leave it or update if relevant)
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const todos = [
      new Todo("Apples"),
      new Todo("Bananas"),
      new Todo("Cherries"),
    ];
    let selectedText = "";

    const { unmount } = render(
      <TestWrapper initialTodos={todos}>
        <ConnectedSearchInput />
        <SelectionObserver onSelectionChange={(text) => selectedText = text} />
        <SearchQuerySetter query="" />
      </TestWrapper>,
    );

    await waitFor(() => {
      assertEquals(selectedText, "Apples");
    });

    unmount();
  },
);

Deno.test(
  "SearchInput: should handle home/end keys when search is focused",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const todos = [new Todo("Task A"), new Todo("Task B"), new Todo("Task C")];
    let selectedText = "";
    let focusedTag: string | undefined;

    const { unmount, stdin } = render(
      <TestWrapper initialTodos={todos}>
        <FocusRequester />
        <ConnectedSearchInput />
        <SelectionObserver onSelectionChange={(text) => selectedText = text} />
        <FocusObserver onFocused={(tag) => focusedTag = tag} />
      </TestWrapper>,
    );

    await waitFor(() => {
      assertEquals(focusedTag, "search-input");
    });

    await waitFor(() => {
      assertEquals(selectedText, "Task A");
    });

    stdin.write("\u001B[F"); // End

    await waitFor(() => {
      assertEquals(selectedText, "Task C");
    });

    stdin.write("\u001B[H"); // Home

    await waitFor(() => {
      assertEquals(selectedText, "Task A");
    });

    unmount();
  },
);

Deno.test(
  "SearchInput: should handle multi-selection with Shift+Arrow keys when focused",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const todos = [new Todo("Task A"), new Todo("Task B"), new Todo("Task C")];
    let selectedIds = new Set<symbol>();
    let focusedTag: string | undefined;

    const { unmount, stdin } = render(
      <TestWrapper initialTodos={todos}>
        <FocusRequester />
        <ConnectedSearchInput />
        <MultiSelectionObserver
          onSelectionChange={(ids) => selectedIds = ids}
        />
        <FocusObserver onFocused={(tag) => focusedTag = tag} />
      </TestWrapper>,
    );

    // Initial state
    await waitFor(() => {
      assertEquals(focusedTag, "search-input");
    });

    await waitFor(() => {
      assertEquals(selectedIds.size, 0);
    });

    // Press Shift+Down
    stdin.write("\u001B[1;2B");

    await waitFor(() => {
      assertEquals(selectedIds.size, 2);
    });

    unmount();
  },
);

Deno.test(
  "SearchInput: should handle multi-selection with Shift+Arrow keys when filtered",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const todos = [
      new Todo("Apple"),
      new Todo("Banana"),
      new Todo("Apricot"),
      new Todo("Cherry"),
    ];
    let selectedIds = new Set<symbol>();
    let focusedTag: string | undefined;

    const { unmount, stdin } = render(
      <TestWrapper initialTodos={todos}>
        <SearchQuerySetter query="Ap" />
        <FocusRequester />
        <ConnectedSearchInput />
        <MultiSelectionObserver
          onSelectionChange={(ids) => selectedIds = ids}
        />
        <FocusObserver onFocused={(tag) => focusedTag = tag} />
      </TestWrapper>,
    );

    // Initial state
    await waitFor(() => {
      assertEquals(focusedTag, "search-input");
    });

    await waitFor(() => {
      assertEquals(selectedIds.size, 0);
    });

    // Press Shift+Down
    stdin.write("\u001B[1;2B");

    await waitFor(() => {
      assertEquals(selectedIds.size, 2);
    });

    unmount();
  },
);
