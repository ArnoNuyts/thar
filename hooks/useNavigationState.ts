import { useCallback, useEffect, useMemo, useState } from "react";
import { useWindowSize } from "ink";
import { useSearch } from "../contexts/search-context.tsx";
import { filterHidden, sortByImportance, type Todos } from "../logic/Todos.ts";
import { createIndexes, IndexEntry } from "../logic/indexes.ts";
import {
  areSetsEqual,
  calculateScrollOffset,
  clamp,
  getNavigableRow,
  getSelectionRangeRows,
  type NavState,
  reconcileNavState,
} from "../logic/navigation.ts";
import { IndexType } from "../types/enums.ts";
import { extractSearchTerms } from "../utils/search-utils.ts";

/**
 * Owns navigation selection state, derived indexes, and event handlers.
 * The provider only wires the returned context value to the React tree.
 */
export const useNavigationState = (
  todos: Todos,
  listHeightForTest?: number,
) => {
  const { searchQuery, isSearchFocused } = useSearch();
  const { rows: windowRows } = useWindowSize();

  const [showHidden, setShowHidden] = useState(false);

  const [state, setState] = useState<NavState>({
    selection: {
      cursorId: undefined,
      anchorId: undefined,
      rangeIds: new Set(),
    },
    offsetRow: 0,
    prevTodos: todos,
    prevIndexes: [],
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
    (windowRows - 2 - (searchBarVisible ? 2 : 0));

  const indexes: IndexEntry[] = useMemo(() => {
    let filteredTodos = sortByImportance(todos);

    if (!showHidden) {
      filteredTodos = filterHidden(filteredTodos);
    }

    // Apply search filter if query exists
    if (searchQuery.trim()) {
      const terms = extractSearchTerms(searchQuery);
      filteredTodos = filteredTodos.filter((todo) => {
        const text = todo.text.toLowerCase();
        const contexts = Array.from(todo.contexts).map((c) => c.toLowerCase());
        const projects = Array.from(todo.projects).map((p) => p.toLowerCase());

        return terms.every((term) => {
          const normalized = term.startsWith("@") || term.startsWith("+")
            ? term.slice(1)
            : term;

          return (
            text.includes(term) ||
            contexts.some((c) => c.includes(normalized)) ||
            projects.some((p) => p.includes(normalized))
          );
        });
      });
    }
    return createIndexes(filteredTodos);
  }, [todos, searchQuery, showHidden]);

  // Derived state is reconciled purely during render, then committed in an
  // effect. The current render already sees the reconciled result, and the
  // effect persists the metadata (previous todos/indexes, last hash/index) so
  // future renders and handlers stay in sync.
  const activeState = useMemo(
    () => reconcileNavState(state, todos, indexes, listHeight),
    [state, todos, indexes, listHeight],
  );

  useEffect(() => {
    if (activeState === state) return;

    // Only commit if state has not changed since this reconciliation, so a
    // newer update from an event handler is never clobbered.
    setState((prev) => prev === state ? activeState : prev);
  }, [activeState, state]);

  const setSelectedTodoId = useCallback(
    (id: symbol | undefined, shift = false) => {
      setState((prev) => {
        if (id !== undefined && shift) {
          const targetRow = indexes.findIndex((e) =>
            e.type === IndexType.todo && e.todo.id === id
          );
          if (targetRow === -1) return prev;

          let newAnchor = prev.selection.anchorId;
          const newRange = new Set<symbol>();
          if (!newAnchor) {
            newAnchor = prev.selection.cursorId ?? id;
          }

          const anchorIndex = indexes.findIndex((e) =>
            e.type === IndexType.todo && e.todo.id === newAnchor
          );
          if (anchorIndex !== -1) {
            const start = Math.min(anchorIndex, targetRow);
            const end = Math.max(anchorIndex, targetRow);
            for (let i = start; i <= end; i++) {
              const entry = indexes[i];
              if (entry.type === IndexType.todo) {
                newRange.add(entry.todo.id);
              }
            }
          }

          const selectionRangeRows = getSelectionRangeRows(
            indexes,
            newRange,
            targetRow,
          );

          const newOffset = calculateScrollOffset(
            targetRow,
            selectionRangeRows,
            prev.offsetRow,
            listHeight,
            indexes.length,
          );
          const targetEntry = indexes[targetRow];
          const newLastHash = targetEntry?.type === IndexType.todo
            ? targetEntry.todo.getHash()
            : prev.lastHash;

          return {
            ...prev,
            selection: {
              cursorId: id,
              anchorId: newAnchor,
              rangeIds: newRange,
            },
            offsetRow: newOffset,
            prevIndexes: indexes,
            lastIndex: targetRow,
            lastHash: newLastHash,
          };
        }

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
          prevIndexes: indexes,
          lastIndex: newRow !== -1 ? newRow : prev.lastIndex,
          lastHash: newLastHash,
        };
      });
    },
    [indexes, listHeight],
  );

  const clearMultiSelect = useCallback(() => {
    setState((prev) => ({
      ...prev,
      selection: {
        ...prev.selection,
        anchorId: undefined,
        rangeIds: new Set<symbol>(),
      },
      prevIndexes: indexes,
    }));
  }, [indexes]);

  const applySelectionChange = useCallback(
    (
      prev: NavState,
      newSelectedRow: number,
      shift: boolean,
    ): NavState => {
      if (newSelectedRow < 0 || newSelectedRow >= indexes.length) {
        return prev;
      }

      const selectedEntry = indexes[newSelectedRow];
      if (selectedEntry?.type !== IndexType.todo) return prev;

      const newId = selectedEntry.todo.id;
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

      const selectionRangeRows = getSelectionRangeRows(
        indexes,
        newRange,
        newSelectedRow,
      );

      const newOffsetRow = calculateScrollOffset(
        newSelectedRow,
        selectionRangeRows,
        prev.offsetRow,
        listHeight,
        indexes.length,
      );

      const newLastHash = selectedEntry.todo.getHash();

      const selectionUnchanged = prev.selection.cursorId === newId &&
        prev.selection.anchorId === newAnchor &&
        areSetsEqual(prev.selection.rangeIds, newRange);
      const metadataUnchanged = prev.offsetRow === newOffsetRow &&
        prev.lastIndex === newSelectedRow &&
        prev.lastHash === newLastHash &&
        prev.prevIndexes === indexes;

      if (selectionUnchanged && metadataUnchanged) {
        return prev;
      }

      return {
        selection: {
          cursorId: newId,
          anchorId: newAnchor,
          rangeIds: newRange,
        },
        offsetRow: newOffsetRow,
        prevTodos: prev.prevTodos,
        prevIndexes: indexes,
        lastIndex: newSelectedRow,
        lastHash: newLastHash,
      };
    },
    [indexes, listHeight],
  );

  const doNavigate = useCallback((step: number, shift: boolean = false) => {
    setState((prev) => {
      const todoIndex = indexes.findIndex(
        (entry) =>
          entry.type === IndexType.todo &&
          entry.todo.id === prev.selection.cursorId,
      );
      const currentRow = todoIndex === -1 ? 0 : todoIndex;
      const newSelectedRow = getNavigableRow(indexes, currentRow, step);

      return applySelectionChange(prev, newSelectedRow, shift);
    });
  }, [applySelectionChange, indexes]);

  const doNavigateContext = useCallback(
    (direction: -1 | 1, shift: boolean = false) => {
      setState((prev) => {
        if (indexes.length === 0) return prev;

        const todoIndex = indexes.findIndex(
          (entry) =>
            entry.type === IndexType.todo &&
            entry.todo.id === prev.selection.cursorId,
        );
        const currentRow = todoIndex === -1 ? 0 : todoIndex;

        let currentHeaderIndex = -1;
        for (let i = currentRow; i >= 0; i--) {
          if (indexes[i]?.type === IndexType.context) {
            currentHeaderIndex = i;
            break;
          }
        }

        if (currentHeaderIndex === -1) return prev;

        let targetHeaderIndex = -1;
        if (direction === 1) {
          for (let i = currentHeaderIndex + 1; i < indexes.length; i++) {
            if (indexes[i]?.type === IndexType.context) {
              targetHeaderIndex = i;
              break;
            }
          }
        } else {
          for (let i = currentHeaderIndex - 1; i >= 0; i--) {
            if (indexes[i]?.type === IndexType.context) {
              targetHeaderIndex = i;
              break;
            }
          }
        }

        if (targetHeaderIndex === -1) return prev;

        let targetRow = -1;
        for (
          let i = targetHeaderIndex + 1;
          i < indexes.length;
          i++
        ) {
          const entry = indexes[i];
          if (entry.type === IndexType.todo) {
            targetRow = i;
            break;
          }
          if (entry.type === IndexType.context) {
            break;
          }
        }

        if (targetRow === -1) return prev;

        return applySelectionChange(prev, targetRow, shift);
      });
    },
    [applySelectionChange, indexes],
  );

  const navigateUp = useCallback((shift?: boolean) => doNavigate(-1, shift), [
    doNavigate,
  ]);
  const navigateDown = useCallback((shift?: boolean) => doNavigate(1, shift), [
    doNavigate,
  ]);
  const scrollViewportUp = useCallback(() => {
    setState((prev) => ({
      ...prev,
      offsetRow: clamp(
        prev.offsetRow - 1,
        0,
        Math.max(0, indexes.length - listHeight),
      ),
      prevIndexes: indexes,
    }));
  }, [indexes, listHeight]);
  const scrollViewportDown = useCallback(() => {
    setState((prev) => ({
      ...prev,
      offsetRow: clamp(
        prev.offsetRow + 1,
        0,
        Math.max(0, indexes.length - listHeight),
      ),
      prevIndexes: indexes,
    }));
  }, [indexes, listHeight]);
  const navigateContextUp = useCallback(
    (shift?: boolean) => doNavigateContext(-1, shift),
    [doNavigateContext],
  );
  const navigateContextDown = useCallback(
    (shift?: boolean) => doNavigateContext(1, shift),
    [doNavigateContext],
  );
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

  const getSelectedTodo = useCallback(() => {
    return todos.find((t) => t.id === activeState.selection.cursorId);
  }, [todos, activeState.selection.cursorId]);

  const getSelectedTodos = useCallback(() => {
    if (activeState.selection.rangeIds.size > 0) {
      return todos.filter((t) => activeState.selection.rangeIds.has(t.id));
    }
    const todo = todos.find((t) => t.id === activeState.selection.cursorId);
    return todo ? [todo] : [];
  }, [todos, activeState.selection.rangeIds, activeState.selection.cursorId]);

  const selectedTodo = todos.find((t) =>
    t.id === activeState.selection.cursorId
  );

  const value = useMemo(
    () => ({
      indexes,
      offsetRow: activeState.offsetRow,
      listHeight,
      scrollViewportUp,
      scrollViewportDown,
      navigateUp,
      navigateDown,
      navigateContextUp,
      navigateContextDown,
      navigatePageUp,
      navigatePageDown,
      navigateHome,
      navigateEnd,
      selectedTodoId: activeState.selection.cursorId,
      setSelectedTodoId,
      selectedTodoIds: activeState.selection.rangeIds,
      clearMultiSelect,
      getSelectedTodo,
      getSelectedTodos,
      showHidden,
      toggleShowHidden,
    }),
    [
      indexes,
      activeState.offsetRow,
      listHeight,
      scrollViewportUp,
      scrollViewportDown,
      navigateUp,
      navigateDown,
      navigateContextUp,
      navigateContextDown,
      navigatePageUp,
      navigatePageDown,
      navigateHome,
      navigateEnd,
      activeState.selection.cursorId,
      setSelectedTodoId,
      activeState.selection.rangeIds,
      clearMultiSelect,
      getSelectedTodo,
      getSelectedTodos,
      showHidden,
      toggleShowHidden,
    ],
  );

  return { value, selectedTodo };
};
