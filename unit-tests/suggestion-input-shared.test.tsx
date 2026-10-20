import { expect, test } from "vitest";
import { render } from "ink-testing-library";

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
    <SearchHarness todos={todos} onSnapshot={(next) => (snapshot = next)} />,
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
      onSnapshot={(next) => (snapshot = next)}
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
    expect(result.snapshot().focused).toEqual(true);
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
  test(`${name}: suggests matching projects and contexts at a word start`, async () => {
    const result = input.render(makeTodos());
    await input.waitForReady(result);

    input.type(result, "buy +pro");

    await waitFor(() => {
      const snapshot = result.snapshot();
      expect(snapshot.suggestions).toEqual([
        "project-a",
        "project-b",
        "project-c",
      ]);
      expect(snapshot.type).toEqual("project");
      expect(snapshot.selectedIndex).toEqual(0);
      expect(snapshot.value).toEqual("buy +pro");
    });

    // Replace the active tag with a context tag.
    result.stdin.write("\x7f"); // Backspace
    result.stdin.write("\x7f");
    result.stdin.write("\x7f");
    result.stdin.write("\x7f");
    input.type(result, "@con");

    await waitFor(() => {
      const snapshot = result.snapshot();
      expect(snapshot.suggestions).toEqual(["context", "context2"]);
      expect(snapshot.type).toEqual("context");
      expect(snapshot.selectedIndex).toEqual(0);
    });

    result.unmount();
  });

  test(`${name}: navigates suggestions with up/down and wraps`, async () => {
    const result = input.render(makeTodos());
    await input.waitForReady(result);

    input.type(result, "+pro");

    await waitFor(() => {
      expect(result.snapshot().suggestions).toEqual([
        "project-a",
        "project-b",
        "project-c",
      ]);
      expect(result.snapshot().selectedIndex).toEqual(0);
    });

    result.stdin.write("\u001B[B"); // Down
    await waitFor(() => {
      expect(result.snapshot().selectedIndex).toEqual(1);
    });

    result.stdin.write("\u001B[B"); // Down
    await waitFor(() => {
      expect(result.snapshot().selectedIndex).toEqual(2);
    });

    result.stdin.write("\u001B[B"); // Down, wraps
    await waitFor(() => {
      expect(result.snapshot().selectedIndex).toEqual(0);
    });

    result.stdin.write("\u001B[A"); // Up, wraps
    await waitFor(() => {
      expect(result.snapshot().selectedIndex).toEqual(2);
    });

    result.stdin.write("\u001B[A"); // Up
    await waitFor(() => {
      expect(result.snapshot().selectedIndex).toEqual(1);
    });

    result.stdin.write("\u001B[A"); // Up
    await waitFor(() => {
      expect(result.snapshot().selectedIndex).toEqual(0);
    });

    result.unmount();
  });

  test(`${name}: inserts the selected suggestion and preserves surrounding text`, async () => {
    const result = input.render(makeTodos());
    await input.waitForReady(result);

    input.type(result, "buy +pro");

    await waitFor(() => {
      expect(result.snapshot().suggestions).toEqual([
        "project-a",
        "project-b",
        "project-c",
      ]);
    });

    input.type(result, " ");
    input.type(result, "milk");

    await waitFor(() => {
      expect(result.snapshot().suggestions).toEqual([]);
    });

    // Move the cursor to just after "+pro" so text on both sides remains.
    result.stdin.write("\u001B[D");
    result.stdin.write("\u001B[D");
    result.stdin.write("\u001B[D");
    result.stdin.write("\u001B[D");
    result.stdin.write("\u001B[D");

    await waitFor(() => {
      expect(result.snapshot().suggestions).toEqual([
        "project-a",
        "project-b",
        "project-c",
      ]);
    });

    result.stdin.write("\u001B[B"); // Select "project-b"
    await waitFor(() => {
      expect(result.snapshot().selectedIndex).toEqual(1);
    });

    result.stdin.write("\r");

    await waitFor(() => {
      const snapshot = result.snapshot();
      expect(snapshot.value).toEqual("buy +project-b  milk");
      expect(snapshot.suggestions).toEqual([]);
      if (name === "suggestion") {
        expect(snapshot.cursor).toEqual("buy +project-b ".length);
      }
    });

    result.unmount();
  });

  test(`${name}: closes suggestions on escape without changing the text`, async () => {
    const result = input.render(makeTodos());
    await input.waitForReady(result);

    input.type(result, "buy +pro");

    await waitFor(() => {
      expect(result.snapshot().suggestions).toEqual([
        "project-a",
        "project-b",
        "project-c",
      ]);
    });

    result.stdin.write("\u001B");

    await waitFor(() => {
      const snapshot = result.snapshot();
      expect(snapshot.suggestions).toEqual([]);
      expect(snapshot.value).toEqual("buy +pro");
    });

    expect(result.cancelCount()).toEqual(0);

    result.unmount();
  });
}

test("suggestion: ignores input and cancel until focused", async () => {
  const todos = makeTodos();
  let snapshot = emptySnapshot();
  let cancelCount = 0;

  const harness = (isFocused: boolean) => (
    <SuggestionHarness
      todos={todos}
      onSnapshot={(next) => (snapshot = next)}
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
    expect(snapshot.value).toEqual("x");
    expect(snapshot.suggestions).toEqual([]);
  });

  expect(cancelCount).toEqual(0);
  result.unmount();
});
