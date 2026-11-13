import { expect, test } from "vitest";
import { createElement, useEffect, useState } from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";

import { TodoProvider, useTodo } from "../contexts/todo-context.tsx";
import { ToasterProvider, useToaster } from "../contexts/toaster-context.tsx";
import { useTodoFileSync } from "../hooks/useTodoFileSync.ts";
import type { TodoFileRepository } from "../logic/todo-file-repository.ts";
import type { Todos } from "../logic/Todos.ts";
import { Todo } from "../logic/todo.ts";
import { MockWatcher, waitFor, waitPast } from "./test-utils.ts";

type FakeRepository = {
  repository: TodoFileRepository;
  watcher: MockWatcher;
  loadCalls: string[];
  saveCalls: { filename: string; todos: Todos }[];
  watchCalls: string[];
};

/**
 * In-memory repository: no Runtime patching and no filesystem access. The
 * injected port is the only seam the sync hook may use.
 */
const createFakeRepository = (initialTexts: string[] = []): FakeRepository => {
  const watcher = new MockWatcher();
  const loadCalls: string[] = [];
  const saveCalls: { filename: string; todos: Todos }[] = [];
  const watchCalls: string[] = [];
  const initialTodos = initialTexts.map((text) => new Todo(text));

  return {
    watcher,
    loadCalls,
    saveCalls,
    watchCalls,
    repository: {
      load: async (filename) => {
        loadCalls.push(filename);
        return [...initialTodos];
      },
      save: async (filename, todos) => {
        saveCalls.push({ filename, todos });
      },
      watch: (filename) => {
        watchCalls.push(filename);
        return watcher;
      },
    },
  };
};

type SyncSnapshot = {
  todos: Todos;
  sync: ReturnType<typeof useTodoFileSync>;
  setTodos: (todos: Todos) => void;
};

const SyncHarness = ({
  repository,
  onSnapshot,
}: {
  repository: TodoFileRepository;
  onSnapshot: (snapshot: SyncSnapshot) => void;
}) => {
  const [todos, setTodos] = useState<Todos>([]);
  const { showToaster } = useToaster();
  const sync = useTodoFileSync({
    filename: "todos.txt",
    todos,
    onLoad: setTodos,
    showToaster,
    repository,
    saveDebounceMs: 10,
    reloadDebounceMs: 10,
  });

  useEffect(() => {
    onSnapshot({ todos, sync, setTodos });
  }, [todos, sync, setTodos, onSnapshot]);

  return createElement(Text, null, "SyncHarness");
};

const renderSyncHarness = (
  repository: TodoFileRepository,
  onSnapshot: (snapshot: SyncSnapshot) => void,
) =>
  render(
    createElement(
      ToasterProvider,
      null,
      createElement(SyncHarness, { repository, onSnapshot }),
    ),
  );

test("TodoFileRepository: useTodoFileSync loads and watches through the injected repository", async () => {
  const fake = createFakeRepository(["Existing todo"]);
  let snapshot: SyncSnapshot | undefined;
  const onSnapshot = (next: SyncSnapshot) => {
    snapshot = next;
  };

  const { unmount } = renderSyncHarness(fake.repository, onSnapshot);

  try {
    await waitFor(() => {
      if (fake.loadCalls.length !== 1) throw new Error("Not loaded yet");
      if (!snapshot || snapshot.todos.length !== 1) {
        throw new Error("Todos not applied yet");
      }
    });

    expect(fake.loadCalls).toEqual(["todos.txt"]);
    expect(fake.watchCalls).toEqual(["todos.txt"]);
    expect(snapshot!.todos[0].text).toEqual("Existing todo");

    // The initial read is a save no-op, so the repository must stay untouched.
    await waitPast(30);
    expect(fake.saveCalls).toEqual([]);
  } finally {
    unmount();
    fake.watcher.close();
  }
});

test("TodoFileRepository: useTodoFileSync saves mutations through the injected repository", async () => {
  const fake = createFakeRepository(["Existing todo"]);
  let snapshot: SyncSnapshot | undefined;
  const onSnapshot = (next: SyncSnapshot) => {
    snapshot = next;
  };

  const { unmount } = renderSyncHarness(fake.repository, onSnapshot);

  try {
    await waitFor(() => {
      if (!snapshot || snapshot.todos.length !== 1) {
        throw new Error("Initial todos not loaded yet");
      }
    });

    // Let the initial load's no-op save pass before mutating.
    await waitPast(30);
    snapshot!.setTodos([...snapshot!.todos, new Todo("Added todo")]);

    await waitFor(() => {
      if (fake.saveCalls.length !== 1) throw new Error("Not saved yet");
    });

    expect(fake.saveCalls[0].filename).toEqual("todos.txt");
    expect(fake.saveCalls[0].todos.map((todo) => todo.text)).toEqual([
      "Existing todo",
      "Added todo",
    ]);
    expect(fake.loadCalls).toEqual(["todos.txt"]);
  } finally {
    unmount();
    fake.watcher.close();
  }
});

test("TodoFileRepository: useTodoFileSync reloads on watcher events through the injected repository", async () => {
  const fake = createFakeRepository(["Existing todo"]);
  let snapshot: SyncSnapshot | undefined;
  const onSnapshot = (next: SyncSnapshot) => {
    snapshot = next;
  };

  const { unmount } = renderSyncHarness(fake.repository, onSnapshot);

  try {
    await waitFor(() => {
      if (!snapshot || snapshot.todos.length !== 1) {
        throw new Error("Initial todos not loaded yet");
      }
    });

    fake.loadCalls.length = 0;
    fake.watcher.emit("modify");

    await waitFor(() => {
      if (fake.loadCalls.length !== 1) throw new Error("Not reloaded yet");
    });
    expect(fake.loadCalls).toEqual(["todos.txt"]);
    expect(fake.watchCalls).toEqual(["todos.txt"]);
  } finally {
    unmount();
    fake.watcher.close();
  }
});

test("TodoProvider: forwards the repository prop to the sync hook", async () => {
  const fake = createFakeRepository(["Existing todo"]);
  let api: ReturnType<typeof useTodo> | undefined;
  const onApi = (next: ReturnType<typeof useTodo>) => {
    api = next;
  };

  const ApiProbe = () => {
    const next = useTodo();
    useEffect(() => {
      onApi(next);
    }, [next]);
    return createElement(Text, null, "ApiProbe");
  };

  const { unmount } = render(
    createElement(
      ToasterProvider,
      null,
      createElement(
        TodoProvider,
        { filename: "todos.txt", repository: fake.repository },
        createElement(ApiProbe),
      ),
    ),
  );

  try {
    await waitFor(() => {
      if (!api || api.todos.length !== 1) {
        throw new Error("Initial todos not loaded yet");
      }
    });
    expect(fake.loadCalls).toEqual(["todos.txt"]);
    expect(fake.watchCalls).toEqual(["todos.txt"]);

    api!.addTodos("Provider todo");
    await waitFor(() => {
      if (fake.saveCalls.length !== 1) throw new Error("Not saved yet");
    });
    expect(fake.saveCalls[0].filename).toEqual("todos.txt");
    expect(fake.saveCalls[0].todos.map((todo) => todo.text)).toEqual([
      "Existing todo",
      "Provider todo",
    ]);
  } finally {
    unmount();
    fake.watcher.close();
  }
});
