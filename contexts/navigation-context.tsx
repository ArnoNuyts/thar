import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
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

interface SelectionState {
  cursorId: symbol | undefined;
  anchorId: symbol | undefined;
  rangeIds: Set<symbol>;
}

// ============================================================================
// Pure Reconciliation Functions
// ============================================================================

/**
 * Guesstimate the best selection when todos change (add/modify).
 * Returns the ID of the todo that should be selected, or undefined to keep current.
 */
function guesstimateSelection(
  todos: Todos,
  prevTodos: Todos,
  indexes: IndexEntry[],
  currentCursorId: symbol | undefined,
): symbol | undefined {
  if (todos === prevTodos) return undefined;

  const oldIds = new Set(prevTodos.map((t) => t.id));
  const added = todos.filter((t) => !oldIds.has(t.id));

  // Priority 1: Select first visible added todo
  // If ALL todos are "added", it's likely a reload or reset - don't guesstimate,
  // let validation handle it (supports hash-matching).
  if (added.length > 0 && added.length < todos.length) {
    const firstVisibleAdded = indexes.find((entry) =>
      entry.type === IndexType.todo &&
      added.some((a) => a.id === entry.todo.id)
    );
    if (firstVisibleAdded?.type === IndexType.todo) {
      return firstVisibleAdded.todo.id;
    }
  }

  // Priority 2: Select first visible modified todo (if cursor is no longer valid)
  const modified = todos.filter((t) => {
    const oldTodo = prevTodos.find((ot) => ot.id === t.id);
    return oldTodo && oldTodo.getHash() !== t.getHash();
  });

  if (modified.length > 0) {
    // If cursor is among modified and still visible, keep it
    const isCursorValid = currentCursorId &&
      modified.some((m) => m.id === currentCursorId) &&
      indexes.some((e) =>
        e.type === IndexType.todo && e.todo.id === currentCursorId
      );

    if (isCursorValid) return undefined; // Keep current

    const firstVisibleModified = indexes.find((entry) =>
      entry.type === IndexType.todo &&
      modified.some((m) => m.id === entry.todo.id)
    );
    if (firstVisibleModified?.type === IndexType.todo) {
      return firstVisibleModified.todo.id;
    }
  }

  return undefined; // No change needed
}

/**
 * Validate the current selection. If invalid, find a fallback.
 * Returns the validated/fallback cursor ID.
 */
function validateSelection(
  cursorId: symbol | undefined,
  indexes: IndexEntry[],
  lastHash: string | undefined,
  lastIndex: number,
): symbol | undefined {
  if (indexes.length === 0) return undefined;

  const firstTodoIndex = indexes.findIndex((entry) =>
    entry.type === IndexType.todo
  );
  if (firstTodoIndex === -1) return undefined;

  // Check if current selection is valid
  const isValid = cursorId !== undefined &&
    indexes.some((entry) =>
      entry.type === IndexType.todo && entry.todo.id === cursorId
    );

  if (isValid) return cursorId;

  // Fallback 1: Match by hash (handle file reload)
  if (lastHash) {
    const hashMatch = indexes.find((entry) =>
      entry.type === IndexType.todo && entry.todo.getHash() === lastHash
    );
    if (hashMatch?.type === IndexType.todo) {
      return hashMatch.todo.id;
    }
  }

  // Fallback 2: Match by index (handle deletion)
  const targetIndex = clamp(lastIndex, 0, indexes.length - 1);

  // Forward search
  for (let i = targetIndex; i < indexes.length; i++) {
    if (indexes[i].type === IndexType.todo) {
      return (indexes[i] as { type: IndexType.todo; todo: Todo }).todo.id;
    }
  }

  // Backward search
  for (let i = targetIndex - 1; i >= 0; i--) {
    if (indexes[i].type === IndexType.todo) {
      return (indexes[i] as { type: IndexType.todo; todo: Todo }).todo.id;
    }
  }

  // Fallback 3: First todo
  const firstEntry = indexes[firstTodoIndex];
  if (firstEntry.type === IndexType.todo) {
    return firstEntry.todo.id;
  }

  return undefined;
}

/**
 * Calculate the scroll offset to keep selection visible.
 */
function calculateScrollOffset(
  selectedRow: number,
  selectionRange: { min: number; max: number },
  currentOffset: number,
  listHeight: number,
  indexesLength: number,
): number {
  const scrollPadding = 1;
  const { min: minRow, max: maxRow } = selectionRange;

  // Priority 1: Keep cursor visible
  // Scrolling up
  if (selectedRow < currentOffset + scrollPadding) {
    return Math.max(0, selectedRow - scrollPadding);
  }

  // Scrolling down
  if (selectedRow >= currentOffset + listHeight - scrollPadding) {
    const newOffset = selectedRow - listHeight + 1 + scrollPadding;
    // console.log("DEBUG: Snapping to 0");
    //   newOffset = 0;
    // }
    return Math.max(0, Math.min(newOffset, indexesLength - listHeight));
  }

  // Priority 2: Show range if it fits
  const rangeHeight = maxRow - minRow + 1;
  if (rangeHeight <= listHeight) {
    if (minRow < currentOffset) {
      return minRow;
    }
    if (maxRow >= currentOffset + listHeight) {
      return Math.max(
        0,
        Math.min(maxRow - listHeight + 1, indexesLength - listHeight),
      );
    }
  }

  return currentOffset;
}

// ============================================================================
// Context Definition
// ============================================================================

export interface NavigationContextType {
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
  useSelectedTodos: () => Todo[];
  showHidden: boolean;
  toggleShowHidden: () => void;
}

export const NavigationContext = createContext<
  NavigationContextType | undefined
>(
  undefined,
);

interface NavState {
  selection: SelectionState;
  offsetRow: number;
  // Tracking for prop sync
  prevTodos: Todos;
  lastHash: string | undefined;
  lastIndex: number;
}

export const NavigationProvider = (
  { children, todos, listHeightForTest }: {
    children: ReactNode;
    todos: Todos;
    listHeightForTest?: number;
  },
) => {
  const { searchQuery, isSearchFocused } = useSearch();
  const { stdout } = useStdout();

  const [showHidden, setShowHidden] = useState(false);

  const [state, setState] = useState<NavState>({
    selection: {
      cursorId: undefined,
      anchorId: undefined,
      rangeIds: new Set(),
    },
    offsetRow: 0,
    prevTodos: todos,
    lastHash: undefined,
    lastIndex: 0,
  });

  const toggleShowHidden = useCallback(
    () => setShowHidden((prev) => !prev),
    [],
  );

  // Search bar takes 2 rows (content + border) when visible
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

  // Derived State: Handle prop changes synchronously during render
  // We use a local variable `activeState` to ensure the current render sees the *new* state immediately.
  let activeState = state;

  // 1. Prop Sync (Guesstimate on content change)
  if (todos !== state.prevTodos) {
    const prevTodos = state.prevTodos;

    // Step 1: Guesstimate
    const guesstimatedId = guesstimateSelection(
      todos,
      prevTodos,
      indexes,
      state.selection.cursorId,
    );

    // Step 2: Validate
    const cursorToValidate = guesstimatedId ?? state.selection.cursorId;
    const validatedCursorId = validateSelection(
      cursorToValidate,
      indexes,
      state.lastHash,
      state.lastIndex,
    );

    // Step 3: Scroll & Metadata
    const selectedRow = validatedCursorId
      ? indexes.findIndex((e) =>
        e.type === IndexType.todo && e.todo.id === validatedCursorId
      )
      : 0;

    // Calculate range logic (simplified for immediate update)
    let rangeMin = selectedRow;
    let rangeMax = selectedRow;
    if (state.selection.rangeIds.size > 0) {
      indexes.forEach((entry, index) => {
        if (
          entry.type === IndexType.todo &&
          state.selection.rangeIds.has(entry.todo.id)
        ) {
          rangeMin = Math.min(rangeMin, index);
          rangeMax = Math.max(rangeMax, index);
        }
      });
    }

    const newOffsetRow = calculateScrollOffset(
      selectedRow,
      { min: rangeMin, max: rangeMax },
      state.offsetRow,
      listHeight,
      indexes.length,
    );

    let newLastHash = state.lastHash;
    if (selectedRow !== -1 && validatedCursorId) {
      const entry = indexes[selectedRow];
      if (entry?.type === IndexType.todo) {
        newLastHash = entry.todo.getHash();
      }
    }

    // Prepare new selection state
    let newSelection = state.selection;
    if (
      validatedCursorId !== state.selection.cursorId ||
      guesstimatedId !== undefined
    ) {
      if (guesstimatedId !== undefined) {
        newSelection = {
          cursorId: validatedCursorId,
          anchorId: undefined,
          rangeIds: new Set(),
        };
      } else {
        newSelection = {
          ...state.selection,
          cursorId: validatedCursorId,
        };
      }
    }

    activeState = {
      selection: newSelection,
      offsetRow: newOffsetRow,
      prevTodos: todos,
      lastIndex: selectedRow !== -1 ? selectedRow : state.lastIndex,
      lastHash: newLastHash,
    };
    setState(activeState);
  }

  // 2. Validation / Auto-Correction (Runs on every render)
  // Ensures selection is valid (exists in indexes) after Init, Filter change, or Guesstimate.
  const currentCursor = activeState.selection.cursorId;
  const validatedCursor = validateSelection(
    currentCursor,
    indexes,
    activeState.lastHash,
    activeState.lastIndex,
  );

  if (validatedCursor !== currentCursor) {
    const selectedRow = validatedCursor
      ? indexes.findIndex((e) =>
        e.type === IndexType.todo && e.todo.id === validatedCursor
      )
      : 0;

    let rangeMin = selectedRow;
    let rangeMax = selectedRow;
    if (activeState.selection.rangeIds.size > 0) {
      indexes.forEach((entry, index) => {
        if (
          entry.type === IndexType.todo &&
          activeState.selection.rangeIds.has(entry.todo.id)
        ) {
          rangeMin = Math.min(rangeMin, index);
          rangeMax = Math.max(rangeMax, index);
        }
      });
    }

    const newOffsetRow = calculateScrollOffset(
      selectedRow,
      { min: rangeMin, max: rangeMax },
      activeState.offsetRow,
      listHeight,
      indexes.length,
    );

    let newLastHash = activeState.lastHash;
    if (selectedRow !== -1 && validatedCursor) {
      const entry = indexes[selectedRow];
      if (entry?.type === IndexType.todo) {
        newLastHash = entry.todo.getHash();
      }
    }

    activeState = {
      ...activeState,
      selection: {
        ...activeState.selection,
        cursorId: validatedCursor,
      },
      offsetRow: newOffsetRow,
      lastIndex: selectedRow !== -1 ? selectedRow : activeState.lastIndex,
      lastHash: newLastHash,
    };
    setState(activeState);
  }

  // Derived state: Clear multi-select if filtered out
  const visibleIds = useMemo(() => {
    const ids = new Set<symbol>();
    for (const entry of indexes) {
      if (entry.type === IndexType.todo) {
        ids.add(entry.todo.id);
      }
    }
    return ids;
  }, [indexes]);

  if (activeState.selection.rangeIds.size > 0) {
    let hasInvisible = false;
    for (const id of activeState.selection.rangeIds) {
      if (!visibleIds.has(id)) {
        hasInvisible = true;
        break;
      }
    }

    if (hasInvisible) {
      const newState: NavState = {
        ...activeState,
        selection: {
          ...activeState.selection,
          rangeIds: new Set<symbol>(),
          anchorId: undefined,
        },
      };
      setState(newState);
      activeState = newState;
    }
  }

  const setSelectedTodoId = useCallback((id: symbol | undefined) => {
    setState((prev) => {
      const newSelection = {
        cursorId: id,
        anchorId: undefined,
        rangeIds: new Set<symbol>(),
      };

      const newRow = id
        ? indexes.findIndex((e) =>
          e.type === IndexType.todo && e.todo.id === id
        )
        : 0;

      const newOffset = calculateScrollOffset(
        newRow !== -1 ? newRow : 0,
        { min: newRow, max: newRow },
        prev.offsetRow,
        listHeight,
        indexes.length,
      );

      let newLastHash = prev.lastHash;
      if (newRow !== -1 && id) {
        const entry = indexes[newRow];
        if (entry?.type === IndexType.todo) {
          newLastHash = entry.todo.getHash();
        }
      }

      return {
        ...prev,
        selection: newSelection,
        offsetRow: newOffset,
        lastIndex: newRow !== -1 ? newRow : prev.lastIndex,
        lastHash: newLastHash,
      };
    });
  }, [indexes, listHeight]);

  const clearMultiSelect = useCallback(() => {
    setState((prev) => ({
      ...prev,
      selection: {
        ...prev.selection,
        anchorId: undefined,
        rangeIds: new Set<symbol>(),
      },
    }));
  }, []);

  const doNavigate = useCallback((step: number, shift: boolean = false) => {
    setState((prev) => {
      // 1. Calculate new selection
      const todoIndex = indexes.findIndex(
        (entry) =>
          entry.type === IndexType.todo &&
          entry.todo.id === prev.selection.cursorId,
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
      let newId = prev.selection.cursorId;
      if (selectedEntry?.type === IndexType.todo) {
        newId = selectedEntry.todo.id;
      }

      if (newId === undefined) return prev;

      let newAnchor = prev.selection.anchorId;
      const newRange = new Set<symbol>();

      if (shift) {
        if (!newAnchor) {
          newAnchor = prev.selection.cursorId ?? newId;
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

      // 2. Calculate New Scroll Offset directly
      const selectionRangeRows = (() => {
        if (newRange.size === 0) {
          return { min: newSelectedRow, max: newSelectedRow };
        }
        let min = newSelectedRow;
        let max = newSelectedRow;
        // Optimization: we know the range is contiguous between anchor and newIndex
        // but relying on indexes iteration is safer for now
        // For now, let's use the explicit range calculation again to be safe
        indexes.forEach((entry, index) => {
          if (entry.type === IndexType.todo && newRange.has(entry.todo.id)) {
            min = Math.min(min, index);
            max = Math.max(max, index);
          }
        });
        return { min, max };
      })();

      const newOffsetRow = calculateScrollOffset(
        newSelectedRow,
        selectionRangeRows,
        prev.offsetRow,
        listHeight,
        indexes.length,
      );

      // 3. Update tracking metadata
      let newLastHash = prev.lastHash;
      if (selectedEntry?.type === IndexType.todo) {
        newLastHash = selectedEntry.todo.getHash();
      }

      return {
        selection: {
          cursorId: newId,
          anchorId: newAnchor,
          rangeIds: newRange,
        },
        offsetRow: newOffsetRow,
        prevTodos: prev.prevTodos,
        lastIndex: newSelectedRow,
        lastHash: newLastHash,
      };
    });
  }, [indexes, listHeight]);

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
    return todos.find((t) => t.id === activeState.selection.cursorId);
  }, [todos, activeState.selection.cursorId]);

  const useSelectedTodos = useCallback(() => {
    if (activeState.selection.rangeIds.size > 0) {
      return todos.filter((t) => activeState.selection.rangeIds.has(t.id));
    }
    const todo = todos.find((t) => t.id === activeState.selection.cursorId);
    return todo ? [todo] : [];
  }, [todos, activeState.selection.rangeIds, activeState.selection.cursorId]);

  const value = useMemo(
    () => ({
      indexes,
      offsetRow: activeState.offsetRow,
      listHeight,
      navigateUp,
      navigateDown,
      navigatePageUp,
      navigatePageDown,
      navigateHome,
      navigateEnd,
      selectedTodoId: activeState.selection.cursorId,
      setSelectedTodoId,
      selectedTodoIds: activeState.selection.rangeIds,
      clearMultiSelect,
      useSelectedTodo,
      useSelectedTodos,
      showHidden,
      toggleShowHidden,
    }),
    [
      indexes,
      activeState.offsetRow,
      listHeight,
      navigateUp,
      navigateDown,
      navigatePageUp,
      navigatePageDown,
      navigateHome,
      navigateEnd,
      activeState.selection.cursorId,
      setSelectedTodoId,
      activeState.selection.rangeIds,
      clearMultiSelect,
      useSelectedTodo,
      useSelectedTodos,
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
