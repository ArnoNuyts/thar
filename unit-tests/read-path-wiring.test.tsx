import { Text } from "ink";
import { render } from "ink-testing-library";
import { useEffect } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  NavigationProvider,
  useNavigation,
} from "../contexts/navigation-context.tsx";
import { SearchProvider, useSearch } from "../contexts/search-context.tsx";
import { getTodayKey } from "../hooks/useTodayKey.ts";
import { todayDateKey } from "../hooks/useNavigationState.ts";
import {
  resetCoreBridgeForTests,
  setRowBuilderForTests,
} from "../logic/core-wasm.ts";
import { createIndexes } from "../logic/indexes.ts";
import {
  filterBySearch,
  filterHidden,
  sortByImportance,
  type Todos,
} from "../logic/Todos.ts";
import { Todo } from "../logic/todo.ts";
import { IndexType } from "../types/enums.ts";
import { waitFor } from "./test-utils.ts";

/**
 * CP3b2a: the main list uses the gated Rust row builder only when
 * `THAR_CORE=rust`, and the TypeScript indexes are the fallback for every
 * failure path. The injected builder is the CP3b1 stand-in until the real
 * WASM export lands.
 */

const savedCore = process.env.THAR_CORE;

afterEach(() => {
  if (savedCore === undefined) delete process.env.THAR_CORE;
  else process.env.THAR_CORE = savedCore;
  resetCoreBridgeForTests();
  vi.restoreAllMocks();
});

interface RowRequest {
  terms: string[];
  showHidden: boolean;
  today: string;
}

const envelope = (rows: unknown): string => JSON.stringify({ ok: true, rows });

/** A builder that records each request and answers with `rows`. */
const recordingBuilder = (
  rows: (request: RowRequest) => unknown,
): { calls: RowRequest[] } => {
  const calls: RowRequest[] = [];
  setRowBuilderForTests((raw) => {
    const request = JSON.parse(raw) as RowRequest;
    calls.push(request);
    return envelope(rows(request));
  });
  return { calls };
};

const NavigationProbe = ({
  onNavigation,
}: {
  onNavigation: (indexes: ReturnType<typeof useNavigation>["indexes"]) => void;
}) => {
  const navigation = useNavigation();
  useEffect(() => {
    onNavigation(navigation.indexes);
  });
  return <Text>probe</Text>;
};

const SearchQuery = ({ query }: { query: string }) => {
  const { setSearchQuery } = useSearch();
  useEffect(() => {
    setSearchQuery(query);
  }, [query, setSearchQuery]);
  return null;
};

const renderList = (todos: Todos, query = "") => {
  let indexes: ReturnType<typeof useNavigation>["indexes"] = [];
  const result = render(
    <SearchProvider>
      <NavigationProvider todos={todos} listHeightForTest={10}>
        <SearchQuery query={query} />
        <NavigationProbe onNavigation={(next) => (indexes = next)} />
      </NavigationProvider>
    </SearchProvider>,
  );
  return { ...result, getIndexes: () => indexes };
};

const tsIndexes = (todos: Todos, query = "") =>
  createIndexes(filterBySearch(filterHidden(sortByImportance(todos)), query));

const todos = () => [
  new Todo("beta one @work"),
  new Todo("alpha two @work"),
  new Todo("gamma plain"),
];

describe("read-path wiring", () => {
  test("ts (or unset) never calls the Rust builder and keeps TS indexes", async () => {
    delete process.env.THAR_CORE;
    const builder = recordingBuilder(() => []);
    const list = renderList(todos());

    await waitFor(() => {
      expect(list.getIndexes().length).toBe(5);
    });

    expect(builder.calls).toHaveLength(0);
    const expected = tsIndexes(todos());
    expect(list.getIndexes().map((entry) => entry.type)).toEqual(
      expected.map((entry) => entry.type),
    );
    const actualTodos = list
      .getIndexes()
      .filter((entry) => entry.type === IndexType.todo);
    const expectedTodos = expected.filter(
      (entry) => entry.type === IndexType.todo,
    );
    expect(actualTodos.map((entry) => entry.todo.text)).toEqual(
      expectedTodos.map((entry) => entry.todo.text),
    );
    list.unmount();
  });

  test("rust uses the returned rows, mapped to the original todos", async () => {
    process.env.THAR_CORE = "rust";
    const source = todos();
    // Deliberately not the TS order or grouping: the hook must render this.
    recordingBuilder(() => [
      { type: "context", contextName: "work", todoCount: 1 },
      { type: "todo", index: 1, number: 1 },
    ]);

    const list = renderList(source);

    await waitFor(() => {
      expect(list.getIndexes()[0]?.type).toEqual(IndexType.context);
    });

    expect(list.getIndexes()).toHaveLength(2);
    const header = list.getIndexes()[0];
    expect(header).toEqual({
      type: IndexType.context,
      contextName: "work",
      todoCount: 1,
    });
    const row = list.getIndexes()[1];
    expect(row).toEqual({ type: IndexType.todo, todo: source[1], number: 1 });
    list.unmount();
  });

  test("a thrown error falls back to the TS indexes with one log", async () => {
    process.env.THAR_CORE = "rust";
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    setRowBuilderForTests(() => {
      throw new Error("SECRET-row-builder-failure");
    });

    const source = todos();
    const list = renderList(source);

    await waitFor(() => {
      // The TS list has the work header, the "None" header and three todos.
      expect(list.getIndexes().length).toBe(5);
    });

    expect(debug).toHaveBeenCalledTimes(1);
    const logged = debug.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("buildRows");
    expect(logged).not.toContain("SECRET-row-builder-failure");
    list.unmount();
  });

  test("passes the query terms, showHidden and today from the hook", async () => {
    process.env.THAR_CORE = "rust";
    const builder = recordingBuilder(() => [
      { type: "context", contextName: "None", todoCount: 1 },
      { type: "todo", index: 0, number: 1 },
    ]);

    let navigation: ReturnType<typeof useNavigation> | undefined;
    const Capture = () => {
      navigation = useNavigation();
      return null;
    };
    const result = render(
      <SearchProvider>
        <NavigationProvider todos={todos()} listHeightForTest={10}>
          <SearchQuery query="ALPHA @Work" />
          <Capture />
        </NavigationProvider>
      </SearchProvider>,
    );

    await waitFor(() => {
      expect(builder.calls.at(-1)?.terms).toEqual(["alpha", "@work"]);
    });
    expect(builder.calls.at(-1)?.showHidden).toBe(false);
    expect(builder.calls.at(-1)?.today).toBe(todayDateKey(getTodayKey()));

    navigation?.toggleShowHidden();
    await waitFor(() => {
      expect(builder.calls.at(-1)?.showHidden).toBe(true);
    });

    result.unmount();
  });

  test("todayDateKey maps each local day key to its YYYY-MM-DD day", () => {
    expect(todayDateKey(getTodayKey(new Date(2026, 10, 15, 23, 59)))).toBe(
      "2026-11-15",
    );
    // One minute later the key rolls over and so does the Rust `today`.
    expect(todayDateKey(getTodayKey(new Date(2026, 10, 16, 0, 0)))).toBe(
      "2026-11-16",
    );
  });
});
