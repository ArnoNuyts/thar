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
import { useModal } from "./modal-context.tsx";
import { Todo } from "../logic/todo.ts";

interface TodoContextType {
  todos: Todos;
  setTodos: (todos: Todos) => void;
  selectedTodoHash: string | undefined;
  setSelectedTodoHash: (hash: string | undefined) => void;
  addTodo: (text: string) => void;
  updateTodo: (todo: Todo) => void;
  deleteTodo: (todo: Todo) => void;
  toggleTodo: (todo: Todo) => void;
  toggleHidden: (todo: Todo) => void;
  useSelectedTodo: () => Todo | undefined;
  lastReloaded: number | undefined;
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
  const [selectedTodoHash, setSelectedTodoHash] = useState<string | undefined>(
    undefined,
  );
  const [lastReloaded, setLastReloaded] = useState<number | undefined>(undefined);
  const justReadFileFlag = useRef(false);
  const justWrittenFileFlag = useRef(false);
  const { openModal } = useModal();

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
    [filename],
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
      console.error("Failed to watch file:", error);
    }

    const readTodosDebounced = debounce(async () => {
      justReadFileFlag.current = true;
      const todosFromFile = await readTodosFromFile(filename);
      setTodos(new Todos(...todosFromFile));
      setLastReloaded(Date.now());
    }, 500);

    const processEvents = async () => {
      if (!watcher) return;
      for await (const event of watcher) {
        if (event.kind === "modify") {
          // Prevent write-read loop
          if (justWrittenFileFlag.current) {
            justWrittenFileFlag.current = false;
            continue;
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

  const addTodo = (text: string) => {
    const newTodo = new Todo(text);
    newTodo.creationDate = new Date();
    setTodos(new Todos(...todos, newTodo));
    setSelectedTodoHash(newTodo.getHash());
  };

  const updateTodo = (todo: Todo) => {
    // Since Todo objects are mutable and we are likely modifying the instance directly before calling this,
    // we just need to trigger a re-render and save.
    setTodos(new Todos(...todos));
    setSelectedTodoHash(todo.getHash());
  };

  const deleteTodo = (todo: Todo) => {
    const newTodos = todos.filter((t: Todo) => t !== todo);
    setTodos(new Todos(...newTodos));
    if (selectedTodoHash === todo.getHash()) {
      setSelectedTodoHash(undefined);
    }
  };

  const toggleTodo = (todo: Todo) => {
    const oldHash = todo.getHash();
    const recurring = todo.toggleState();
    
    if (recurring) {
      setTodos(new Todos(...todos, recurring));
    } else {
      setTodos(new Todos(...todos));
    }
    
    // Update selection to new hash if this todo was selected
    if (selectedTodoHash === oldHash) {
      setSelectedTodoHash(todo.getHash());
    }
  };

  const toggleHidden = (todo: Todo) => {
    const oldHash = todo.getHash();
    todo.toggleHidden();
    
    setTodos(new Todos(...todos));
    
    // Update selection to new hash if this todo was selected
    if (selectedTodoHash === oldHash) {
      setSelectedTodoHash(todo.getHash());
    }
  };

  const useSelectedTodo = () => {
    return todos.find((t) => t.getHash() === selectedTodoHash);
  };

  return (
    <TodoContext.Provider
      value={{
        todos,
        setTodos,
        selectedTodoHash,
        setSelectedTodoHash,
        addTodo,
        updateTodo,
        deleteTodo,
        toggleTodo,
        toggleHidden,
        useSelectedTodo,
        lastReloaded,
      }}
    >
      {children}
    </TodoContext.Provider>
  );
};
