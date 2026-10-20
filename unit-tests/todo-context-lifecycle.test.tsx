import { useEffect } from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  TodoContextType,
  TodoProvider,
  useTodo,
} from "../contexts/todo-context.tsx";
import { ToasterProvider, useToaster } from "../contexts/toaster-context.tsx";
import {
  MockWatcher,
  originalReadTextFile,
  restoreDenoMocks,
  waitFor,
  waitPast,
} from "./test-utils.ts";

let mockWatcher: MockWatcher;
let readCount = 0;

function setupWatcherMock() {
  readCount = 0;
  mockWatcher = new MockWatcher();
  // deno-lint-ignore no-explicit-any
  (Deno as any).watchFs = () => mockWatcher;
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
  const tempDir = await Deno.makeTempDir();
  const filename = join(tempDir, "todos.txt");
  await Deno.writeTextFile(filename, initialContent);
  try {
    await fn(filename);
  } finally {
    try {
      mockWatcher?.close();
    } catch {
      // The watcher may already be closed by the provider cleanup.
    }
    restoreDenoMocks();
    await Deno.remove(tempDir, { recursive: true });
  }
}

Deno.test({
  name: "TodoContext: unmount cancels the pending reload debounce (no read, no toaster)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withTempFile("Original\n", async (filename) => {
      setupWatcherMock();
      // Count reads while still serving the real file so the debounced reload
      // would read a changed file if it were allowed to run.
      // deno-lint-ignore no-explicit-any
      (Deno as any).readTextFile = async (path: string | URL) => {
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
      assertEquals(currentApi?.todos[0].text, "Original");

      // Modify the real file, then let the watcher loop schedule the 500ms
      // reload debounce before unmounting the provider.
      await Deno.writeTextFile(filename, "Changed\n");
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
          assertEquals(
            readCount,
            1,
            "A pending reload must not read the file after unmount",
          );
          assertEquals(
            messages.includes("File reloaded"),
            false,
            "A pending reload must not toast after unmount",
          );
          if (Date.now() - unmountedAt < 700) {
            throw new Error("reload debounce window still open");
          }
        },
        { timeout: 1000, interval: 25 },
      );
    });
  },
});

Deno.test({
  name: "TodoContext: slow initial read does not overwrite the file with the empty startup state",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
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
      // deno-lint-ignore no-explicit-any
      (Deno as any).readTextFile = (path: string | URL) => {
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

      assertEquals(
        await originalReadTextFile(filename),
        "Existing todo\n",
        "The startup empty state must not truncate the todo file",
      );

      releaseRead();
      await waitFor(() => {
        if (!currentApi || currentApi.todos.length !== 1) {
          throw new Error("Initial todos not loaded yet");
        }
      });

      assertEquals(currentApi?.todos[0].text, "Existing todo");
      unmount();
    });
  },
});

Deno.test({
  name: "TodoContext: unmount cancels the pending save debounce",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
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

      const before = await Deno.readTextFile(filename);
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
          assertEquals(
            await Deno.readTextFile(filename),
            before,
            "A pending save must not write the file after unmount",
          );
          if (Date.now() - unmountedAt < 100) {
            throw new Error("save debounce window still open");
          }
        },
        { timeout: 1000, interval: 10 },
      );
    });
  },
});
