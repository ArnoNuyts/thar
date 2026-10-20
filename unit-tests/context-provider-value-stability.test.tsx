import { assertExists, assertStrictEquals } from "@std/assert";
import { join } from "@std/path";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { FocusProvider, useFocusManager } from "../contexts/focus-context.tsx";
import { ModalProvider, useModal } from "../contexts/modal-context.tsx";
import { SearchProvider, useSearch } from "../contexts/search-context.tsx";
import {
  SuggestionProvider,
  useSuggestion,
} from "../contexts/suggestion-context.tsx";
import { TodoProvider, useTodo } from "../contexts/todo-context.tsx";
import { ToasterProvider } from "../contexts/toaster-context.tsx";
import { MockWatcher, restoreDenoMocks, waitFor } from "./test-utils.ts";

type FocusValue = ReturnType<typeof useFocusManager>;
type ModalValue = ReturnType<typeof useModal>;
type SearchValue = ReturnType<typeof useSearch>;
type SuggestionValue = ReturnType<typeof useSuggestion>;
type TodoValue = ReturnType<typeof useTodo>;

Deno.test(
  "FocusProvider: value is referentially stable across unrelated re-renders",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    let latest: FocusValue | undefined;
    let renderCount = 0;

    const Probe = ({ tick }: { tick: number }) => {
      latest = useFocusManager();
      renderCount++;
      return <Text>{tick}</Text>;
    };

    const App = ({ tick }: { tick: number }) => (
      <FocusProvider>
        <Probe tick={tick} />
      </FocusProvider>
    );

    const { rerender, unmount } = render(<App tick={0} />);
    assertExists(latest);
    const firstValue = latest;
    const rendersBefore = renderCount;

    rerender(<App tick={1} />);
    await waitFor(() => {
      if (renderCount === rendersBefore) {
        throw new Error("Probe did not re-render");
      }
    });

    assertStrictEquals(latest, firstValue);
    unmount();
  },
);

Deno.test(
  "ModalProvider: value is referentially stable across unrelated re-renders",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    let latest: ModalValue | undefined;
    let renderCount = 0;

    const Probe = ({ tick }: { tick: number }) => {
      latest = useModal();
      renderCount++;
      return <Text>{tick}</Text>;
    };

    const App = ({ tick }: { tick: number }) => (
      <ModalProvider>
        <Probe tick={tick} />
      </ModalProvider>
    );

    const { rerender, unmount } = render(<App tick={0} />);
    assertExists(latest);
    const firstValue = latest;
    const rendersBefore = renderCount;

    rerender(<App tick={1} />);
    await waitFor(() => {
      if (renderCount === rendersBefore) {
        throw new Error("Probe did not re-render");
      }
    });

    assertStrictEquals(latest, firstValue);
    unmount();
  },
);

Deno.test(
  "SearchProvider: value is referentially stable across unrelated re-renders",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    let latest: SearchValue | undefined;
    let renderCount = 0;

    const Probe = ({ tick }: { tick: number }) => {
      latest = useSearch();
      renderCount++;
      return <Text>{tick}</Text>;
    };

    const App = ({ tick }: { tick: number }) => (
      <SearchProvider>
        <Probe tick={tick} />
      </SearchProvider>
    );

    const { rerender, unmount } = render(<App tick={0} />);
    assertExists(latest);
    const firstValue = latest;
    const rendersBefore = renderCount;

    rerender(<App tick={1} />);
    await waitFor(() => {
      if (renderCount === rendersBefore) {
        throw new Error("Probe did not re-render");
      }
    });

    assertStrictEquals(latest, firstValue);
    unmount();
  },
);

Deno.test(
  "SuggestionProvider: value is referentially stable across unrelated re-renders",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    let latest: SuggestionValue | undefined;
    let renderCount = 0;

    const Probe = ({ tick }: { tick: number }) => {
      latest = useSuggestion();
      renderCount++;
      return <Text>{tick}</Text>;
    };

    const App = ({ tick }: { tick: number }) => (
      <SuggestionProvider>
        <Probe tick={tick} />
      </SuggestionProvider>
    );

    const { rerender, unmount } = render(<App tick={0} />);
    assertExists(latest);
    const firstValue = latest;
    const rendersBefore = renderCount;

    rerender(<App tick={1} />);
    await waitFor(() => {
      if (renderCount === rendersBefore) {
        throw new Error("Probe did not re-render");
      }
    });

    assertStrictEquals(latest, firstValue);
    unmount();
  },
);

Deno.test(
  "TodoProvider: value is referentially stable across unrelated re-renders",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const tempDir = await Deno.makeTempDir();
    const filename = join(tempDir, "todos.txt");
    await Deno.writeTextFile(filename, "Existing todo\n");

    let watcher: MockWatcher | undefined;
    try {
      watcher = new MockWatcher();
      // deno-lint-ignore no-explicit-any
      (Deno as any).watchFs = () => watcher;

      let latest: TodoValue | undefined;
      let renderCount = 0;
      const onValue = (value: TodoValue) => {
        latest = value;
        renderCount++;
      };

      const Probe = ({ tick }: { tick: number }) => {
        const value = useTodo();
        onValue(value);
        return <Text>{tick}</Text>;
      };

      const App = ({ tick }: { tick: number }) => (
        <ToasterProvider>
          <TodoProvider filename={filename}>
            <Probe tick={tick} />
          </TodoProvider>
        </ToasterProvider>
      );

      const { rerender, unmount } = render(<App tick={0} />);

      // Let the initial file read settle so the captured value reflects the
      // loaded todos rather than the startup empty state.
      await waitFor(() => {
        if (!latest || latest.todos.length !== 1) {
          throw new Error("Initial todos not loaded yet");
        }
      });

      assertExists(latest);
      const firstValue = latest;
      const rendersBefore = renderCount;

      rerender(<App tick={1} />);
      await waitFor(() => {
        if (renderCount === rendersBefore) {
          throw new Error("Probe did not re-render");
        }
      });

      assertStrictEquals(latest, firstValue);
      assertStrictEquals(latest?.setTodos, firstValue.setTodos);
      assertStrictEquals(latest?.addTodos, firstValue.addTodos);
      assertStrictEquals(latest?.updateTodos, firstValue.updateTodos);
      assertStrictEquals(latest?.deleteTodos, firstValue.deleteTodos);

      unmount();
    } finally {
      try {
        watcher?.close();
      } catch {
        // The watcher may already be closed by the provider cleanup.
      }
      restoreDenoMocks();
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);
