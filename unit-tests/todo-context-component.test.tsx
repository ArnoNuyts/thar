import { useEffect } from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { TodoProvider, useTodo } from "../contexts/todo-context.tsx";
import { assertEquals } from "@std/assert";
import { delay } from "@std/async";

// Mock setup
const originalWatchFs = Deno.watchFs;
const originalReadTextFile = Deno.readTextFile;
const originalWriteTextFile = Deno.writeTextFile;
const originalStat = Deno.stat;

// Event emitter for watcher
class MockWatcher {
  private listeners: ((event: Deno.FsEvent) => void)[] = [];
  private closed = false;

  async *[Symbol.asyncIterator](): AsyncIterableIterator<Deno.FsEvent> {
    while (!this.closed) {
      const event = await new Promise<Deno.FsEvent>((resolve) => {
        this.listeners.push(resolve);
      });
      if (this.closed) break;
      yield event;
    }
  }

  emit(kind: "modify") {
    const event: Deno.FsEvent = { kind, paths: ["test.txt"], flag: undefined };
    const listeners = this.listeners;
    this.listeners = [];
    listeners.forEach((l) => l(event));
  }

  close() {
    this.closed = true;
    this.listeners.forEach((l) =>
      l({ kind: "any", paths: [], flag: undefined })
    );
    this.listeners = [];
  }
}

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
  // deno-lint-ignore no-explicit-any
  (Deno as any).watchFs = originalWatchFs;
  // deno-lint-ignore no-explicit-any
  (Deno as any).readTextFile = originalReadTextFile;
  // deno-lint-ignore no-explicit-any
  (Deno as any).writeTextFile = originalWriteTextFile;
  // deno-lint-ignore no-explicit-any
  (Deno as any).stat = originalStat;
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
        <TodoProvider filename="test.txt">
          <App onMount={(fn) => addTodoFn = fn} />
        </TodoProvider>,
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
        <TodoProvider filename="test.txt">
          <Text>Test</Text>
        </TodoProvider>,
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
