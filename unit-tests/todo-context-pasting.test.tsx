import { useEffect } from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { TodoProvider, useTodo } from "../contexts/todo-context.tsx";
import { ToasterProvider } from "../contexts/toaster-context.tsx";
import { assertEquals } from "@std/assert";

import { MockWatcher, restoreDenoMocks, waitFor } from "./test-utils.ts";

// Mock setup
let mockWatcher: MockWatcher;
let readCount = 0;

function setupMocks() {
  readCount = 0;
  mockWatcher = new MockWatcher();

  // deno-lint-ignore no-explicit-any
  (Deno as any).watchFs = () => mockWatcher;

  // deno-lint-ignore no-explicit-any
  (Deno as any).readTextFile = () => {
    readCount++;
    return Promise.resolve("");
  };

  // deno-lint-ignore no-explicit-any
  (Deno as any).writeTextFile = () => Promise.resolve();
}

function teardownMocks() {
  restoreDenoMocks();
}

const PastingTestApp = ({
  onUpdate,
}: {
  onUpdate: (api: {
    addTodos: (...texts: string[]) => void;
    undo: () => void;
    redo: () => void;
    // deno-lint-ignore no-explicit-any
    todos: any[];
  }) => void;
}) => {
  const { addTodos, undo, redo, todos } = useTodo();
  useEffect(() => {
    onUpdate({
      addTodos,
      undo,
      redo,
      todos,
    });
  }, [addTodos, undo, redo, todos, onUpdate]);
  return <Text>PastingTestApp</Text>;
};

Deno.test({
  name: "TodoContext: should add many todos and undo/redo as a single action",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    setupMocks();

    let currentApi:
      | {
          addTodos: (...texts: string[]) => void;
          undo: () => void;
          redo: () => void;
          // deno-lint-ignore no-explicit-any
          todos: any[];
        }
      | undefined;

    const { unmount } = render(
      <ToasterProvider>
        <TodoProvider filename="test.txt">
          <PastingTestApp onUpdate={(api) => (currentApi = api)} />
        </TodoProvider>
      </ToasterProvider>,
    );

    // Wait for initial load
    await waitFor(() => {
      if (!currentApi) throw new Error("API not ready");
      if (readCount === 0) throw new Error("File not loaded yet");
    });

    // 1. Add many todos
    currentApi!.addTodos("Todo 1", "Todo 2", "Todo 3");
    await waitFor(() => assertEquals(currentApi!.todos.length, 3));
    assertEquals(currentApi!.todos[0].text, "Todo 1");
    assertEquals(currentApi!.todos[1].text, "Todo 2");
    assertEquals(currentApi!.todos[2].text, "Todo 3");

    // 2. Undo - should remove all 3 at once
    currentApi!.undo();
    await waitFor(() => assertEquals(currentApi!.todos.length, 0));

    // 3. Redo - should re-add all 3 at once
    currentApi!.redo();
    await waitFor(() => assertEquals(currentApi!.todos.length, 3));
    assertEquals(currentApi!.todos[0].text, "Todo 1");
    assertEquals(currentApi!.todos[1].text, "Todo 2");
    assertEquals(currentApi!.todos[2].text, "Todo 3");

    unmount();
    mockWatcher.close();
    teardownMocks();
  },
});
