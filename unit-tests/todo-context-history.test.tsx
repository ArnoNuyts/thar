import { StrictMode, useEffect } from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import {
  TodoContextType,
  TodoProvider,
  useTodo,
} from "../contexts/todo-context.tsx";
import { ToasterProvider } from "../contexts/toaster-context.tsx";
import { assertEquals } from "@std/assert";
import { delay } from "@std/async";

import { MockWatcher, restoreDenoMocks, waitFor } from "./test-utils.ts";

let mockWatcher: MockWatcher;
let readCount = 0;

function setupMocks() {
  readCount = 0;
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
  };
}

function teardownMocks() {
  restoreDenoMocks();
}

const ApiGrabber = ({ onApi }: { onApi: (api: TodoContextType) => void }) => {
  const api = useTodo();
  useEffect(() => {
    onApi(api);
  }, [api, onApi]);
  return <Text>ApiGrabber</Text>;
};

function renderProvider({ strict = false }: { strict?: boolean } = {}) {
  let currentApi: TodoContextType | undefined;
  const app = (
    <ToasterProvider>
      <TodoProvider filename="test.txt">
        <ApiGrabber onApi={(api) => (currentApi = api)} />
      </TodoProvider>
    </ToasterProvider>
  );

  const { unmount } = render(
    strict ? <StrictMode>{app}</StrictMode> : app,
  );

  return {
    getApi: () => {
      if (!currentApi) throw new Error("API not ready");
      return currentApi;
    },
    unmount,
  };
}

async function waitForLoad(getApi: () => TodoContextType) {
  await waitFor(() => {
    getApi();
    if (readCount === 0) throw new Error("File not loaded yet");
  });
}

Deno.test({
  name:
    "TodoContext: synchronous updates keep distinct undo snapshots and do not add no-ops",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    setupMocks();
    const { getApi, unmount } = renderProvider();
    await waitForLoad(getApi);

    const api = getApi();
    const [todo] = api.addTodos("Todo 1");
    await waitFor(() => assertEquals(getApi().todos.length, 1));
    assertEquals(getApi().todos[0].text, "Todo 1");

    const latest = getApi();
    // Two updates in one synchronous handler: each must snapshot the state
    // produced by the previous update, not the stale render closure.
    latest.updateTodos([todo], (t) => t.setText("A"));
    latest.updateTodos([todo], (t) => t.setText("B"));

    await waitFor(() => assertEquals(getApi().todos[0].text, "B"));

    getApi().undo();
    await waitFor(() => assertEquals(getApi().todos[0].text, "A"));

    getApi().undo();
    await waitFor(() => assertEquals(getApi().todos[0].text, "Todo 1"));

    // The second undo must have consumed exactly one entry (no duplicate
    // no-op snapshots). The remaining entry is the original add.
    assertEquals(getApi().canUndo, true);

    // Undo the add to reach the initial state and empty history.
    getApi().undo();
    await waitFor(() => assertEquals(getApi().todos.length, 0));
    assertEquals(getApi().canUndo, false);

    unmount();
    mockWatcher.close();
    teardownMocks();
  },
});

Deno.test({
  name: "TodoContext: awaited updates keep distinct undo snapshots",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    setupMocks();
    const { getApi, unmount } = renderProvider();
    await waitForLoad(getApi);

    const api = getApi();
    const [todo] = api.addTodos("Todo 1");
    await waitFor(() => assertEquals(getApi().todos.length, 1));

    getApi().updateTodos([todo], (t) => t.setText("A"));
    await waitFor(() => assertEquals(getApi().todos[0].text, "A"));

    getApi().updateTodos([todo], (t) => t.setText("B"));
    await waitFor(() => assertEquals(getApi().todos[0].text, "B"));

    getApi().undo();
    await waitFor(() => assertEquals(getApi().todos[0].text, "A"));

    getApi().undo();
    await waitFor(() => assertEquals(getApi().todos[0].text, "Todo 1"));

    assertEquals(getApi().canUndo, true);
    getApi().undo();
    await waitFor(() => assertEquals(getApi().todos.length, 0));
    assertEquals(getApi().canUndo, false);

    unmount();
    mockWatcher.close();
    teardownMocks();
  },
});

async function runRecurringToggleTest(strict: boolean) {
  setupMocks();
  const { getApi, unmount } = renderProvider({ strict });
  await waitForLoad(getApi);

  const [recurring] = getApi().addTodos("Recurring rec:1d");
  await waitFor(() => assertEquals(getApi().todos.length, 1));

  getApi().toggleTodos([recurring]);

  // Done todo + exactly one new recurring instance.
  await waitFor(() => assertEquals(getApi().todos.length, 2));

  const done = getApi().todos.filter((t) => t.isDone());
  const pending = getApi().todos.filter((t) => !t.isDone());
  assertEquals(done.length, 1);
  assertEquals(pending.length, 1);
  assertEquals(pending[0].toString().includes("rec:1d"), true);

  unmount();
  mockWatcher.close();
  teardownMocks();
}

Deno.test({
  name:
    "TodoContext: StrictMode creates exactly one recurring instance when toggling",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await runRecurringToggleTest(true);
  },
});

Deno.test({
  name:
    "TodoContext: non-StrictMode creates exactly one recurring instance when toggling",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await runRecurringToggleTest(false);
  },
});

Deno.test({
  name:
    "TodoContext: archiving with no completed todos does not create an undo entry",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    setupMocks();
    const { getApi, unmount } = renderProvider();
    await waitForLoad(getApi);

    getApi().addTodos("Todo 1");
    await waitFor(() => assertEquals(getApi().todos.length, 1));

    // Undo the add so history is empty and the only todo is pending.
    getApi().undo();
    await waitFor(() => assertEquals(getApi().todos.length, 0));
    assertEquals(getApi().canUndo, false);

    // No completed todos: archive must be a true no-op.
    await getApi().archiveCompletedTodos();
    await delay(100);

    assertEquals(getApi().canUndo, false);

    // Undo must do nothing and must not consume a phantom entry.
    getApi().undo();
    await delay(100);
    assertEquals(getApi().todos.length, 0);
    assertEquals(getApi().canUndo, false);

    unmount();
    mockWatcher.close();
    teardownMocks();
  },
});
