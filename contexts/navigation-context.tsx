import {
  createContext,
  ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useSearch } from "./search-context.tsx";
import { useStdout } from "ink";
import { Todos } from "../logic/Todos.ts";
import { createIndexes, IndexEntry } from "../logic/indexes.ts";
import { IndexType } from "../types/enums.ts";
import { Todo } from "../logic/todo.ts";

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

interface NavigationContextType {
  indexes: IndexEntry[];
  offsetRow: number;
  listHeight: number;
  navigateUp: () => void;
  navigateDown: () => void;
  navigatePageUp: () => void;
  navigatePageDown: () => void;
  selectedTodoHash: string | undefined;
  setSelectedTodoHash: (hash: string | undefined) => void;
  useSelectedTodo: () => Todo | undefined;
}

const NavigationContext = createContext<NavigationContextType | undefined>(
  undefined,
);

export const NavigationProvider = (
  { children, todos }: { children: ReactNode; todos: Todos },
) => {
  const { searchQuery, isSearchFocused } = useSearch();
  const { stdout } = useStdout();
  const [offsetRow, setOffsetRow] = useState(0);
  const [selectedTodoHash, setSelectedTodoHash] = useState<string | undefined>(
    undefined,
  );

  // Search bar takes 2 rows (content + border) when visible
  // Search bar is visible when focused OR has query
  const searchBarVisible = isSearchFocused || searchQuery.length > 0;
  const listHeight = stdout.rows - 2 - (searchBarVisible ? 2 : 0);

  const indexes: IndexEntry[] = useMemo(() => {
    let filteredTodos = todos.sortByImportance().filterHidden();

    // Apply search filter if query exists
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase().trim();
      filteredTodos = new Todos(
        ...filteredTodos.filter((todo) => {
          const text = todo.text.toLowerCase();
          const contexts = Array.from(todo.contexts).map((c) =>
            c.toLowerCase()
          );
          const projects = Array.from(todo.projects).map((p) =>
            p.toLowerCase()
          );

          return (
            text.includes(query) ||
            contexts.some((c) => c.includes(query.replace("@", ""))) ||
            projects.some((p) => p.includes(query.replace("+", "")))
          );
        }),
      );
    }
    return createIndexes(filteredTodos);
  }, [todos, searchQuery]);

  // Ensure valid selection (select first if undefined or filtered out)
  useEffect(() => {
    if (indexes.length === 0) return;

    const firstTodoIndex = indexes.findIndex((entry) =>
      entry.type === IndexType.todo
    );

    if (firstTodoIndex === -1) return;

    // Check if current selection is valid (exists and is in the current list)
    const isSelectionValid = selectedTodoHash !== undefined &&
      indexes.some((entry) =>
        entry.type === IndexType.todo &&
        entry.todo.getHash() === selectedTodoHash
      );

    if (!isSelectionValid) {
      if (indexes[firstTodoIndex].type === IndexType.todo) {
        setSelectedTodoHash(indexes[firstTodoIndex].todo.getHash());
      }
    }
  }, [indexes, selectedTodoHash]); // Removed setSelectedTodoHash from deps as it's stable

  // Calculate selectedRow derived from selectedTodoHash
  const selectedRow = useMemo(() => {
    if (!selectedTodoHash) return 0;
    const index = indexes.findIndex(
      (entry) =>
        entry.type === IndexType.todo &&
        entry.todo.getHash() === selectedTodoHash,
    );
    return index !== -1 ? index : 0;
  }, [indexes, selectedTodoHash]);

  // Ensure selection is visible (scroll into view)
  useEffect(() => {
    if (selectedRow < offsetRow) {
      setOffsetRow(selectedRow);
    } else if (selectedRow >= offsetRow + listHeight) {
      setOffsetRow(selectedRow - listHeight + 1);
    }
  }, [selectedRow, listHeight, offsetRow]);

  const doNavigate = (step: number) => {
    let newSelectedRow = selectedRow;
    const direction = step > 0 ? 1 : -1;
    newSelectedRow = clamp(selectedRow + step, 0, indexes.length - 1);

    while (indexes[newSelectedRow]?.type === IndexType.context) {
      newSelectedRow += direction;
      if (newSelectedRow < 0 || newSelectedRow >= indexes.length) {
        newSelectedRow = selectedRow;
        break;
      }
    }

    const selectedEntry = indexes[newSelectedRow];
    if (selectedEntry?.type === IndexType.todo) {
      setSelectedTodoHash(selectedEntry.todo.getHash());
    }
  };

  const navigateUp = () => doNavigate(-1);
  const navigateDown = () => doNavigate(1);
  const navigatePageUp = () => doNavigate(-5);
  const navigatePageDown = () => doNavigate(5);

  const useSelectedTodo = () => {
    return todos.find((t) => t.getHash() === selectedTodoHash);
  };

  return (
    <NavigationContext.Provider
      value={{
        indexes,
        offsetRow,
        listHeight,
        navigateUp,
        navigateDown,
        navigatePageUp,
        navigatePageDown,
        selectedTodoHash,
        setSelectedTodoHash,
        useSelectedTodo,
      }}
    >
      {children}
    </NavigationContext.Provider>
  );
};

export const useNavigation = () => {
  const context = useContext(NavigationContext);
  if (!context) {
    throw new Error("useNavigation must be used within a NavigationProvider");
  }
  return context;
};
