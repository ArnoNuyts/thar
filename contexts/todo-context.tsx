import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { debounce } from "@std/async/debounce";
import {
  readTodosFromFile,
  writeTodosToFile,
} from "../logic/todo-file-helpers.ts";
import { Todos } from "../logic/Todos.ts";

interface TodoContextType {
  todos: Todos;
  setTodos: (todos: Todos) => void;
}

const TodoContext = createContext<TodoContextType | undefined>(undefined);

export const useTodo = () => {
  const context = useContext(TodoContext);
  if (!context) {
    throw new Error("useTodo must be used within a TodoProvider");
  }
  return context;
};

export const TodoProvider = ({
  filename,
  children,
}: {
  filename: string;
  children?: React.ReactNode;
}) => {
  const [todos, setTodos] = useState<Todos>(new Todos());
  const justReadFileFlag = useRef(false);
  const justWrittenFileFlag = useRef(false);

  // Initial load
  useEffect(() => {
    readTodosFromFile(filename).then((initialTodos) => {
      justReadFileFlag.current = true;
      setTodos(new Todos(...initialTodos));
    });
  }, [filename]);

  // Save effect
  const saveTodos = useMemo(
    () =>
      debounce(async (currentTodos: Todos) => {
        if (justReadFileFlag.current) {
          justReadFileFlag.current = false;
          return;
        }
        await writeTodosToFile(currentTodos, filename);
        justWrittenFileFlag.current = true;
      }, 50),
    [filename]
  );

  useEffect(() => {
    saveTodos(todos);
  }, [todos, saveTodos]);

  // Watcher effect
  useEffect(() => {
    let watcher: Deno.FsWatcher | undefined;
    try {
      watcher = Deno.watchFs(filename);
    } catch (error) {
      // File might not exist yet, or other error.
      // readTodosFromFile handles creation, so this might be fine if called after initial load?
      // But initial load is async.
      // We can ignore error or retry?
      // main.ts awaits openTodoFileWatcher at the end.
      console.error("Failed to watch file:", error);
    }

    const readTodosDebounced = debounce(async () => {
      justReadFileFlag.current = true;
      const todosFromFile = await readTodosFromFile(filename);
      setTodos(new Todos(...todosFromFile));
    }, 500);

    const processEvents = async () => {
      if (!watcher) return;
      for await (const event of watcher) {
        if (event.kind === "modify") {
          // Prevent write-read loop
          if (justWrittenFileFlag.current) {
            justWrittenFileFlag.current = false;
            return;
          }
          readTodosDebounced();
        }
      }
    };
    processEvents();

    return () => {
      if (watcher) {
        watcher.close();
      }
    };
  }, [filename]);

  return (
    <TodoContext.Provider value={{ todos, setTodos }}>
      {children}
    </TodoContext.Provider>
  );
};
