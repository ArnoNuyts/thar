import { Runtime } from "../utils/runtime.ts";
import { expect, test } from "vitest";
import { useEffect } from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { TodoProvider, useTodo } from "../contexts/todo-context.tsx";
import { ToasterProvider } from "../contexts/toaster-context.tsx";

import {
  MockWatcher,
  restoreRuntimeMocks,
  waitFor,
  waitPast,
} from "./test-utils.ts";

// Mock setup
let mockWatcher: MockWatcher;
let readCount = 0;
let writeCount = 0;

function setupMocks() {
  readCount = 0;
  writeCount = 0;
  mockWatcher = new MockWatcher();

  (Runtime as any).watchFs = () => mockWatcher;

  (Runtime as any).readTextFile = () => {
    readCount++;
    return Promise.resolve("");
  };

  (Runtime as any).writeTextFile = () => {
    writeCount++;
    // Simulate FS event after write without a fixed sleep.
    queueMicrotask(() => {
      mockWatcher.emit("modify");
    });
    return Promise.resolve();
  };
}

function teardownMocks() {
  restoreRuntimeMocks();
}

const App = ({
  onMount,
}: {
  onMount: (add: (...texts: string[]) => void) => void;
}) => {
  const { addTodos } = useTodo();
  useEffect(() => {
    onMount(addTodos);
  }, [onMount, addTodos]);
  return <Text>App</Text>;
};

test("TodoContext: should write and NOT read back immediately", async () => {
  setupMocks();

  let addTodosFn: ((...texts: string[]) => void) | undefined;
  const { unmount } = render(
    <ToasterProvider>
      <TodoProvider filename="test.txt">
        <App onMount={(fn) => (addTodosFn = fn)} />
      </TodoProvider>
    </ToasterProvider>,
  );

  // Wait for initial load
  await waitFor(() => expect(readCount).toEqual(1));

  // Allow the initial save (which is a no-op) to finish its debounce.
  await waitPast(60);

  readCount = 0; // Reset for test

  // Trigger add
  if (addTodosFn) addTodosFn("New Todo");

  // Wait for the write to happen
  await waitFor(() => expect(writeCount).toEqual(1));

  // Wait past the read-back debounce (500ms) while asserting no read happens.
  const writeCompletedAt = Date.now();
  await waitFor(
    () => {
      expect(readCount, "Should NOT have read back").toEqual(0);
      if (Date.now() - writeCompletedAt < 600) {
        throw new Error("read-back debounce window still open");
      }
    },
    { interval: 25 },
  );

  unmount();
  mockWatcher.close();
  teardownMocks();
});

test("TodoContext: should read on external change", async () => {
  setupMocks();

  const { unmount } = render(
    <ToasterProvider>
      <TodoProvider filename="test.txt">
        <Text>Test</Text>
      </TodoProvider>
    </ToasterProvider>,
  );

  // Wait for initial load
  await waitFor(() => expect(readCount).toEqual(1));
  readCount = 0;

  // Simulate external change
  mockWatcher.emit("modify");

  // Wait for the read to happen due to the FS event
  await waitFor(() => expect(readCount).toEqual(1));

  unmount();
  mockWatcher.close();
  teardownMocks();
});
