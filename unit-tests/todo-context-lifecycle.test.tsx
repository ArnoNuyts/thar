import { Runtime } from "../utils/runtime.ts";
import { expect, test } from "vitest";
import { useEffect, useState } from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";

import { dirname, join } from "node:path";
import {
  TodoContextType,
  TodoProvider,
  useTodo,
} from "../contexts/todo-context.tsx";
import { ToasterProvider, useToaster } from "../contexts/toaster-context.tsx";
import { useTodoFileSync } from "../hooks/useTodoFileSync.ts";
import type { Todos } from "../logic/Todos.ts";
import { Todo } from "../logic/todo.ts";
import { TodoInputError } from "../logic/todo-input.ts";
import {
  MockWatcher,
  originalReadTextFile,
  originalWriteTextFile,
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

test("TodoContext: an initial load failure is read-only and never writes", async () => {
  const poisoned = "INITIAL_POISON_MARKER\u0000\n";

  await withTempFile(poisoned, async (filename) => {
    setupWatcherMock();

    let writeCount = 0;
    (Runtime as any).writeTextFile = async (
      path: string | URL,
      data: string,
      options?: unknown,
    ) => {
      writeCount++;
      return await originalWriteTextFile(path, data, options as never);
    };

    const messages: string[] = [];
    let currentApi: TodoContextType | undefined;

    const { unmount } = render(
      <LifecycleApp
        filename={filename}
        showTodoProvider
        onApi={(api) => {
          currentApi = api;
        }}
        onMessage={(message) => messages.push(message)}
      />,
    );

    await waitFor(() => {
      if (!currentApi?.loadError) throw new Error("Load error not set yet");
    });

    expect(currentApi!.readOnly).toEqual(true);
    expect(currentApi!.todos).toEqual([]);
    expect(currentApi!.loadError).not.toContain("INITIAL_POISON_MARKER");
    expect(messages.some((message) => message.includes("U+0000"))).toEqual(
      true,
    );

    currentApi!.addTodos("Blocked todo");
    await waitFor(() => expect(currentApi?.todos.length).toEqual(1));
    await waitPast(120);

    expect(writeCount, "No save after a failed initial load").toEqual(0);
    expect(await originalReadTextFile(filename)).toEqual(poisoned);

    unmount();
  });
});

test("TodoContext: a failed reload is read-only and blocks saves until a valid reload", async () => {
  await withTempFile("Original\n", async (filename) => {
    setupWatcherMock();

    let writeCount = 0;
    (Runtime as any).writeTextFile = async (
      path: string | URL,
      data: string,
      options?: unknown,
    ) => {
      writeCount++;
      return await originalWriteTextFile(path, data, options as never);
    };

    const messages: string[] = [];
    let currentApi: TodoContextType | undefined;
    const onApi = (api: TodoContextType) => {
      currentApi = api;
    };
    const onMessage = (message: string) => messages.push(message);

    const { unmount } = render(
      <LifecycleApp
        filename={filename}
        showTodoProvider
        onApi={onApi}
        onMessage={onMessage}
      />,
    );

    await waitFor(() => {
      if (!currentApi || currentApi.todos.length !== 1) {
        throw new Error("Initial todos not loaded yet");
      }
      if (currentApi.readOnly) throw new Error("Unexpected read-only state");
    });

    // Let the initial no-op save debounce consume the just-read flag.
    await waitPast(60);
    writeCount = 0;

    const marker = "RELOAD_POISON_MARKER";
    const poisoned = `${marker}\u001b[31mred\n`;
    await originalWriteTextFile(filename, poisoned);
    mockWatcher.emit("modify");

    await waitFor(() => {
      if (!currentApi?.loadError) throw new Error("Load error not set yet");
    });

    expect(currentApi!.readOnly).toEqual(true);
    expect(currentApi!.loadError).not.toContain(marker);
    expect(currentApi!.loadError).not.toContain("\u001b");
    expect((currentApi!.loadError ?? "").length).toBeLessThan(400);
    expect(currentApi!.todos.map((todo) => todo.text)).toEqual(["Original"]);
    expect(messages.some((message) => message.includes("U+001B"))).toEqual(
      true,
    );

    // A mutation while read-only must not write the rejected file.
    currentApi!.addTodos("Blocked todo");
    await waitFor(() => expect(currentApi?.todos.length).toEqual(2));
    await waitPast(120);
    expect(writeCount, "No save while read-only").toEqual(0);
    expect(await originalReadTextFile(filename)).toEqual(poisoned);
    expect(currentApi!.readOnly).toEqual(true);

    // Fixing the file externally recovers the provider.
    await originalWriteTextFile(filename, "Recovered\n");
    mockWatcher.emit("modify");
    await waitFor(() => {
      if (!currentApi) throw new Error("API not ready");
      if (currentApi.readOnly) throw new Error("Provider still read-only");
      if (!currentApi.todos.some((todo) => todo.text === "Recovered")) {
        throw new Error("Valid file not reloaded yet");
      }
    });
    expect(currentApi!.loadError).toBeUndefined();

    // Saving resumes after the valid reload.
    currentApi!.addTodos("Persisted");
    await waitFor(async () => {
      const content = await originalReadTextFile(filename);
      expect(content).toContain("Persisted");
    });

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

type SyncSnapshot = {
  todos: Todos;
  sync: ReturnType<typeof useTodoFileSync>;
  setTodos: (todos: Todos) => void;
};

const SyncHarness = ({
  filename,
  reloadDebounceMs,
  saveDebounceMs,
  onSnapshot,
}: {
  filename: string;
  reloadDebounceMs: number;
  saveDebounceMs?: number;
  onSnapshot: (snapshot: SyncSnapshot) => void;
}) => {
  const [todos, setTodos] = useState<Todos>([]);
  const { showToaster } = useToaster();
  const sync = useTodoFileSync({
    filename,
    todos,
    onLoad: setTodos,
    showToaster,
    reloadDebounceMs,
    saveDebounceMs,
  });

  useEffect(() => {
    onSnapshot({ todos, sync, setTodos });
  }, [todos, sync, setTodos, onSnapshot]);

  return <Text>SyncHarness</Text>;
};

test("TodoContext: a poisoned initial load recovers after an external fix", async () => {
  const poisoned = "RECOVERY_POISON_MARKER\u0000\n";

  await withTempFile(poisoned, async (filename) => {
    setupWatcherMock();

    const messages: string[] = [];
    let currentApi: TodoContextType | undefined;
    const { unmount } = render(
      <LifecycleApp
        filename={filename}
        showTodoProvider
        onApi={(api) => {
          currentApi = api;
        }}
        onMessage={(message) => messages.push(message)}
      />,
    );

    try {
      await waitFor(() => {
        if (!currentApi?.readOnly) throw new Error("Load error not set yet");
      });
      expect(currentApi!.todos).toEqual([]);

      // Fix the file externally; the watcher must process events after an
      // initial failure so the provider can recover.
      await originalWriteTextFile(filename, "Recovered\n");
      mockWatcher.emit("modify");

      await waitFor(() => {
        if (!currentApi) throw new Error("API not ready");
        if (currentApi.readOnly) throw new Error("Provider still read-only");
        if (!currentApi.todos.some((todo) => todo.text === "Recovered")) {
          throw new Error("Valid file not reloaded yet");
        }
      });

      expect(currentApi!.loadError).toBeUndefined();
      expect(messages.some((message) => message === "File reloaded")).toEqual(
        true,
      );
    } finally {
      unmount();
    }
  });
});

test("TodoFileSync: a mutation save scheduled before a failing reload never writes", async () => {
  await withTempFile("Original\n", async (filename) => {
    setupWatcherMock();

    let writeCount = 0;
    (Runtime as any).writeTextFile = async (
      path: string | URL,
      data: string,
      options?: unknown,
    ) => {
      writeCount++;
      return await originalWriteTextFile(path, data, options as never);
    };

    let snapshot: SyncSnapshot | undefined;
    const onSnapshot = (next: SyncSnapshot) => {
      snapshot = next;
    };

    const { unmount } = render(
      <ToasterProvider>
        <SyncHarness
          filename={filename}
          reloadDebounceMs={10}
          onSnapshot={onSnapshot}
        />
      </ToasterProvider>,
    );

    try {
      await waitFor(() => {
        if (!snapshot || snapshot.todos.length !== 1) {
          throw new Error("Initial todos not loaded yet");
        }
        if (snapshot.sync.readOnly) {
          throw new Error("Unexpected read-only state");
        }
      });

      // Let the initial no-op save consume the just-read flag.
      await waitPast(60);
      writeCount = 0;

      const loaded = snapshot!.todos;
      snapshot!.setTodos([...loaded, new Todo("Queued")]);
      await waitFor(() => {
        if (!snapshot || snapshot.todos.length !== 2) {
          throw new Error("Mutation not committed yet");
        }
      });

      // The save is now queued for 50ms. Poison the file and let the watcher
      // reload fail inside that window; the failure must cancel the save.
      await originalWriteTextFile(filename, "RELOAD_POISON_MARKER\u0000\n");
      mockWatcher.emit("modify");

      await waitFor(() => {
        if (!snapshot?.sync.loadError) {
          throw new Error("Reload failure not observed yet");
        }
      });

      const readOnlyAt = Date.now();
      await waitFor(
        () => {
          expect(
            writeCount,
            "A save queued before the failing reload must be cancelled",
          ).toEqual(0);
          if (Date.now() - readOnlyAt < 100) {
            throw new Error("Save debounce window still open");
          }
        },
        { interval: 10, timeout: 1000 },
      );
    } finally {
      unmount();
    }
  });
});

test("TodoContext: undo after a mutation that preempted the just-read save still writes", async () => {
  await withTempFile("Original\n", async (filename) => {
    setupWatcherMock();

    let currentApi: TodoContextType | undefined;
    const { unmount } = render(
      <LifecycleApp
        filename={filename}
        showTodoProvider
        onApi={(api) => {
          currentApi = api;
        }}
        onMessage={() => {}}
      />,
    );

    try {
      await waitFor(() => {
        if (!currentApi || currentApi.todos.length !== 1) {
          throw new Error("Initial todos not loaded yet");
        }
      });

      // This mutation wins the save debounce before the initial just-read
      // save can consume its flag.
      currentApi!.addTodos("Mutated");

      await waitFor(async () => {
        const content = await originalReadTextFile(filename);
        if (!content.includes("Mutated")) {
          throw new Error("Mutation not saved yet");
        }
      });

      currentApi!.undo();

      await waitFor(async () => {
        const content = await originalReadTextFile(filename);
        expect(
          content,
          "Undo back to the loaded array must be written",
        ).toEqual("Original\n");
      });
    } finally {
      unmount();
    }
  });
});

test("TodoContext: addTodos rejects control characters without mutating or writing", async () => {
  await withTempFile("Original\n", async (filename) => {
    setupWatcherMock();

    let writeCount = 0;
    (Runtime as any).writeTextFile = async (
      path: string | URL,
      data: string,
      options?: unknown,
    ) => {
      writeCount++;
      return await originalWriteTextFile(path, data, options as never);
    };

    let currentApi: TodoContextType | undefined;
    const { unmount } = render(
      <LifecycleApp
        filename={filename}
        showTodoProvider
        onApi={(api) => {
          currentApi = api;
        }}
        onMessage={() => {}}
      />,
    );

    try {
      await waitFor(() => {
        if (!currentApi || currentApi.todos.length !== 1) {
          throw new Error("Initial todos not loaded yet");
        }
      });
      await waitPast(60);
      writeCount = 0;

      expect(() => currentApi!.addTodos("pasted\u009b31mred")).toThrow(
        TodoInputError,
      );
      expect(currentApi!.todos.map((todo) => todo.text)).toEqual(["Original"]);

      await waitPast(100);
      expect(writeCount, "A rejected add must not save").toEqual(0);
      expect(await originalReadTextFile(filename)).toEqual("Original\n");
    } finally {
      unmount();
    }
  });
});

test("TodoContext: archive is blocked while read-only and leaves done.txt alone", async () => {
  await withTempFile("Completed task\n", async (filename) => {
    setupWatcherMock();

    const writes: string[] = [];
    (Runtime as any).writeTextFile = async (
      path: string | URL,
      data: string,
      options?: unknown,
    ) => {
      writes.push(path instanceof URL ? path.pathname : path);
      return await originalWriteTextFile(path, data, options as never);
    };

    const messages: string[] = [];
    let currentApi: TodoContextType | undefined;
    const { unmount } = render(
      <LifecycleApp
        filename={filename}
        showTodoProvider
        onApi={(api) => {
          currentApi = api;
        }}
        onMessage={(message) => messages.push(message)}
      />,
    );

    try {
      await waitFor(() => {
        if (!currentApi || currentApi.todos.length !== 1) {
          throw new Error("Initial todos not loaded yet");
        }
      });

      currentApi!.toggleTodos([currentApi!.todos[0]]);
      await waitFor(() => {
        if (!currentApi?.todos[0]?.isDone()) {
          throw new Error("Todo not completed yet");
        }
      });
      // Let the save land and the write-read guard (1s) expire before the
      // watcher event that puts the provider into read-only mode.
      await waitPast(1100);

      await originalWriteTextFile(filename, "ARCHIVE_POISON_MARKER\u0000\n");
      mockWatcher.emit("modify");
      await waitFor(() => {
        if (!currentApi?.readOnly) throw new Error("Read-only not set yet");
      });

      writes.length = 0;
      await currentApi!.archiveCompletedTodos();
      await waitPast(60);

      expect(writes, "No done.txt write while read-only").toEqual([]);
      expect(currentApi!.todos.some((todo) => todo.isDone())).toEqual(true);
      expect(
        messages.some((message) => message.toLowerCase().includes("read-only")),
      ).toEqual(true);

      await expect(
        Runtime.stat(join(dirname(filename), "done.txt")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      unmount();
    }
  });
});

test("TodoFileSync: a mutation that preempts the just-read save still allows a later undo write", async () => {
  await withTempFile("Original\n", async (filename) => {
    setupWatcherMock();

    let snapshot: SyncSnapshot | undefined;
    const onSnapshot = (next: SyncSnapshot) => {
      snapshot = next;
    };

    const { unmount } = render(
      <ToasterProvider>
        <SyncHarness
          filename={filename}
          reloadDebounceMs={500}
          saveDebounceMs={500}
          onSnapshot={onSnapshot}
        />
      </ToasterProvider>,
    );

    try {
      await waitFor(() => {
        if (!snapshot || snapshot.todos.length !== 1) {
          throw new Error("Initial todos not loaded yet");
        }
      });

      const loaded = snapshot!.todos;
      // The initial no-op save is still pending for 500ms, so this mutation
      // definitely wins the debounce and clears the just-read flag.
      snapshot!.setTodos([...loaded, new Todo("Mutated")]);

      await waitFor(async () => {
        const content = await originalReadTextFile(filename);
        if (!content.includes("Mutated")) {
          throw new Error("Mutation not saved yet");
        }
      });

      // Undo back to the exact array the load produced. Without clearing the
      // just-read ref on the mismatch save this would be skipped as a no-op.
      snapshot!.setTodos(loaded);

      await waitFor(async () => {
        expect(await originalReadTextFile(filename)).toEqual("Original\n");
      });
    } finally {
      unmount();
    }
  });
});
