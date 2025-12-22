import {
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
import { Todo } from "../logic/todo.ts";
import { useToaster } from "./toaster-context.tsx";

interface TodoContextType {
  todos: Todos;
  setTodos: (todos: Todos) => void;
  addTodo: (text: string) => Todo;
  updateTodo: (oldTodo: Todo, newTodo: Todo) => void;
  refreshTodos: () => void;
  deleteTodo: (todo: Todo) => void;
  toggleTodo: (todo: Todo) => void;
  toggleHidden: (todo: Todo) => void;
  archiveCompletedTodos: () => Promise<void>;
  undo: () => void;
  canUndo: boolean;
  redo: () => void;
  canRedo: boolean;
}

export const TodoContext = createContext<TodoContextType | undefined>(
  undefined,
);

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
  const [history, setHistory] = useState<Todos[]>([]);
  const [redoStack, setRedoStack] = useState<Todos[]>([]);
  const { showToaster } = useToaster();
  const justReadFileFlag = useRef(false);
  const lastWriteTimeRef = useRef(0);

  // Initial load
  useEffect(() => {
    readTodosFromFile(filename).then((initialTodos) => {
      justReadFileFlag.current = true;
      setTodos(new Todos(...initialTodos));
      setHistory([]);
      setRedoStack([]);
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
        lastWriteTimeRef.current = Date.now();
        await writeTodosToFile(currentTodos, filename);
        lastWriteTimeRef.current = Date.now();
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
      setHistory([]);
      setRedoStack([]);
      showToaster("File reloaded");
    }, 500);

    const processEvents = async () => {
      if (!watcher) return;
      for await (const event of watcher) {
        if (event.kind === "modify") {
          // Prevent write-read loop
          if (Date.now() - lastWriteTimeRef.current < 1000) {
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

  const pushHistory = () => {
    setHistory((prev) => [...prev, todos]);
    setRedoStack([]);
  };

  const undo = () => {
    if (history.length === 0) return;
    const previousTodos = history[history.length - 1];
    setHistory((prev) => prev.slice(0, -1));
    setRedoStack((prev) => [...prev, todos]);
    setTodos(previousTodos);
    showToaster("Undo successful");
  };

  const redo = () => {
    if (redoStack.length === 0) return;
    const nextTodos = redoStack[redoStack.length - 1];
    setRedoStack((prev) => prev.slice(0, -1));
    setHistory((prev) => [...prev, todos]);
    setTodos(nextTodos);
    showToaster("Redo successful");
  };

  const addTodo = (text: string): Todo => {
    pushHistory();
    const newTodo = new Todo(text).setCreationDate(new Date());
    setTodos(new Todos(...todos, newTodo));
    return newTodo;
  };

  const updateTodo = (oldTodo: Todo, newTodo: Todo) => {
    pushHistory();
    setTodos(new Todos(...todos.map((t) => (t === oldTodo ? newTodo : t))));
  };

  const refreshTodos = () => {
    setTodos(new Todos(...todos));
  };

  const deleteTodo = (todo: Todo) => {
    pushHistory();
    const newTodos = todos.filter((t: Todo) => t !== todo);
    setTodos(new Todos(...newTodos));
  };

  const toggleTodo = (todo: Todo) => {
    pushHistory();
    const { updated, recurring } = todo.toggleState();

    if (recurring) {
      setTodos(
        new Todos(...todos.map((t) => (t === todo ? updated : t)), recurring),
      );
      showToaster("Recurring todo created");
    } else {
      setTodos(new Todos(...todos.map((t) => (t === todo ? updated : t))));
    }
  };

  const toggleHidden = (todo: Todo) => {
    const updated = todo.toggleHidden();
    updateTodo(todo, updated);
  };

  const archiveCompletedTodos = async () => {
    const completedTodos = todos.filter((t: Todo) => t.isDone());
    if (completedTodos.length === 0) return;

    pushHistory();

    // Append to done.txt
    // Assuming done.txt is in the same directory as the main file
    const separator = filename.includes("\\") ? "\\" : "/";
    const lastIndex = filename.lastIndexOf(separator);
    let doneFile = "done.txt";

    if (lastIndex !== -1) {
      const dir = filename.substring(0, lastIndex);
      doneFile = `${dir}${separator}done.txt`;
    }

    await writeTodosToFile(completedTodos, doneFile, {
      append: true,
      create: true,
    });

    // Remove from current todos
    const remainingTodos = todos.filter((t: Todo) => !t.isDone());
    setTodos(new Todos(...remainingTodos));
  };

  return (
    <TodoContext.Provider
      value={{
        todos,
        setTodos,
        addTodo,
        updateTodo,
        refreshTodos,
        deleteTodo,
        toggleTodo,
        toggleHidden,
        archiveCompletedTodos,
        undo,
        canUndo: history.length > 0,
        redo,
        canRedo: redoStack.length > 0,
      }}
    >
      {children}
    </TodoContext.Provider>
  );
};
