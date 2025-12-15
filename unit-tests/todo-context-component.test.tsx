import { useEffect } from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { TodoProvider, useTodo } from "../contexts/todo-context.tsx";
import { ToasterProvider } from "../contexts/toaster-context.tsx";
import { assertEquals } from "@std/assert";
import { delay } from "@std/async";

import { MockWatcher, restoreDenoMocks } from "./test-utils.ts";

// Mock setup
// (Originals are imported from test-utils)

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
    return {
      isFile: true,
    };
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
  name: "TodoContext Component - Integration",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async (t) => {
    await t.step("should write and NOT read back immediately", async () => {
      setupMocks();

      let addTodoFn: ((text: string) => void) | undefined;

      const { unmount } = render(
        <ToasterProvider>
          <TodoProvider filename="test.txt">
            <App onMount={(fn) => addTodoFn = fn} />
          </TodoProvider>
        </ToasterProvider>,
      );

      // Wait for initial load
      await delay(100);
      assertEquals(readCount, 1, "Initial read");
      readCount = 0; // Reset for test

      // Trigger add
      if (addTodoFn) addTodoFn("New Todo");

      // Wait for debounce write (50ms) + mock write delay (10ms) + debounce read (500ms)
      await delay(1000);

      assertEquals(writeCount, 1, "Should have written");
      assertEquals(readCount, 0, "Should NOT have read back");

      unmount();
      mockWatcher.close();
      teardownMocks();
    });

    await t.step("should read on external change", async () => {
      setupMocks();

      const { unmount } = render(
        <ToasterProvider>
          <TodoProvider filename="test.txt">
            <Text>Test</Text>
          </TodoProvider>
        </ToasterProvider>,
      );

      // Wait for initial load
      await delay(100);
      readCount = 0;

      // Simulate external change
      mockWatcher.emit("modify");

      // Wait for debounce read (500ms)
      await delay(800);

      assertEquals(readCount, 1, "Should have read external change");

      unmount();
      mockWatcher.close();
      teardownMocks();
    });
  },
});
