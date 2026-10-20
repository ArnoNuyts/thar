import { Runtime } from "../utils/runtime.ts";
import { expect, test } from "vitest";
import { StrictMode, useEffect } from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import {
  TodoContextType,
  TodoProvider,
  useTodo,
} from "../contexts/todo-context.tsx";
import { ToasterProvider } from "../contexts/toaster-context.tsx";

import { MockWatcher, restoreRuntimeMocks, waitFor } from "./test-utils.ts";

let mockWatcher: MockWatcher;
let readCount = 0;

function setupMocks() {
  readCount = 0;
  mockWatcher = new MockWatcher();

  (Runtime as any).watchFs = () => mockWatcher;

  (Runtime as any).stat = async () => {
    await Promise.resolve();
    return { isFile: true };
  };

  (Runtime as any).readTextFile = async () => {
    await Promise.resolve();
    readCount++;
    return "";
  };

  (Runtime as any).writeTextFile = async () => {
    await Promise.resolve();
  };
}

function teardownMocks() {
  restoreRuntimeMocks();
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

  const { unmount } = render(strict ? <StrictMode>{app}</StrictMode> : app);

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

test("TodoContext: synchronous updates keep distinct undo snapshots and do not add no-ops", async () => {
  setupMocks();
  const { getApi, unmount } = renderProvider();
  await waitForLoad(getApi);

  const api = getApi();
  const [todo] = api.addTodos("Todo 1");
  await waitFor(() => expect(getApi().todos.length).toEqual(1));
  expect(getApi().todos[0].text).toEqual("Todo 1");

  const latest = getApi();
  // Two updates in one synchronous handler: each must snapshot the state
  // produced by the previous update, not the stale render closure.
  latest.updateTodos([todo], (t) => t.setText("A"));
  latest.updateTodos([todo], (t) => t.setText("B"));

  await waitFor(() => expect(getApi().todos[0].text).toEqual("B"));

  getApi().undo();
  await waitFor(() => expect(getApi().todos[0].text).toEqual("A"));

  getApi().undo();
  await waitFor(() => expect(getApi().todos[0].text).toEqual("Todo 1"));

  // The second undo must have consumed exactly one entry (no duplicate
  // no-op snapshots). The remaining entry is the original add.
  expect(getApi().canUndo).toEqual(true);

  // Undo the add to reach the initial state and empty history.
  getApi().undo();
  await waitFor(() => expect(getApi().todos.length).toEqual(0));
  expect(getApi().canUndo).toEqual(false);

  unmount();
  mockWatcher.close();
  teardownMocks();
});

test("TodoContext: awaited updates keep distinct undo snapshots", async () => {
  setupMocks();
  const { getApi, unmount } = renderProvider();
  await waitForLoad(getApi);

  const api = getApi();
  const [todo] = api.addTodos("Todo 1");
  await waitFor(() => expect(getApi().todos.length).toEqual(1));

  getApi().updateTodos([todo], (t) => t.setText("A"));
  await waitFor(() => expect(getApi().todos[0].text).toEqual("A"));

  getApi().updateTodos([todo], (t) => t.setText("B"));
  await waitFor(() => expect(getApi().todos[0].text).toEqual("B"));

  getApi().undo();
  await waitFor(() => expect(getApi().todos[0].text).toEqual("A"));

  getApi().undo();
  await waitFor(() => expect(getApi().todos[0].text).toEqual("Todo 1"));

  expect(getApi().canUndo).toEqual(true);
  getApi().undo();
  await waitFor(() => expect(getApi().todos.length).toEqual(0));
  expect(getApi().canUndo).toEqual(false);

  unmount();
  mockWatcher.close();
  teardownMocks();
});

async function runRecurringToggleTest(strict: boolean) {
  setupMocks();
  const { getApi, unmount } = renderProvider({ strict });
  await waitForLoad(getApi);

  const [recurring] = getApi().addTodos("Recurring rec:1d");
  await waitFor(() => expect(getApi().todos.length).toEqual(1));

  getApi().toggleTodos([recurring]);

  // Done todo + exactly one new recurring instance.
  await waitFor(() => expect(getApi().todos.length).toEqual(2));

  const done = getApi().todos.filter((t) => t.isDone());
  const pending = getApi().todos.filter((t) => !t.isDone());
  expect(done.length).toEqual(1);
  expect(pending.length).toEqual(1);
  expect(pending[0].toString().includes("rec:1d")).toEqual(true);

  unmount();
  mockWatcher.close();
  teardownMocks();
}

test("TodoContext: StrictMode creates exactly one recurring instance when toggling", async () => {
  await runRecurringToggleTest(true);
});

test("TodoContext: non-StrictMode creates exactly one recurring instance when toggling", async () => {
  await runRecurringToggleTest(false);
});

test("TodoContext: archiving with no completed todos does not create an undo entry", async () => {
  setupMocks();
  const { getApi, unmount } = renderProvider();
  await waitForLoad(getApi);

  getApi().addTodos("Todo 1");
  await waitFor(() => expect(getApi().todos.length).toEqual(1));

  // Undo the add so history is empty and the only todo is pending.
  getApi().undo();
  await waitFor(() => expect(getApi().todos.length).toEqual(0));
  expect(getApi().canUndo).toEqual(false);

  // No completed todos: archive must be a true no-op.
  await getApi().archiveCompletedTodos();

  expect(getApi().canUndo).toEqual(false);

  // Undo must do nothing and must not consume a phantom entry.
  getApi().undo();
  expect(getApi().todos.length).toEqual(0);
  expect(getApi().canUndo).toEqual(false);

  unmount();
  mockWatcher.close();
  teardownMocks();
});
