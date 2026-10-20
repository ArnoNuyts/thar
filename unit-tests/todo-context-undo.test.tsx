import { Runtime } from "../utils/runtime.ts";
import { expect, test } from "vitest";
import { useEffect } from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { TodoProvider, useTodo } from "../contexts/todo-context.tsx";
import { ToasterProvider } from "../contexts/toaster-context.tsx";
import { Todo } from "../logic/todo.ts";

import { MockWatcher, restoreRuntimeMocks, waitFor } from "./test-utils.ts";

// Mock setup
let mockWatcher: MockWatcher;
let readCount = 0;

function setupMocks() {
  readCount = 0;
  mockWatcher = new MockWatcher();

  (Runtime as any).watchFs = () => mockWatcher;

  (Runtime as any).readTextFile = () => {
    readCount++;
    return Promise.resolve("");
  };

  (Runtime as any).writeTextFile = () => Promise.resolve();
}

function teardownMocks() {
  restoreRuntimeMocks();
}

const UndoTestApp = ({
  onUpdate,
}: {
  onUpdate: (api: {
    addTodos: (...texts: string[]) => void;
    updateTodos: (
      todosToUpdate: Todo[],
      transform: (todo: Todo) => Todo,
    ) => void;
    undo: () => void;
    redo: () => void;
    todos: any[];
  }) => void;
}) => {
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

test("TodoContext: should undo and redo add action", async () => {
  setupMocks();

  let currentApi:
    | {
        addTodos: (...texts: string[]) => void;
        undo: () => void;
        redo: () => void;
        todos: any[];
      }
    | undefined;

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
  await waitFor(() => expect(currentApi!.todos.length).toEqual(1));
  expect(currentApi!.todos[0].text).toEqual("Todo 1");

  // 2. Undo
  currentApi!.undo();
  await waitFor(() => expect(currentApi!.todos.length).toEqual(0));

  // 3. Redo
  currentApi!.redo();
  await waitFor(() => expect(currentApi!.todos.length).toEqual(1));
  expect(currentApi!.todos[0].text).toEqual("Todo 1");

  // 4. Multiple actions
  currentApi!.addTodos("Todo 2");
  await waitFor(() => expect(currentApi!.todos.length).toEqual(2));

  currentApi!.undo(); // back to [Todo 1]
  await waitFor(() => expect(currentApi!.todos.length).toEqual(1));

  currentApi!.undo(); // back to []
  await waitFor(() => expect(currentApi!.todos.length).toEqual(0));

  currentApi!.redo(); // back to [Todo 1]
  await waitFor(() => expect(currentApi!.todos.length).toEqual(1));
  expect(currentApi!.todos[0].text).toEqual("Todo 1");

  currentApi!.redo(); // back to [Todo 1, Todo 2]
  await waitFor(() => expect(currentApi!.todos.length).toEqual(2));
  expect(currentApi!.todos[1].text).toEqual("Todo 2");

  // 5. New action clears redo stack
  currentApi!.undo(); // back to [Todo 1]
  await waitFor(() => expect(currentApi!.todos.length).toEqual(1));

  currentApi!.addTodos("Todo 3"); // Redo stack (which had Todo 2) should be cleared
  await waitFor(() => expect(currentApi!.todos.length).toEqual(2));
  expect(currentApi!.todos[1].text).toEqual("Todo 3");

  currentApi!.redo(); // should do nothing
  expect(currentApi!.todos.length).toEqual(2);
  expect(currentApi!.todos[1].text).toEqual("Todo 3");

  unmount();
  mockWatcher.close();
  teardownMocks();
});

test("TodoContext: should undo add action", async () => {
  setupMocks();

  let currentApi:
    | {
        addTodos: (...texts: string[]) => void;
        undo: () => void;
        todos: any[];
      }
    | undefined;

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
  await waitFor(() => expect(currentApi!.todos.length).toEqual(1));
  expect(currentApi!.todos[0].text).toEqual("Todo 1");

  // Add another todo
  currentApi!.addTodos("Todo 2");
  await waitFor(() => expect(currentApi!.todos.length).toEqual(2));
  expect(currentApi!.todos[1].text).toEqual("Todo 2");

  // Undo last add
  currentApi!.undo();
  await waitFor(() => expect(currentApi!.todos.length).toEqual(1));
  expect(currentApi!.todos[0].text).toEqual("Todo 1");

  // Undo first add
  currentApi!.undo();
  await waitFor(() => expect(currentApi!.todos.length).toEqual(0));

  // Undo on empty history should do nothing
  currentApi!.undo();
  expect(currentApi!.todos.length).toEqual(0);

  unmount();
  mockWatcher.close();
  teardownMocks();
});

test("TodoContext: should handle multiple updates correctly", async () => {
  setupMocks();

  let currentApi:
    | {
        addTodos: (...texts: string[]) => void;
        updateTodos: (
          todosToUpdate: Todo[],
          transform: (todo: Todo) => Todo,
        ) => void;
        undo: () => void;
        todos: any[];
      }
    | undefined;

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
  await waitFor(() => expect(currentApi!.todos.length).toEqual(1));
  const todoV1 = currentApi!.todos[0];
  expect(todoV1.text).toEqual("Todo 1");

  // 2. Update todo (First Edit)
  currentApi!.updateTodos([todoV1], (t) => t.setText("Todo 1 Updated"));
  await waitFor(() =>
    expect(currentApi!.todos[0].text).toEqual("Todo 1 Updated"),
  );
  const todoV2 = currentApi!.todos[0];

  // 3. Update todo (Second Edit)
  currentApi!.updateTodos([todoV2], (t) => t.setText("Todo 1 Updated Again"));
  await waitFor(() =>
    expect(currentApi!.todos[0].text).toEqual("Todo 1 Updated Again"),
  );

  // 4. Undo Second Edit -> Should be "Todo 1 Updated"
  currentApi!.undo();
  await waitFor(() =>
    expect(currentApi!.todos[0].text).toEqual("Todo 1 Updated"),
  );

  // 5. Undo First Edit -> Should be "Todo 1"
  currentApi!.undo();
  await waitFor(() => expect(currentApi!.todos[0].text).toEqual("Todo 1"));

  unmount();
  mockWatcher.close();
  teardownMocks();
});
