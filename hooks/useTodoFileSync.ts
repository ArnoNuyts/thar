import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { debounce } from "../utils/debounce.ts";
import { toBoundedDisplayMessage } from "../logic/display-safety.ts";
import type { Todos } from "../logic/Todos.ts";
import {
  todoFileRepository,
  type TodoFileRepository,
} from "../logic/todo-file-repository.ts";
import type { FsWatcher } from "../utils/runtime.ts";

export const DEFAULT_SAVE_DEBOUNCE_MS = 50;
export const DEFAULT_RELOAD_DEBOUNCE_MS = 500;

export interface TodoFileSyncOptions {
  filename: string;
  todos: Todos;
  onLoad: (todos: Todos) => void;
  showToaster: (message: string) => void;
  /** File access port; defaults to the real filesystem repository. */
  repository?: TodoFileRepository;
  /** Test seam: shortens the save debounce without changing production flow. */
  saveDebounceMs?: number;
  /** Test seam: shortens the watcher reload debounce. */
  reloadDebounceMs?: number;
}

export interface TodoFileSyncState {
  /** Last read failure, bounded and safe to display; undefined when healthy. */
  loadError: string | undefined;
  /** True while the last load/reload failed; mutations must not be saved. */
  readOnly: boolean;
}

/**
 * File synchronization for TodoProvider: initial load, debounced save, the
 * filesystem watcher, and the read-only recovery state.
 *
 * Kept separate from the reducer and actions so TodoProvider stays focused on
 * state, and so the save/reload race can be tested without the provider.
 */
export const useTodoFileSync = ({
  filename,
  todos,
  onLoad,
  showToaster,
  repository = todoFileRepository,
  saveDebounceMs = DEFAULT_SAVE_DEBOUNCE_MS,
  reloadDebounceMs = DEFAULT_RELOAD_DEBOUNCE_MS,
}: TodoFileSyncOptions): TodoFileSyncState => {
  const justReadFileRef = useRef<Todos | null>(null);
  const hasLoadedFileRef = useRef(false);
  const lastWriteTimeRef = useRef(0);
  const [loadError, setLoadErrorState] = useState<string | undefined>(
    undefined,
  );
  const loadErrorRef = useRef<string | undefined>(undefined);
  const readOnly = loadError !== undefined;

  const setLoadError = useCallback((message: string | undefined) => {
    loadErrorRef.current = message;
    setLoadErrorState(message);
  }, []);

  // Initial load
  useEffect(() => {
    let cancelled = false;
    // Until the file has been read, `todos` is just the empty startup state.
    // Saving it would truncate the real file when the read is slow (the save
    // debounce is shorter than a slow disk access).
    hasLoadedFileRef.current = false;
    setLoadError(undefined);
    repository
      .load(filename)
      .then((initialTodos) => {
        if (cancelled) return;
        const loadedTodos = [...initialTodos];
        hasLoadedFileRef.current = true;
        justReadFileRef.current = loadedTodos;
        setLoadError(undefined);
        onLoad(loadedTodos);
      })
      .catch((error) => {
        if (cancelled) return;
        // Stay unloaded and read-only so the empty startup state (or stale
        // state from a previous file) cannot be written over the file.
        const message = toBoundedDisplayMessage(error);
        setLoadError(message);
        showToaster(message);
      });

    return () => {
      cancelled = true;
    };
  }, [filename, repository, setLoadError, onLoad, showToaster]);

  // Save effect
  const saveTodos = useMemo(
    () =>
      debounce(async (currentTodos: Todos) => {
        // A failed load/reload puts the provider in read-only mode until a
        // later read succeeds. Check at execution time too: a save scheduled
        // just before the failure must not overwrite the rejected file.
        if (loadErrorRef.current) return;
        if (justReadFileRef.current === currentTodos) {
          justReadFileRef.current = null;
          return;
        }
        // This mutation wins the debounce, so the array from the last read is
        // no longer "just read". Clear it before writing: a later undo back to
        // that array must be persisted instead of being mistaken for a no-op.
        justReadFileRef.current = null;
        lastWriteTimeRef.current = Date.now();
        try {
          await repository.save(filename, currentTodos);
        } catch (error) {
          // A write-time rejection must be visible: the in-memory change was
          // not persisted. The message is bounded and never echoes content.
          const message = toBoundedDisplayMessage(error);
          console.error("Failed to save todos:", message);
          showToaster(message);
        } finally {
          lastWriteTimeRef.current = Date.now();
        }
      }, saveDebounceMs),
    [filename, repository, saveDebounceMs, showToaster],
  );

  // Cancel a pending save only when the debounced function is replaced (for
  // example when `filename` changes) or the sync hook unmounts. Ordinary todo
  // updates must not cancel the debounce.
  useEffect(() => {
    return () => saveTodos.clear();
  }, [saveTodos]);

  useEffect(() => {
    // Do not persist the empty startup state before the initial load completes,
    // and never persist stale in-memory todos while the file is rejected.
    if (!hasLoadedFileRef.current || readOnly) return;
    saveTodos(todos);
  }, [todos, saveTodos, readOnly]);

  // Watcher effect
  useEffect(() => {
    let cancelled = false;
    let watcher: FsWatcher | undefined;
    try {
      watcher = repository.watch(filename);
    } catch (error) {
      console.error("Failed to watch file:", error);
    }

    const readTodosDebounced = debounce(async () => {
      try {
        const todosFromFile = await repository.load(filename);
        if (cancelled) return;
        const loadedTodos = [...todosFromFile];
        hasLoadedFileRef.current = true;
        justReadFileRef.current = loadedTodos;
        setLoadError(undefined);
        onLoad(loadedTodos);
        showToaster("File reloaded");
      } catch (error) {
        if (cancelled) return;
        // Keep the last known good list, but stop saving it until the file is
        // valid again. Cancel a pending save from before the failure.
        saveTodos.clear();
        const message = toBoundedDisplayMessage(error);
        setLoadError(message);
        showToaster(message);
      }
    }, reloadDebounceMs);

    const processEvents = async () => {
      if (!watcher) return;
      try {
        for await (const event of watcher) {
          if (cancelled) break;
          // Ignore startup events (for example creating a missing todo file)
          // until the initial load has settled. Once a load has failed, keep
          // processing so a fixed file can recover the provider.
          if (!hasLoadedFileRef.current && !loadErrorRef.current) continue;
          if (event.kind === "modify" || event.kind === "rename") {
            // Prevent write-read loop
            if (Date.now() - lastWriteTimeRef.current < 1000) {
              continue;
            }
            readTodosDebounced();
          }
        }
      } catch (error) {
        if (!cancelled) {
          console.error("Failed to process file events:", error);
        }
      }
    };
    processEvents();

    return () => {
      cancelled = true;
      readTodosDebounced.clear();
      if (watcher) {
        try {
          watcher.close();
        } catch (error) {
          console.error("Failed to close file watcher:", error);
        }
      }
    };
  }, [
    filename,
    repository,
    setLoadError,
    saveTodos,
    showToaster,
    onLoad,
    reloadDebounceMs,
  ]);

  return { loadError, readOnly };
};
