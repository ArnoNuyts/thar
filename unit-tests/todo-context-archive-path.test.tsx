import { useEffect } from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { assert, assertStringIncludes } from "@std/assert";
import { join, SEPARATOR } from "@std/path";
import {
  TodoContextType,
  TodoProvider,
  useTodo,
} from "../contexts/todo-context.tsx";
import { ToasterProvider } from "../contexts/toaster-context.tsx";
import {
  MockWatcher,
  originalWriteTextFile,
  restoreDenoMocks,
  waitFor,
} from "./test-utils.ts";

let mockWatcher: MockWatcher;

const ApiGrabber = ({ onApi }: { onApi: (api: TodoContextType) => void }) => {
  const api = useTodo();
  useEffect(() => {
    onApi(api);
  }, [api, onApi]);
  return <Text>ApiGrabber</Text>;
};

Deno.test({
  name: "TodoContext: archive writes done.txt next to a todo file in a subdirectory",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const tempDir = await Deno.makeTempDir();
    const subdir = join(tempDir, "nested");
    await Deno.mkdir(subdir);
    const filename = join(subdir, "todos.txt");
    await Deno.writeTextFile(filename, "Completed task\n");

    mockWatcher = new MockWatcher();
    // deno-lint-ignore no-explicit-any
    (Deno as any).watchFs = () => mockWatcher;

    const writes: string[] = [];
    // deno-lint-ignore no-explicit-any
    (Deno as any).writeTextFile = async (
      path: string | URL,
      data: string,
      options?: Deno.WriteFileOptions,
    ) => {
      writes.push(path instanceof URL ? path.pathname : path);
      return await originalWriteTextFile(path, data, options);
    };

    let currentApi: TodoContextType | undefined;
    let unmount: (() => void) | undefined;
    const onApi = (api: TodoContextType) => {
      currentApi = api;
    };

    try {
      const rendered = render(
        <ToasterProvider>
          <TodoProvider filename={filename}>
            <ApiGrabber onApi={onApi} />
          </TodoProvider>
        </ToasterProvider>,
      );
      unmount = rendered.unmount;

      await waitFor(() => {
        if (!currentApi || currentApi.todos.length !== 1) {
          throw new Error("Initial todos not loaded yet");
        }
      });

      currentApi?.toggleTodos([currentApi.todos[0]]);
      await waitFor(() => {
        if (!currentApi?.todos[0]?.isDone()) {
          throw new Error("Todo not completed yet");
        }
      });

      writes.length = 0;
      await currentApi?.archiveCompletedTodos();

      const donePath = join(subdir, "done.txt");
      assert(
        writes.includes(donePath),
        `Expected archive to write "${donePath}", got ${JSON.stringify(
          writes,
        )}`,
      );
      assert(
        donePath.includes(`${SEPARATOR}done.txt`),
        `Expected the done file path to use the platform separator, got "${donePath}"`,
      );

      const archived = await Deno.readTextFile(donePath);
      assertStringIncludes(archived, "Completed task");
    } finally {
      unmount?.();
      try {
        mockWatcher.close();
      } catch {
        // The watcher may already be closed by the provider cleanup.
      }
      restoreDenoMocks();
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});
