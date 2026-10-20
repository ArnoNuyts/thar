import { render } from "ink-testing-library";
import { assertEquals } from "@std/assert";
import { useEffect, useState } from "react";

import { Todo } from "../logic/todo.ts";
import type { Todos } from "../logic/Todos.ts";
import { waitFor } from "./test-utils.ts";
import { MockTodoProvider } from "./mock-todo-provider.tsx";
import { SearchInput } from "../components/SearchInput.tsx";
import { SuggestionInput } from "../components/SuggestionInput.tsx";
import { useTodo } from "../contexts/todo-context.tsx";
import { FocusProvider } from "../contexts/focus-context.tsx";
import {
  SuggestionProvider,
  useSuggestion,
} from "../contexts/suggestion-context.tsx";
import { SearchProvider, useSearch } from "../contexts/search-context.tsx";
import { ToasterProvider } from "../contexts/toaster-context.tsx";
import { NavigationProvider } from "../contexts/navigation-context.tsx";

type Snapshot = {
  value: string;
  cursor: number;
  suggestions: string[];
  selectedIndex: number;
  type: "project" | "context" | null;
  focused: boolean;
};

const emptySnapshot = (): Snapshot => ({
  value: "",
  cursor: 0,
  suggestions: [],
  selectedIndex: 0,
  type: null,
  focused: false,
});

const makeTodos = () => [
  new Todo("Task one +project-a +personal @home @office"),
  new Todo("Task two +project-b @context"),
  new Todo("Task three +project-c @context2"),
];

const NavigationWrapper = ({ children }: { children: React.ReactNode }) => {
  const { todos } = useTodo();
  return (
    <NavigationProvider todos={todos} listHeightForTest={10}>
      {children}
    </NavigationProvider>
  );
};

const SearchFocusRequester = () => {
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

const SearchSnapshotObserver = ({
  onSnapshot,
}: {
  onSnapshot: (snapshot: Snapshot) => void;
}) => {
  const { suggestions, selectedIndex, type } = useSuggestion();
  const { searchQuery, isSearchFocused } = useSearch();

  useEffect(() => {
    onSnapshot({
      value: searchQuery,
      cursor: searchQuery.length,
      suggestions,
      selectedIndex,
      type,
      focused: isSearchFocused,
    });
  }, [
    searchQuery,
    isSearchFocused,
    suggestions,
    selectedIndex,
    type,
    onSnapshot,
  ]);

  return null;
};

const ConnectedSearchInput = () => {
  const { todos } = useTodo();
  return <SearchInput todos={todos} />;
};

const SearchHarness = ({
  todos,
  onSnapshot,
}: {
  todos: Todos;
  onSnapshot: (snapshot: Snapshot) => void;
}) => (
  <ToasterProvider>
    <MockTodoProvider initialTodos={[...todos]}>
      <FocusProvider>
        <SuggestionProvider>
          <SearchProvider>
            <NavigationWrapper>
              <ConnectedSearchInput />
              <SearchFocusRequester />
              <SearchSnapshotObserver onSnapshot={onSnapshot} />
            </NavigationWrapper>
          </SearchProvider>
        </SuggestionProvider>
      </FocusProvider>
    </MockTodoProvider>
  </ToasterProvider>
);

const SuggestionSnapshotObserver = ({
  value,
  cursor,
  onSnapshot,
}: {
  value: string;
  cursor: number;
  onSnapshot: (snapshot: Snapshot) => void;
}) => {
  const { suggestions, selectedIndex, type } = useSuggestion();

  useEffect(() => {
    onSnapshot({
      value,
      cursor,
      suggestions,
      selectedIndex,
      type,
      focused: true,
    });
  }, [value, cursor, suggestions, selectedIndex, type, onSnapshot]);

  return null;
};

const SuggestionHarness = ({
  todos,
  onSnapshot,
  onCancel,
  isFocused = true,
}: {
  todos: Todos;
  onSnapshot: (snapshot: Snapshot) => void;
  onCancel: () => void;
  isFocused?: boolean;
}) => {
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);

  return (
    <SuggestionProvider>
      <SuggestionInput
        value={value}
        onChange={setValue}
        onCursorChange={(nextCursor) => setCursor(nextCursor)}
        onSubmit={() => {}}
        onCancel={onCancel}
        isFocused={isFocused}
        todos={todos}
        left={0}
        top={0}
      />
      <SuggestionSnapshotObserver
        value={value}
        cursor={cursor}
        onSnapshot={onSnapshot}
      />
    </SuggestionProvider>
  );
};

type RenderedInput = {
  stdin: { write: (data: string) => void };
  unmount: () => void;
  snapshot: () => Snapshot;
  cancelCount: () => number;
};

const renderSearch = (todos: Todos): RenderedInput => {
  let snapshot = emptySnapshot();
  const result = render(
    <SearchHarness todos={todos} onSnapshot={(next) => snapshot = next} />,
  );
  return {
    stdin: result.stdin,
    unmount: result.unmount,
    snapshot: () => snapshot,
    cancelCount: () => 0,
  };
};

const renderSuggestionInput = (todos: Todos): RenderedInput => {
  let snapshot = emptySnapshot();
  let cancelCount = 0;
  const result = render(
    <SuggestionHarness
      todos={todos}
      onSnapshot={(next) => snapshot = next}
      onCancel={() => cancelCount++}
    />,
  );
  return {
    stdin: result.stdin,
    unmount: result.unmount,
    snapshot: () => snapshot,
    cancelCount: () => cancelCount,
  };
};

const waitForFocus = async (result: RenderedInput) => {
  await waitFor(() => {
    assertEquals(result.snapshot().focused, true);
  });
};

type TestInput = {
  render: (todos: Todos) => RenderedInput;
  waitForReady: (result: RenderedInput) => Promise<void>;
  type: (result: RenderedInput, text: string) => void;
};

const testInputs: Record<string, TestInput> = {
  search: {
    render: renderSearch,
    waitForReady: waitForFocus,
    type: (result, text) => {
      result.stdin.write(text);
    },
  },
  suggestion: {
    render: renderSuggestionInput,
    waitForReady: () => Promise.resolve(),
    type: (result, text) => {
      result.stdin.write(text);
    },
  },
};

for (const [name, input] of Object.entries(testInputs)) {
  Deno.test(
    `${name}: suggests matching projects and contexts at a word start`,
    { sanitizeResources: false, sanitizeOps: false },
    async () => {
      const result = input.render(makeTodos());
      await input.waitForReady(result);

      input.type(result, "buy +pro");

      await waitFor(() => {
        const snapshot = result.snapshot();
        assertEquals(snapshot.suggestions, [
          "project-a",
          "project-b",
          "project-c",
        ]);
        assertEquals(snapshot.type, "project");
        assertEquals(snapshot.selectedIndex, 0);
        assertEquals(snapshot.value, "buy +pro");
      });

      // Replace the active tag with a context tag.
      result.stdin.write("\x7f"); // Backspace
      result.stdin.write("\x7f");
      result.stdin.write("\x7f");
      result.stdin.write("\x7f");
      input.type(result, "@con");

      await waitFor(() => {
        const snapshot = result.snapshot();
        assertEquals(snapshot.suggestions, ["context", "context2"]);
        assertEquals(snapshot.type, "context");
        assertEquals(snapshot.selectedIndex, 0);
      });

      result.unmount();
    },
  );

  Deno.test(
    `${name}: navigates suggestions with up/down and wraps`,
    { sanitizeResources: false, sanitizeOps: false },
    async () => {
      const result = input.render(makeTodos());
      await input.waitForReady(result);

      input.type(result, "+pro");

      await waitFor(() => {
        assertEquals(result.snapshot().suggestions, [
          "project-a",
          "project-b",
          "project-c",
        ]);
        assertEquals(result.snapshot().selectedIndex, 0);
      });

      result.stdin.write("\u001B[B"); // Down
      await waitFor(() => {
        assertEquals(result.snapshot().selectedIndex, 1);
      });

      result.stdin.write("\u001B[B"); // Down
      await waitFor(() => {
        assertEquals(result.snapshot().selectedIndex, 2);
      });

      result.stdin.write("\u001B[B"); // Down, wraps
      await waitFor(() => {
        assertEquals(result.snapshot().selectedIndex, 0);
      });

      result.stdin.write("\u001B[A"); // Up, wraps
      await waitFor(() => {
        assertEquals(result.snapshot().selectedIndex, 2);
      });

      result.stdin.write("\u001B[A"); // Up
      await waitFor(() => {
        assertEquals(result.snapshot().selectedIndex, 1);
      });

      result.stdin.write("\u001B[A"); // Up
      await waitFor(() => {
        assertEquals(result.snapshot().selectedIndex, 0);
      });

      result.unmount();
    },
  );

  Deno.test(
    `${name}: inserts the selected suggestion and preserves surrounding text`,
    { sanitizeResources: false, sanitizeOps: false },
    async () => {
      const result = input.render(makeTodos());
      await input.waitForReady(result);

      input.type(result, "buy +pro");

      await waitFor(() => {
        assertEquals(result.snapshot().suggestions, [
          "project-a",
          "project-b",
          "project-c",
        ]);
      });

      input.type(result, " ");
      input.type(result, "milk");

      await waitFor(() => {
        assertEquals(result.snapshot().suggestions, []);
      });

      // Move the cursor to just after "+pro" so text on both sides remains.
      result.stdin.write("\u001B[D");
      result.stdin.write("\u001B[D");
      result.stdin.write("\u001B[D");
      result.stdin.write("\u001B[D");
      result.stdin.write("\u001B[D");

      await waitFor(() => {
        assertEquals(result.snapshot().suggestions, [
          "project-a",
          "project-b",
          "project-c",
        ]);
      });

      result.stdin.write("\u001B[B"); // Select "project-b"
      await waitFor(() => {
        assertEquals(result.snapshot().selectedIndex, 1);
      });

      result.stdin.write("\r");

      await waitFor(() => {
        const snapshot = result.snapshot();
        assertEquals(snapshot.value, "buy +project-b  milk");
        assertEquals(snapshot.suggestions, []);
        if (name === "suggestion") {
          assertEquals(snapshot.cursor, "buy +project-b ".length);
        }
      });

      result.unmount();
    },
  );

  Deno.test(
    `${name}: closes suggestions on escape without changing the text`,
    { sanitizeResources: false, sanitizeOps: false },
    async () => {
      const result = input.render(makeTodos());
      await input.waitForReady(result);

      input.type(result, "buy +pro");

      await waitFor(() => {
        assertEquals(result.snapshot().suggestions, [
          "project-a",
          "project-b",
          "project-c",
        ]);
      });

      result.stdin.write("\u001B");

      await waitFor(() => {
        const snapshot = result.snapshot();
        assertEquals(snapshot.suggestions, []);
        assertEquals(snapshot.value, "buy +pro");
      });

      assertEquals(result.cancelCount(), 0);

      result.unmount();
    },
  );
}

Deno.test(
  "suggestion: ignores input and cancel until focused",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const todos = makeTodos();
    let snapshot = emptySnapshot();
    let cancelCount = 0;

    const harness = (isFocused: boolean) => (
      <SuggestionHarness
        todos={todos}
        onSnapshot={(next) => snapshot = next}
        onCancel={() => cancelCount++}
        isFocused={isFocused}
      />
    );

    const result = render(harness(false));

    await result.stdin.write("+pro");
    await result.stdin.write("\u001B"); // Escape

    result.rerender(harness(true));

    await result.stdin.write("x");

    await waitFor(() => {
      assertEquals(snapshot.value, "x");
      assertEquals(snapshot.suggestions, []);
    });

    assertEquals(cancelCount, 0);
    result.unmount();
  },
);
