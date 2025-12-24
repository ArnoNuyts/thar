import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
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

interface SelectionState {
  cursorId: symbol | undefined;
  anchorId: symbol | undefined;
  rangeIds: Set<symbol>;
}

interface NavigationContextType {
  indexes: IndexEntry[];
  offsetRow: number;
  listHeight: number;
  navigateUp: (shift?: boolean) => void;
  navigateDown: (shift?: boolean) => void;
  navigatePageUp: (shift?: boolean) => void;
  navigatePageDown: (shift?: boolean) => void;
  navigateHome: () => void;
  navigateEnd: () => void;
  selectedTodoId: symbol | undefined;
  setSelectedTodoId: (id: symbol | undefined) => void;
  selectedTodoIds: Set<symbol>;
  clearMultiSelect: () => void;
  useSelectedTodo: () => Todo | undefined;
  showHidden: boolean;
  toggleShowHidden: () => void;
}

const NavigationContext = createContext<NavigationContextType | undefined>(
  undefined,
);

export const NavigationProvider = (
  { children, todos, listHeightForTest }: {
    children: ReactNode;
    todos: Todos;
    listHeightForTest?: number;
  },
) => {
  const { searchQuery, isSearchFocused } = useSearch();
  const { stdout } = useStdout();
  const [offsetRow, setOffsetRow] = useState(0);

  const [selection, setSelection] = useState<SelectionState>({
    cursorId: undefined,
    anchorId: undefined,
    rangeIds: new Set(),
  });

  const [showHidden, setShowHidden] = useState(false);

  const selectedTodoId = selection.cursorId;
  const selectedTodoIds = selection.rangeIds;

  const toggleShowHidden = useCallback(
    () => setShowHidden((prev) => !prev),
    [],
  );

  const setSelectedTodoId = useCallback((id: symbol | undefined) => {
    setSelection({
      cursorId: id,
      anchorId: undefined,
      rangeIds: new Set(),
    });
  }, []);

  const clearMultiSelect = useCallback(() => {
    setSelection((prev) => ({
      ...prev,
      anchorId: undefined,
      rangeIds: new Set(),
    }));
  }, []);

  // Search bar takes 2 rows (content + border) when visible
  // Search bar is visible when focused OR has query
  const searchBarVisible = isSearchFocused || searchQuery.length > 0;
  const listHeight = listHeightForTest ??
    (stdout.rows - 2 - (searchBarVisible ? 2 : 0));

  const indexes: IndexEntry[] = useMemo(() => {
    let filteredTodos = todos.sortByImportance();

    if (!showHidden) {
      filteredTodos = filteredTodos.filterHidden();
    }

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
  }, [todos, searchQuery, showHidden]);

  // Track last selected hash to handle file reloads
  const lastSelectedHash = useRef<string | undefined>(undefined);
  // Track last selected index to handle deletion (select next/prev item)
  const lastSelectedIndex = useRef<number>(0);

  const prevTodos = useRef<Todos>(todos);

  // Guesstimate selection when todos change (e.g. undo/redo, add, toggle)
  useEffect(() => {
    if (todos === prevTodos.current) return;

    const oldTodos = prevTodos.current;
    prevTodos.current = todos;

    const oldIds = new Set(oldTodos.map((t) => t.id));
    const added = todos.filter((t) => !oldIds.has(t.id));

    if (added.length > 0) {
      // Find the first added todo that is visible in the current list
      const firstVisibleAdded = indexes.find((entry) =>
        entry.type === IndexType.todo &&
        added.some((a) => a.id === entry.todo.id)
      );
      if (firstVisibleAdded && firstVisibleAdded.type === IndexType.todo) {
        setSelectedTodoId(firstVisibleAdded.todo.id);
        return;
      }
    }

    const modified = todos.filter((t) => {
      const oldTodo = oldTodos.find((ot) => ot.id === t.id);
      return oldTodo && oldTodo.getHash() !== t.getHash();
    });

    if (modified.length > 0) {
      const firstVisibleModified = indexes.find((entry) =>
        entry.type === IndexType.todo &&
        modified.some((m) => m.id === entry.todo.id)
      );
      if (
        firstVisibleModified && firstVisibleModified.type === IndexType.todo
      ) {
        setSelectedTodoId(firstVisibleModified.todo.id);
        return;
      }
    }
  }, [todos, indexes]);

  // Update tracking refs whenever selectedTodoId changes and points to a valid todo
  useEffect(() => {
    if (selectedTodoId) {
      const index = indexes.findIndex((entry) =>
        entry.type === IndexType.todo && entry.todo.id === selectedTodoId
      );

      if (index !== -1) {
        lastSelectedIndex.current = index;
        const entry = indexes[index];
        if (entry.type === IndexType.todo) {
          lastSelectedHash.current = entry.todo.getHash();
        }
      }
    }
  }, [selectedTodoId, indexes, todos]);

  // Ensure valid selection (select first if undefined or filtered out)
  useEffect(() => {
    if (indexes.length === 0) return;

    const firstTodoIndex = indexes.findIndex((entry) =>
      entry.type === IndexType.todo
    );

    if (firstTodoIndex === -1) return;

    // Check if current selection is valid (exists and is in the current list)
    const isSelectionValid = selectedTodoId !== undefined &&
      indexes.some((entry) =>
        entry.type === IndexType.todo &&
        entry.todo.id === selectedTodoId
      );

    if (!isSelectionValid) {
      // Fallback 1: Try to match by hash (handle file reload)
      if (lastSelectedHash.current) {
        const hashMatch = indexes.find((entry) =>
          entry.type === IndexType.todo &&
          entry.todo.getHash() === lastSelectedHash.current
        );
        if (hashMatch && hashMatch.type === IndexType.todo) {
          setSelectedTodoId(hashMatch.todo.id);
          return;
        }
      }

      // Fallback 2: Try to match by index (handle deletion - select next/prev)
      const targetIndex = clamp(
        lastSelectedIndex.current,
        0,
        indexes.length - 1,
      );

      // If target hits a non-todo (e.g. header), search forward then backward
      let foundTodoIndex = -1;

      // Forward search
      for (let i = targetIndex; i < indexes.length; i++) {
        if (indexes[i].type === IndexType.todo) {
          foundTodoIndex = i;
          break;
        }
      }

      // Backward search if not found forward
      if (foundTodoIndex === -1) {
        for (let i = targetIndex - 1; i >= 0; i--) {
          if (indexes[i].type === IndexType.todo) {
            foundTodoIndex = i;
            break;
          }
        }
      }

      if (foundTodoIndex !== -1) {
        const entry = indexes[foundTodoIndex];
        if (entry.type === IndexType.todo) {
          setSelectedTodoId(entry.todo.id);
          return;
        }
      }

      // Fallback 3: Default to first item (safety net)
      if (indexes[firstTodoIndex].type === IndexType.todo) {
        setSelectedTodoId(indexes[firstTodoIndex].todo.id);
      }
    }
  }, [indexes, selectedTodoId]); // Removed setSelectedTodoId from deps as it's stable

  // Calculate selectedRow derived from selectedTodoId
  const selectedRow = useMemo(() => {
    if (!selectedTodoId) return 0;
    const index = indexes.findIndex(
      (entry) =>
        entry.type === IndexType.todo &&
        entry.todo.id === selectedTodoId,
    );
    return index !== -1 ? index : 0;
  }, [indexes, selectedTodoId]);

  // Ensure selection is visible (scroll into view)
  useEffect(() => {
    const scrollPadding = 1;

    // Avoid scroll thrashing when listHeight is too small for padding
    if (listHeight <= 2 * scrollPadding) {
      if (selectedRow < offsetRow) {
        setOffsetRow(selectedRow);
      } else if (selectedRow >= offsetRow + listHeight) {
        setOffsetRow(selectedRow - listHeight + 1);
      }
      return;
    }

    // Scrolling up with padding
    if (selectedRow < offsetRow + scrollPadding) {
      setOffsetRow(Math.max(0, selectedRow - scrollPadding));
    } // Scrolling down with padding
    else if (
      selectedRow >=
        offsetRow + listHeight - scrollPadding
    ) {
      setOffsetRow(
        // This Math.max is for safety, should not be needed with the listHeight check
        Math.max(
          0,
          Math.min(
            selectedRow - listHeight + 1 + scrollPadding,
            indexes.length - listHeight,
          ),
        ),
      );
    }
  }, [selectedRow, listHeight, offsetRow]);

  const doNavigate = useCallback((step: number, shift: boolean = false) => {
    setSelection((prev) => {
      const todoIndex = indexes.findIndex(
        (entry) =>
          entry.type === IndexType.todo &&
          entry.todo.id === prev.cursorId,
      );
      const currentRow = todoIndex === -1 ? 0 : todoIndex;
      const direction = step > 0 ? 1 : -1;
      let newSelectedRow = clamp(currentRow + step, 0, indexes.length - 1);

      // Skip context headers
      while (indexes[newSelectedRow]?.type === IndexType.context) {
        newSelectedRow += direction;
        if (newSelectedRow < 0 || newSelectedRow >= indexes.length) {
          if (direction === -1) {
            const firstTodoIndex = indexes.findIndex((e) =>
              e.type === IndexType.todo
            );
            newSelectedRow = firstTodoIndex !== -1
              ? firstTodoIndex
              : currentRow;
          } else {
            const lastTodoIndex = indexes.findLastIndex((e) =>
              e.type === IndexType.todo
            );
            newSelectedRow = lastTodoIndex !== -1 ? lastTodoIndex : currentRow;
          }
          break;
        }
      }

      const selectedEntry = indexes[newSelectedRow];
      let newId = prev.cursorId;
      if (selectedEntry?.type === IndexType.todo) {
        newId = selectedEntry.todo.id;
      }

      if (newId === undefined) return prev;

      let newAnchor = prev.anchorId;
      const newRange = new Set<symbol>();

      if (shift) {
        if (!newAnchor) {
          newAnchor = prev.cursorId ?? newId;
        }

        const anchorIndex = indexes.findIndex((e) =>
          e.type === IndexType.todo && e.todo.id === newAnchor
        );
        const newIndex = indexes.findIndex((e) =>
          e.type === IndexType.todo && e.todo.id === newId
        );

        if (anchorIndex !== -1 && newIndex !== -1) {
          const start = Math.min(anchorIndex, newIndex);
          const end = Math.max(anchorIndex, newIndex);
          for (let i = start; i <= end; i++) {
            const entry = indexes[i];
            if (entry.type === IndexType.todo) {
              newRange.add(entry.todo.id);
            }
          }
        }
      } else {
        newAnchor = undefined;
      }

      return {
        cursorId: newId,
        anchorId: newAnchor,
        rangeIds: newRange,
      };
    });
  }, [indexes]);

  const navigateUp = useCallback((shift?: boolean) => doNavigate(-1, shift), [
    doNavigate,
  ]);
  const navigateDown = useCallback((shift?: boolean) => doNavigate(1, shift), [
    doNavigate,
  ]);
  const navigatePageUp = useCallback(
    (shift?: boolean) => doNavigate(-5, shift),
    [doNavigate],
  );
  const navigatePageDown = useCallback(
    (shift?: boolean) => doNavigate(5, shift),
    [doNavigate],
  );

  const navigateHome = useCallback(() => {
    const firstTodoIndex = indexes.findIndex((entry) =>
      entry.type === IndexType.todo
    );
    if (firstTodoIndex !== -1) {
      const entry = indexes[firstTodoIndex];
      if (entry.type === IndexType.todo) {
        setSelectedTodoId(entry.todo.id);
      }
    }
  }, [indexes, setSelectedTodoId]);

  const navigateEnd = useCallback(() => {
    const lastTodoIndex = indexes.findLastIndex((entry) =>
      entry.type === IndexType.todo
    );
    if (lastTodoIndex !== -1) {
      const entry = indexes[lastTodoIndex];
      if (entry.type === IndexType.todo) {
        setSelectedTodoId(entry.todo.id);
      }
    }
  }, [indexes, setSelectedTodoId]);

  const useSelectedTodo = useCallback(() => {
    return todos.find((t) => t.id === selectedTodoId);
  }, [todos, selectedTodoId]);

  const value = useMemo(
    () => ({
      indexes,
      offsetRow,
      listHeight,
      navigateUp,
      navigateDown,
      navigatePageUp,
      navigatePageDown,
      navigateHome,
      navigateEnd,
      selectedTodoId,
      setSelectedTodoId,
      selectedTodoIds,
      clearMultiSelect,
      useSelectedTodo,
      showHidden,
      toggleShowHidden,
    }),
    [
      indexes,
      offsetRow,
      listHeight,
      navigateUp,
      navigateDown,
      navigatePageUp,
      navigatePageDown,
      navigateHome,
      navigateEnd,
      selectedTodoId,
      setSelectedTodoId,
      selectedTodoIds,
      clearMultiSelect,
      useSelectedTodo,
      showHidden,
      toggleShowHidden,
    ],
  );

  return (
    <NavigationContext.Provider value={value}>
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
