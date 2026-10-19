import { useEffect } from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { TodoProvider, useTodo } from "../contexts/todo-context.tsx";
import { ToasterProvider } from "../contexts/toaster-context.tsx";
import { Todo } from "../logic/todo.ts";
import { assertEquals } from "@std/assert";
import { delay } from "@std/async";

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

const UndoTestApp = (
  { onUpdate }: {
    onUpdate: (
      api: {
        addTodos: (...texts: string[]) => void;
        updateTodos: (
          todosToUpdate: Todo[],
          transform: (todo: Todo) => Todo,
        ) => void;
        undo: () => void;
        redo: () => void;
        // deno-lint-ignore no-explicit-any
        todos: any[];
      },
    ) => void;
  },
) => {
  const { addTodos, updateTodos, undo, redo, todos } = useTodo();
  useEffect(() => {
    onUpdate({
      addTodos,
      updateTodos,
      undo,
      redo,
      todos,
    });
  }, [addTodos, updateTodos, undo, redo, todos, onUpdate]);
  return <Text>UndoTestApp</Text>;
};

Deno.test({
  name: "TodoContext: should undo and redo add action",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    setupMocks();

    let currentApi: {
      addTodos: (...texts: string[]) => void;
      undo: () => void;
      redo: () => void;
      // deno-lint-ignore no-explicit-any
      todos: any[];
    } | undefined;

    const { unmount } = render(
      <ToasterProvider>
        <TodoProvider filename="test.txt">
          <UndoTestApp onUpdate={(api) => (currentApi = api)} />
        </TodoProvider>
      </ToasterProvider>,
    );

    // Wait for initial load
    await waitFor(() => {
      if (!currentApi) throw new Error("API not ready");
      if (readCount === 0) throw new Error("File not loaded yet");
    });

    // 1. Add todo
    currentApi!.addTodos("Todo 1");
    await waitFor(() => assertEquals(currentApi!.todos.length, 1));
    assertEquals(currentApi!.todos[0].text, "Todo 1");

    // 2. Undo
    currentApi!.undo();
    await waitFor(() => assertEquals(currentApi!.todos.length, 0));

    // 3. Redo
    currentApi!.redo();
    await waitFor(() => assertEquals(currentApi!.todos.length, 1));
    assertEquals(currentApi!.todos[0].text, "Todo 1");

    // 4. Multiple actions
    currentApi!.addTodos("Todo 2");
    await waitFor(() => assertEquals(currentApi!.todos.length, 2));

    currentApi!.undo(); // back to [Todo 1]
    await waitFor(() => assertEquals(currentApi!.todos.length, 1));

    currentApi!.undo(); // back to []
    await waitFor(() => assertEquals(currentApi!.todos.length, 0));

    currentApi!.redo(); // back to [Todo 1]
    await waitFor(() => assertEquals(currentApi!.todos.length, 1));
    assertEquals(currentApi!.todos[0].text, "Todo 1");

    currentApi!.redo(); // back to [Todo 1, Todo 2]
    await waitFor(() => assertEquals(currentApi!.todos.length, 2));
    assertEquals(currentApi!.todos[1].text, "Todo 2");

    // 5. New action clears redo stack
    currentApi!.undo(); // back to [Todo 1]
    await waitFor(() => assertEquals(currentApi!.todos.length, 1));

    currentApi!.addTodos("Todo 3"); // Redo stack (which had Todo 2) should be cleared
    await waitFor(() => assertEquals(currentApi!.todos.length, 2));
    assertEquals(currentApi!.todos[1].text, "Todo 3");

    currentApi!.redo(); // should do nothing
    await delay(100);
    assertEquals(currentApi!.todos.length, 2);
    assertEquals(currentApi!.todos[1].text, "Todo 3");

    unmount();
    mockWatcher.close();
    teardownMocks();
  },
});

Deno.test({
  name: "TodoContext: should undo add action",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    setupMocks();

    let currentApi: {
      addTodos: (...texts: string[]) => void;
      undo: () => void;
      // deno-lint-ignore no-explicit-any
      todos: any[];
    } | undefined;

    const { unmount } = render(
      <ToasterProvider>
        <TodoProvider filename="test.txt">
          <UndoTestApp onUpdate={(api) => (currentApi = api)} />
        </TodoProvider>
      </ToasterProvider>,
    );

    // Wait for initial load
    await waitFor(() => {
      if (!currentApi) throw new Error("API not ready");
      if (readCount === 0) throw new Error("File not loaded yet");
    });

    // Add todo
    currentApi!.addTodos("Todo 1");
    await waitFor(() => assertEquals(currentApi!.todos.length, 1));
    assertEquals(currentApi!.todos[0].text, "Todo 1");

    // Add another todo
    currentApi!.addTodos("Todo 2");
    await waitFor(() => assertEquals(currentApi!.todos.length, 2));
    assertEquals(currentApi!.todos[1].text, "Todo 2");

    // Undo last add
    currentApi!.undo();
    await waitFor(() => assertEquals(currentApi!.todos.length, 1));
    assertEquals(currentApi!.todos[0].text, "Todo 1");

    // Undo first add
    currentApi!.undo();
    await waitFor(() => assertEquals(currentApi!.todos.length, 0));

    // Undo on empty history should do nothing
    currentApi!.undo();
    await delay(100);
    assertEquals(currentApi!.todos.length, 0);

    unmount();
    mockWatcher.close();
    teardownMocks();
  },
});

Deno.test({
  name: "TodoContext: should handle multiple updates correctly",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    setupMocks();

    let currentApi: {
      addTodos: (...texts: string[]) => void;
      updateTodos: (
        todosToUpdate: Todo[],
        transform: (todo: Todo) => Todo,
      ) => void;
      undo: () => void;
      // deno-lint-ignore no-explicit-any
      todos: any[];
    } | undefined;

    const { unmount } = render(
      <ToasterProvider>
        <TodoProvider filename="test.txt">
          <UndoTestApp onUpdate={(api) => (currentApi = api)} />
        </TodoProvider>
      </ToasterProvider>,
    );

    // Wait for initial load
    await waitFor(() => {
      if (!currentApi) throw new Error("API not ready");
      if (readCount === 0) throw new Error("File not loaded yet");
    });

    // 1. Add todo
    currentApi!.addTodos("Todo 1");
    await waitFor(() => assertEquals(currentApi!.todos.length, 1));
    const todoV1 = currentApi!.todos[0];
    assertEquals(todoV1.text, "Todo 1");

    // 2. Update todo (First Edit)
    currentApi!.updateTodos([todoV1], (t) => t.setText("Todo 1 Updated"));
    await waitFor(() =>
      assertEquals(currentApi!.todos[0].text, "Todo 1 Updated")
    );
    const todoV2 = currentApi!.todos[0];

    // 3. Update todo (Second Edit)
    currentApi!.updateTodos([todoV2], (t) => t.setText("Todo 1 Updated Again"));
    await waitFor(() =>
      assertEquals(currentApi!.todos[0].text, "Todo 1 Updated Again")
    );

    // 4. Undo Second Edit -> Should be "Todo 1 Updated"
    currentApi!.undo();
    await waitFor(() =>
      assertEquals(currentApi!.todos[0].text, "Todo 1 Updated")
    );

    // 5. Undo First Edit -> Should be "Todo 1"
    currentApi!.undo();
    await waitFor(() => assertEquals(currentApi!.todos[0].text, "Todo 1"));

    unmount();
    mockWatcher.close();
    teardownMocks();
  },
});
