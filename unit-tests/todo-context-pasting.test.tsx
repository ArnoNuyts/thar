import { Runtime } from "../utils/runtime.ts";
import { expect, test } from "vitest";
import { useEffect } from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { TodoProvider, useTodo } from "../contexts/todo-context.tsx";
import { ToasterProvider } from "../contexts/toaster-context.tsx";
import {
  MAX_PASTE_TODOS,
  MAX_TODO_CHARS,
  TodoInputError,
} from "../logic/todo-input.ts";

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

const PastingTestApp = ({
  onUpdate,
}: {
  onUpdate: (api: {
    addTodos: (...texts: string[]) => void;
    undo: () => void;
    redo: () => void;
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

test("TodoContext: should add many todos and undo/redo as a single action", async () => {
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
  await waitFor(() => expect(currentApi!.todos.length).toEqual(3));
  expect(currentApi!.todos[0].text).toEqual("Todo 1");
  expect(currentApi!.todos[1].text).toEqual("Todo 2");
  expect(currentApi!.todos[2].text).toEqual("Todo 3");

  // 2. Undo - should remove all 3 at once
  currentApi!.undo();
  await waitFor(() => expect(currentApi!.todos.length).toEqual(0));

  // 3. Redo - should re-add all 3 at once
  currentApi!.redo();
  await waitFor(() => expect(currentApi!.todos.length).toEqual(3));
  expect(currentApi!.todos[0].text).toEqual("Todo 1");
  expect(currentApi!.todos[1].text).toEqual("Todo 2");
  expect(currentApi!.todos[2].text).toEqual("Todo 3");

  unmount();
  mockWatcher.close();
  teardownMocks();
});

test("TodoContext: addTodos rejects unsafe input without partial writes", async () => {
  setupMocks();

  let currentApi:
    | {
        addTodos: (...texts: string[]) => void;
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

  await waitFor(() => {
    if (!currentApi) throw new Error("API not ready");
    if (readCount === 0) throw new Error("File not loaded yet");
  });

  expect(() => currentApi!.addTodos("good", " ")).toThrow(TodoInputError);
  expect(() => currentApi!.addTodos("good", "bad\nline")).toThrow(
    TodoInputError,
  );
  expect(() => currentApi!.addTodos("good", "bad\u0000line")).toThrow(
    TodoInputError,
  );
  expect(() => currentApi!.addTodos("a".repeat(MAX_TODO_CHARS + 1))).toThrow(
    TodoInputError,
  );

  // None of the rejected batches may have added anything.
  expect(currentApi!.todos.length).toEqual(0);

  currentApi!.addTodos("safe");
  await waitFor(() => expect(currentApi!.todos.length).toEqual(1));
  expect(currentApi!.todos[0].text).toEqual("safe");

  unmount();
  mockWatcher.close();
  teardownMocks();
});

test("TodoContext: addTodos caps a paste batch atomically", async () => {
  setupMocks();

  let currentApi:
    | {
        addTodos: (...texts: string[]) => void;
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

  await waitFor(() => {
    if (!currentApi) throw new Error("API not ready");
    if (readCount === 0) throw new Error("File not loaded yet");
  });

  const tooMany = Array.from(
    { length: MAX_PASTE_TODOS + 1 },
    (_, index) => `Todo ${index}`,
  );
  expect(() => currentApi!.addTodos(...tooMany)).toThrow(/limit is 100/i);
  expect(currentApi!.todos.length).toEqual(0);

  const allowed = tooMany.slice(0, MAX_PASTE_TODOS);
  currentApi!.addTodos(...allowed);
  await waitFor(() =>
    expect(currentApi!.todos.length).toEqual(MAX_PASTE_TODOS),
  );

  unmount();
  mockWatcher.close();
  teardownMocks();
});
