import { Runtime } from "../utils/runtime.ts";
import { expect, test } from "vitest";
import { useEffect } from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";

import { join } from "node:path";
import {
  TodoContextType,
  TodoProvider,
  useTodo,
} from "../contexts/todo-context.tsx";
import { ToasterProvider, useToaster } from "../contexts/toaster-context.tsx";
import {
  MockWatcher,
  originalReadTextFile,
  restoreRuntimeMocks,
  waitFor,
  waitPast,
} from "./test-utils.ts";

let mockWatcher: MockWatcher;
let readCount = 0;

function setupWatcherMock() {
  readCount = 0;
  mockWatcher = new MockWatcher();
  (Runtime as any).watchFs = () => mockWatcher;
}

const ApiGrabber = ({ onApi }: { onApi: (api: TodoContextType) => void }) => {
  const api = useTodo();
  useEffect(() => {
    onApi(api);
  }, [api, onApi]);
  return <Text>ApiGrabber</Text>;
};

const ToasterProbe = ({
  onMessage,
}: {
  onMessage: (message: string) => void;
}) => {
  const { toasterMessage } = useToaster();
  useEffect(() => {
    if (toasterMessage) onMessage(toasterMessage);
  }, [toasterMessage, onMessage]);
  return <Text>{toasterMessage ?? ""}</Text>;
};

const LifecycleApp = ({
  filename,
  showTodoProvider,
  onApi,
  onMessage,
}: {
  filename: string;
  showTodoProvider: boolean;
  onApi: (api: TodoContextType) => void;
  onMessage: (message: string) => void;
}) => (
  <ToasterProvider>
    <ToasterProbe onMessage={onMessage} />
    {showTodoProvider ? (
      <TodoProvider filename={filename}>
        <ApiGrabber onApi={onApi} />
      </TodoProvider>
    ) : null}
  </ToasterProvider>
);

async function withTempFile(
  initialContent: string,
  fn: (filename: string) => Promise<void>,
) {
  const tempDir = await Runtime.makeTempDir();
  const filename = join(tempDir, "todos.txt");
  await Runtime.writeTextFile(filename, initialContent);
  try {
    await fn(filename);
  } finally {
    try {
      mockWatcher?.close();
    } catch {
      // The watcher may already be closed by the provider cleanup.
    }
    restoreRuntimeMocks();
    await Runtime.remove(tempDir, { recursive: true });
  }
}

test("TodoContext: unmount cancels the pending reload debounce (no read, no toaster)", async () => {
  await withTempFile("Original\n", async (filename) => {
    setupWatcherMock();
    // Count reads while still serving the real file so the debounced reload
    // would read a changed file if it were allowed to run.
    (Runtime as any).readTextFile = async (path: string | URL) => {
      readCount++;
      return await originalReadTextFile(path);
    };

    const messages: string[] = [];
    let currentApi: TodoContextType | undefined;
    const onApi = (api: TodoContextType) => {
      currentApi = api;
    };
    const onMessage = (message: string) => messages.push(message);

    const { rerender } = render(
      <LifecycleApp
        filename={filename}
        showTodoProvider
        onApi={onApi}
        onMessage={onMessage}
      />,
    );

    await waitFor(() => {
      if (readCount === 0) throw new Error("File not loaded yet");
      if (!currentApi || currentApi.todos.length !== 1) {
        throw new Error("Initial todos not loaded yet");
      }
    });
    expect(currentApi?.todos[0].text).toEqual("Original");

    // Modify the real file, then let the watcher loop schedule the 500ms
    // reload debounce before unmounting the provider.
    await Runtime.writeTextFile(filename, "Changed\n");
    mockWatcher.emit("modify");
    // Wait until the watcher loop has consumed the event and scheduled the
    // 500ms reload debounce before we unmount.
    await waitFor(() => {
      if (mockWatcher.nextCallCount < 2) {
        throw new Error("Watcher has not processed the event yet");
      }
    });

    // The ToasterProvider stays mounted so a late reload is observable.
    rerender(
      <LifecycleApp
        filename={filename}
        showTodoProvider={false}
        onApi={onApi}
        onMessage={onMessage}
      />,
    );

    const unmountedAt = Date.now();
    await waitFor(
      () => {
        expect(
          readCount,
          "A pending reload must not read the file after unmount",
        ).toEqual(1);
        expect(
          messages.includes("File reloaded"),
          "A pending reload must not toast after unmount",
        ).toEqual(false);
        if (Date.now() - unmountedAt < 700) {
          throw new Error("reload debounce window still open");
        }
      },
      { timeout: 1000, interval: 25 },
    );
  });
});

test("TodoContext: slow initial read does not overwrite the file with the empty startup state", async () => {
  await withTempFile("Existing todo\n", async (filename) => {
    setupWatcherMock();
    let readCount = 0;
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });

    // Simulate a slow disk / busy startup: the initial read stays pending
    // past the 50ms save debounce, which used to write the empty startup
    // state over the real file.
    (Runtime as any).readTextFile = (path: string | URL) => {
      readCount++;
      return readGate.then(() => originalReadTextFile(path));
    };

    let currentApi: TodoContextType | undefined;
    const onApi = (api: TodoContextType) => {
      currentApi = api;
    };

    const { unmount } = render(
      <LifecycleApp
        filename={filename}
        showTodoProvider
        onApi={onApi}
        onMessage={() => {}}
      />,
    );

    // Hold the read open past the debounce and check the file was not
    // truncated by the empty startup state.
    const renderStartedAt = Date.now();
    await waitFor(
      () => {
        if (readCount === 0) throw new Error("File read did not start");
        if (Date.now() - renderStartedAt < 60) {
          throw new Error("The initial save debounce has not fired yet");
        }
      },
      { interval: 10 },
    );

    expect(
      await originalReadTextFile(filename),
      "The startup empty state must not truncate the todo file",
    ).toEqual("Existing todo\n");

    releaseRead();
    await waitFor(() => {
      if (!currentApi || currentApi.todos.length !== 1) {
        throw new Error("Initial todos not loaded yet");
      }
    });

    expect(currentApi?.todos[0].text).toEqual("Existing todo");
    unmount();
  });
});

test("TodoContext: unmount cancels the pending save debounce", async () => {
  await withTempFile("Existing\n", async (filename) => {
    setupWatcherMock();

    let currentApi: TodoContextType | undefined;
    const onApi = (api: TodoContextType) => {
      currentApi = api;
    };
    const { unmount } = render(
      <LifecycleApp
        filename={filename}
        showTodoProvider
        onApi={onApi}
        onMessage={() => {}}
      />,
    );

    await waitFor(() => {
      if (!currentApi || currentApi.todos.length !== 1) {
        throw new Error("Initial todos not loaded yet");
      }
    });

    // Let the initial load's debounced save run so it consumes the
    // just-read flag and cannot mask the save triggered below.
    await waitPast(60);

    const before = await Runtime.readTextFile(filename);
    currentApi?.addTodos("New todo");
    await waitFor(() => {
      if (!currentApi || currentApi.todos.length !== 2) {
        throw new Error("Todo not added yet");
      }
    });

    // The save is scheduled but its 50ms timer has not fired yet.
    unmount();
    const unmountedAt = Date.now();
    await waitFor(
      async () => {
        expect(
          await Runtime.readTextFile(filename),
          "A pending save must not write the file after unmount",
        ).toEqual(before);
        if (Date.now() - unmountedAt < 100) {
          throw new Error("save debounce window still open");
        }
      },
      { timeout: 1000, interval: 10 },
    );
  });
});
