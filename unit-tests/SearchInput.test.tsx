import { expect, test } from "vitest";
import { render } from "ink-testing-library";

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

const SearchQuerySetter = ({ query }: { query: string }) => {
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

const QueryObserver = ({ onQuery }: { onQuery: (query: string) => void }) => {
  const { searchQuery } = useSearch();

  useEffect(() => {
    onQuery(searchQuery);
  }, [searchQuery, onQuery]);

  return null;
};

const FocusWhen = ({ when }: { when: boolean }) => {
  const { focusRef } = useSearch();

  useEffect(() => {
    if (when) {
      focusRef.current?.();
    }
  }, [when, focusRef]);

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
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tryFocus = () => {
      if (cancelled) return;
      if (focusRef.current) {
        focusRef.current();
        return;
      }
      timer = setTimeout(tryFocus, 0);
    };

    tryFocus();

    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [focusRef]);
  return null;
};

// --- Tests ---

test("SearchInput: should render with placeholder when empty", async () => {
  const { lastFrame, unmount } = render(
    <TestWrapper initialTodos={[]}>
      <ConnectedSearchInput />
    </TestWrapper>,
  );

  await waitFor(() => {
    const output = lastFrame();
    expect("").toEqual(output);
  });

  unmount();
});

test("SearchInput: should display search query when set", async () => {
  const { lastFrame, unmount } = render(
    <TestWrapper initialTodos={[]}>
      <SearchQuerySetter query="@Home" />
      <ConnectedSearchInput />
    </TestWrapper>,
  );

  await waitFor(() => {
    const output = lastFrame();
    expect(output || "").toContain("@Home");
  });

  unmount();
});

import { FocusObserver } from "./test-components.tsx";

// ... existing imports

// ... helpers

test("SearchInput: should handle navigation keys when search is focused", async () => {
  const todos = [new Todo("Task A"), new Todo("Task B"), new Todo("Task C")];
  let selectedText = "";
  let focusedTag: string | undefined;

  const { unmount, stdin } = render(
    <TestWrapper initialTodos={todos}>
      <FocusRequester />
      <ConnectedSearchInput />
      <SelectionObserver onSelectionChange={(text) => (selectedText = text)} />
      <FocusObserver onFocused={(tag) => (focusedTag = tag)} />
    </TestWrapper>,
  );

  // Wait for search input to be focused
  await waitFor(() => {
    expect(focusedTag).toEqual("search-input");
  });

  await waitFor(() => {
    expect(selectedText).toEqual("Task A");
  });

  stdin.write("\u001B[B"); // Down

  await waitFor(() => {
    expect(selectedText).toEqual("Task B");
  });

  stdin.write("\u001B[A"); // Up

  await waitFor(() => {
    expect(selectedText).toEqual("Task A");
  });

  unmount();
});

test("SearchInput: should auto-select first item when current selection is filtered out", async () => {
  const todos = [new Todo("Apples"), new Todo("Bananas"), new Todo("Cherries")];
  let selectedText = "";

  const { unmount } = render(
    <TestWrapper initialTodos={todos}>
      <ConnectedSearchInput />
      <SelectionObserver onSelectionChange={(text) => (selectedText = text)} />
      <SearchQuerySetter query="" />
    </TestWrapper>,
  );

  await waitFor(() => {
    expect(selectedText).toEqual("Apples");
  });

  unmount();
});

test("SearchInput: should handle home/end keys when search is focused", async () => {
  const todos = [new Todo("Task A"), new Todo("Task B"), new Todo("Task C")];
  let selectedText = "";
  let focusedTag: string | undefined;

  const { unmount, stdin } = render(
    <TestWrapper initialTodos={todos}>
      <FocusRequester />
      <ConnectedSearchInput />
      <SelectionObserver onSelectionChange={(text) => (selectedText = text)} />
      <FocusObserver onFocused={(tag) => (focusedTag = tag)} />
    </TestWrapper>,
  );

  await waitFor(() => {
    expect(focusedTag).toEqual("search-input");
  });

  await waitFor(() => {
    expect(selectedText).toEqual("Task A");
  });

  stdin.write("\u001B[F"); // End

  await waitFor(() => {
    expect(selectedText).toEqual("Task C");
  });

  stdin.write("\u001B[H"); // Home

  await waitFor(() => {
    expect(selectedText).toEqual("Task A");
  });

  unmount();
});

test("SearchInput: should handle multi-selection with Shift+Arrow keys when focused", async () => {
  const todos = [new Todo("Task A"), new Todo("Task B"), new Todo("Task C")];
  let selectedIds = new Set<symbol>();
  let focusedTag: string | undefined;

  const { unmount, stdin } = render(
    <TestWrapper initialTodos={todos}>
      <FocusRequester />
      <ConnectedSearchInput />
      <MultiSelectionObserver
        onSelectionChange={(ids) => (selectedIds = ids)}
      />
      <FocusObserver onFocused={(tag) => (focusedTag = tag)} />
    </TestWrapper>,
  );

  // Initial state
  await waitFor(() => {
    expect(focusedTag).toEqual("search-input");
  });

  await waitFor(() => {
    expect(selectedIds.size).toEqual(0);
  });

  // Press Shift+Down
  stdin.write("\u001B[1;2B");

  await waitFor(() => {
    expect(selectedIds.size).toEqual(2);
  });

  unmount();
});

test("SearchInput: should handle multi-selection with Shift+Arrow keys when filtered", async () => {
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
        onSelectionChange={(ids) => (selectedIds = ids)}
      />
      <FocusObserver onFocused={(tag) => (focusedTag = tag)} />
    </TestWrapper>,
  );

  // Initial state
  await waitFor(() => {
    expect(focusedTag).toEqual("search-input");
  });

  await waitFor(() => {
    expect(selectedIds.size).toEqual(0);
  });

  // Press Shift+Down
  stdin.write("\u001B[1;2B");

  await waitFor(() => {
    expect(selectedIds.size).toEqual(2);
  });

  unmount();
});

test("SearchInput: ignores keys until focused", async () => {
  const todos = [new Todo("Task A"), new Todo("Task B"), new Todo("Task C")];
  let selectedText = "";
  let query = "";
  let focusedTag: string | undefined;

  const tree = (focus: boolean) => (
    <TestWrapper initialTodos={todos}>
      <SearchQuerySetter query="Task" />
      <ConnectedSearchInput />
      <FocusWhen when={focus} />
      <SelectionObserver onSelectionChange={(text) => (selectedText = text)} />
      <QueryObserver onQuery={(next) => (query = next)} />
      <FocusObserver onFocused={(tag) => (focusedTag = tag)} />
    </TestWrapper>
  );

  const { unmount, stdin, rerender } = render(tree(false));

  // While unfocused both navigation and typing are ignored.
  await stdin.write("\u001B[B");
  await stdin.write("z");

  rerender(tree(true));

  await waitFor(() => {
    expect(focusedTag).toEqual("search-input");
  });

  expect(query).toEqual("Task");
  await waitFor(() => expect(selectedText).toEqual("Task A"));

  // Once focused, the same key navigates the list.
  await stdin.write("\u001B[B");

  await waitFor(() => {
    expect(selectedText).toEqual("Task B");
    expect(query).toEqual("Task");
  });

  unmount();
});

test("SearchInput: unfocused query escapes terminal controls", async () => {
  const controls =
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]/u;
  const poisoned = "c1\u009b31m\u2028sep\u001b[31m";

  const { lastFrame, unmount } = render(
    <TestWrapper initialTodos={[]}>
      <SearchQuerySetter query={poisoned} />
      <ConnectedSearchInput />
    </TestWrapper>,
  );

  try {
    await waitFor(() => {
      const frame = lastFrame() ?? "";
      expect(frame).toContain("\\u009B");
      expect(frame).toContain("\\u2028");
      expect(frame).toContain("\\u001B");
    });

    const frame = lastFrame() ?? "";
    expect(frame.includes("\u001b"), "no ESC").toEqual(false);
    expect(controls.test(frame), "no C0/C1/U+2028").toEqual(false);
  } finally {
    unmount();
  }
});
