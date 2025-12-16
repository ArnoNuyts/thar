import { useEffect } from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { TodoProvider, useTodo } from "../contexts/todo-context.tsx";
import { ToasterProvider } from "../contexts/toaster-context.tsx";
import { assertEquals } from "@std/assert";
import { delay } from "@std/async";

import { MockWatcher, restoreDenoMocks, waitFor } from "./test-utils.ts";

// Mock setup
let mockWatcher: MockWatcher;
let readCount = 0;
let writeCount = 0;

function setupMocks() {
  readCount = 0;
  writeCount = 0;
  mockWatcher = new MockWatcher();

  // deno-lint-ignore no-explicit-any
  (Deno as any).watchFs = () => mockWatcher;

  // deno-lint-ignore no-explicit-any
  (Deno as any).stat = async () => {
    await delay(0);
    return { isFile: true };
  };

  // deno-lint-ignore no-explicit-any
  (Deno as any).readTextFile = async () => {
    await delay(0);
    readCount++;
    return "";
  };

  // deno-lint-ignore no-explicit-any
  (Deno as any).writeTextFile = async () => {
    await delay(0);
    writeCount++;
    // Simulate FS event after write
    setTimeout(() => {
      mockWatcher.emit("modify");
    }, 10);
  };
}

function teardownMocks() {
  restoreDenoMocks();
}

const App = (
  { onMount }: { onMount: (add: (text: string) => void) => void },
) => {
  const { addTodo } = useTodo();
  useEffect(() => {
    onMount(addTodo);
  }, []);
  return <Text>App</Text>;
};

Deno.test({
  name: "TodoContext: should write and NOT read back immediately",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    setupMocks();

    let addTodoFn: ((text: string) => void) | undefined;
    const { unmount } = render(
      <ToasterProvider>
        <TodoProvider filename="test.txt">
          <App onMount={(fn) => (addTodoFn = fn)} />
        </TodoProvider>
      </ToasterProvider>,
    );

    // Wait for initial load
    await waitFor(() => assertEquals(readCount, 1));

    // Allow the initial save (which is a no-op) to complete
    await delay(100);

    readCount = 0; // Reset for test

    // Trigger add
    if (addTodoFn) addTodoFn("New Todo");

    // Wait for the write to happen
    await waitFor(() => assertEquals(writeCount, 1));

    // Now, wait a bit more to ensure no read-back happens
    await delay(600); // Wait past the 500ms debounce
    assertEquals(readCount, 0, "Should NOT have read back");

    unmount();
    mockWatcher.close();
    teardownMocks();
  },
});

Deno.test({
  name: "TodoContext: should read on external change",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    setupMocks();

    const { unmount } = render(
      <ToasterProvider>
        <TodoProvider filename="test.txt">
          <Text>Test</Text>
        </TodoProvider>
      </ToasterProvider>,
    );

    // Wait for initial load
    await waitFor(() => assertEquals(readCount, 1));
    readCount = 0;

    // Simulate external change
    mockWatcher.emit("modify");

    // Wait for the read to happen due to the FS event
    await waitFor(() => assertEquals(readCount, 1));

    unmount();
    mockWatcher.close();
    teardownMocks();
  },
});
