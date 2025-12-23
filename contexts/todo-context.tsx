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
  addTodos: (...texts: string[]) => Todo[];
  updateTodo: (oldTodo: Todo, newTodo: Todo) => void;
  deleteTodo: (todo: Todo) => void;
  deleteTodos: (todosToDelete: Todo[]) => void;
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

  const pushHistory = () => {
    setHistory((prev) => [...prev, todos]);
    setRedoStack([]);
  };

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

  const undo = () => {
    if (history.length === 0) return;
    const previousTodos = history[history.length - 1];

    // We need to save current state to redo stack before undoing
    setRedoStack((prev) => [...prev, todos]);

    setTodos(previousTodos);
    setHistory((prev) => prev.slice(0, -1));
    showToaster("Undo successful");
  };

  const redo = () => {
    if (redoStack.length === 0) return;
    const nextTodos = redoStack[redoStack.length - 1];

    // We need to save current state to history before redoing
    setHistory((prev) => [...prev, todos]);

    setRedoStack((prev) => prev.slice(0, -1));
    setTodos(nextTodos);
    showToaster("Redo successful");
  };

  const addTodos = (...texts: string[]): Todo[] => {
    if (texts.length === 0) return [];
    pushHistory();
    const newTodos = texts.map((text) =>
      new Todo(text).setCreationDate(new Date())
    );
    setTodos(new Todos(...todos, ...newTodos));
    return newTodos;
  };

  const updateTodo = (oldTodo: Todo, newTodo: Todo) => {
    pushHistory();
    setTodos(new Todos(...todos.map((t) => (t === oldTodo ? newTodo : t))));
  };

  const deleteTodo = (todo: Todo) => {
    pushHistory();
    const newTodos = todos.filter((t: Todo) => t !== todo);
    setTodos(new Todos(...newTodos));
  };

  const deleteTodos = (todosToDelete: Todo[]) => {
    pushHistory();
    const idsToDelete = new Set(todosToDelete.map((t) => t.id));
    const newTodos = todos.filter((t: Todo) => !idsToDelete.has(t.id));
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
    // pushHistory is handled in updateTodo
    const updated = todo.toggleHidden();
    updateTodo(todo, updated);
  };

  const archiveCompletedTodos = async () => {
    pushHistory();
    const completedTodos = todos.filter((t: Todo) => t.isDone());
    if (completedTodos.length === 0) return;

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
        addTodos,
        updateTodo,
        deleteTodo,
        deleteTodos,
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
