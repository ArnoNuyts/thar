import type { Todos } from "./Todos.ts";
import { IndexEntry } from "./indexes.ts";
import { Todo } from "./todo.ts";
import { IndexType } from "../types/enums.ts";

export const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

/**
 * Row reached by moving `step` rows from `currentRow`, skipping context
 * headers. When the move crosses a list boundary, fall back to the first or
 * last todo so the selection never lands on a header.
 */
export const getNavigableRow = (
  indexes: IndexEntry[],
  currentRow: number,
  step: number,
): number => {
  const firstTodoIndex = indexes.findIndex(
    (entry) => entry.type === IndexType.todo,
  );
  const lastTodoIndex = indexes.findLastIndex(
    (entry) => entry.type === IndexType.todo,
  );
  const direction = step > 0 ? 1 : -1;
  let newSelectedRow = clamp(currentRow + step, 0, indexes.length - 1);

  // Skip context headers
  while (indexes[newSelectedRow]?.type === IndexType.context) {
    newSelectedRow += direction;
    if (newSelectedRow < 0 || newSelectedRow >= indexes.length) {
      if (direction === -1) {
        newSelectedRow = firstTodoIndex !== -1 ? firstTodoIndex : currentRow;
      } else {
        newSelectedRow = lastTodoIndex !== -1 ? lastTodoIndex : currentRow;
      }
      break;
    }
  }

  return newSelectedRow;
};

export const areSetsEqual = (a: Set<symbol>, b: Set<symbol>) => {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
};

export interface SelectionState {
  cursorId: symbol | undefined;
  anchorId: symbol | undefined;
  rangeIds: Set<symbol>;
}

export interface NavState {
  selection: SelectionState;
  offsetRow: number;
  // Tracking for prop sync
  prevTodos: Todos;
  prevIndexes: IndexEntry[];
  lastHash: string | undefined;
  lastIndex: number;
}

export interface SelectionRangeRows {
  min: number;
  max: number;
}

/**
 * Calculate the first and last index rows covered by a selection.
 * The cursor row is always included; range IDs that are not visible in the
 * current indexes are ignored.
 */
export const getSelectionRangeRows = (
  indexes: IndexEntry[],
  rangeIds: ReadonlySet<symbol>,
  fallbackRow: number,
): SelectionRangeRows => {
  let min = fallbackRow;
  let max = fallbackRow;

  if (rangeIds.size === 0) return { min, max };

  indexes.forEach((entry, index) => {
    if (entry.type === IndexType.todo && rangeIds.has(entry.todo.id)) {
      min = Math.min(min, index);
      max = Math.max(max, index);
    }
  });

  return { min, max };
};

/**
 * Guesstimate the best selection when todos change (add/modify).
 * Returns the ID of the todo that should be selected, or undefined to keep current.
 */
export function guesstimateSelection(
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
    // Keep an explicit selection of a newly added todo (e.g. pasting several
    // todos selects the last one, not the first).
    if (
      currentCursorId !== undefined &&
      added.some((todo) => todo.id === currentCursorId)
    ) {
      return undefined;
    }

    const firstVisibleAdded = indexes.find(
      (entry) =>
        entry.type === IndexType.todo &&
        added.some((a) => a.id === entry.todo.id),
    );
    if (firstVisibleAdded?.type === IndexType.todo) {
      return firstVisibleAdded.todo.id;
    }
  }

  // Priority 2: Select first visible modified todo (if cursor is no longer valid)
  const prevById = new Map(prevTodos.map((todo) => [todo.id, todo]));
  const modified = todos.filter((t) => {
    const oldTodo = prevById.get(t.id);
    return oldTodo && oldTodo.getHash() !== t.getHash();
  });

  if (modified.length > 0) {
    // If cursor is among modified and still visible, keep it
    const isCursorValid =
      currentCursorId &&
      modified.some((m) => m.id === currentCursorId) &&
      indexes.some(
        (e) => e.type === IndexType.todo && e.todo.id === currentCursorId,
      );

    if (isCursorValid) return undefined; // Keep current

    const firstVisibleModified = indexes.find(
      (entry) =>
        entry.type === IndexType.todo &&
        modified.some((m) => m.id === entry.todo.id),
    );
    if (firstVisibleModified?.type === IndexType.todo) {
      return firstVisibleModified.todo.id;
    }
  }

  return undefined; // No change needed
}

/**
 * Find the row for a todo ID. `lastIndex` is almost always the cursor row, so
 * checking it first keeps navigation O(1) instead of scanning the whole index
 * on every keypress; the scan only happens when the index changed underneath.
 */
export const findTodoRow = (
  indexes: IndexEntry[],
  id: symbol | undefined,
  lastIndex = 0,
): number => {
  if (id === undefined) return -1;

  const candidate = indexes[lastIndex];
  if (candidate?.type === IndexType.todo && candidate.todo.id === id) {
    return lastIndex;
  }

  return indexes.findIndex(
    (entry) => entry.type === IndexType.todo && entry.todo.id === id,
  );
};

/**
 * Validate the current selection. If invalid, find a fallback.
 * Returns the validated/fallback cursor ID.
 */
export function validateSelection(
  cursorId: symbol | undefined,
  indexes: IndexEntry[],
  lastHash: string | undefined,
  lastIndex: number,
): symbol | undefined {
  if (indexes.length === 0) return undefined;

  // Fast path: the cursor row is stable during navigation, so verify it by ID
  // before scanning. findTodoRow still falls back to a full scan when the
  // index changed underneath.
  if (findTodoRow(indexes, cursorId, lastIndex) !== -1) {
    return cursorId;
  }

  // Fallback 1: Match by hash (handle file reload)
  if (lastHash) {
    const hashMatch = indexes.find(
      (entry) =>
        entry.type === IndexType.todo && entry.todo.getHash() === lastHash,
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

  return undefined;
}

/**
 * Calculate the scroll offset to keep selection visible.
 */
export function calculateScrollOffset(
  selectedRow: number,
  selectionRange: { min: number; max: number },
  currentOffset: number,
  listHeight: number,
  indexesLength: number,
): number {
  const scrollPadding = 1;
  const { min: minRow, max: maxRow } = selectionRange;

  // Priority 1 & 2: Calculate bounds that keep at least the cursor visible,
  // and as much of the range as possible.
  // For the cursor to be visible: offset <= selectedRow AND offset > selectedRow - listHeight
  const cursorMin = Math.max(0, selectedRow - listHeight + 1);
  const cursorMax = Math.min(
    selectedRow,
    Math.max(0, indexesLength - listHeight),
  );

  const rangeHeight = maxRow - minRow + 1;
  if (rangeHeight <= listHeight) {
    // Range fits! Allowed offsets to show ENTIRE range:
    // offset <= minRow AND offset >= maxRow - listHeight + 1
    const rangeMinAllowed = Math.max(0, maxRow - listHeight + 1);
    const rangeMaxAllowed = Math.min(
      minRow,
      Math.max(0, indexesLength - listHeight),
    );

    // We want to stay as close to currentOffset as possible,
    // but applying padding for the cursor where it doesn't hide the range.
    let target = currentOffset;

    // Apply padding logic
    if (selectedRow < target + scrollPadding) {
      target = selectedRow - scrollPadding;
    } else if (selectedRow >= target + listHeight - scrollPadding) {
      target = selectedRow - listHeight + 1 + scrollPadding;
    }

    // Clamp to the range-visibility window
    return clamp(target, rangeMinAllowed, rangeMaxAllowed);
  } else {
    // Range DOES NOT fit. Just keep cursor visible with padding.
    let target = currentOffset;
    if (selectedRow < target + scrollPadding) {
      target = selectedRow - scrollPadding;
    } else if (selectedRow >= target + listHeight - scrollPadding) {
      target = selectedRow - listHeight + 1 + scrollPadding;
    }

    // Still must keep cursor visible (ignore padding if it pushes cursor out,
    // though clamp to cursorMin/Max handles that).
    return clamp(target, cursorMin, cursorMax);
  }
}

/**
 * Reconcile navigation metadata with the current todos and indexes.
 * Returns the same state object when nothing needs to change, so callers can
 * commit the result without triggering a render loop.
 */
export function reconcileNavState(
  state: NavState,
  todos: Todos,
  indexes: IndexEntry[],
  listHeight: number,
): NavState {
  let next = state;

  // 1. Prop Sync (Guesstimate on content change)
  if (todos !== next.prevTodos) {
    // Step 1: Guesstimate
    const guesstimatedId = guesstimateSelection(
      todos,
      next.prevTodos,
      indexes,
      next.selection.cursorId,
    );

    // Step 2: Validate
    const cursorToValidate = guesstimatedId ?? next.selection.cursorId;
    const validatedCursorId = validateSelection(
      cursorToValidate,
      indexes,
      next.lastHash,
      next.lastIndex,
    );

    // Step 3: Scroll & Metadata
    const selectedRow = validatedCursorId
      ? indexes.findIndex(
          (e) => e.type === IndexType.todo && e.todo.id === validatedCursorId,
        )
      : 0;

    const selectionRangeRows = getSelectionRangeRows(
      indexes,
      next.selection.rangeIds,
      selectedRow,
    );

    const newOffsetRow = calculateScrollOffset(
      selectedRow,
      selectionRangeRows,
      next.offsetRow,
      listHeight,
      indexes.length,
    );

    let newLastHash = next.lastHash;
    if (selectedRow !== -1 && validatedCursorId) {
      const entry = indexes[selectedRow];
      if (entry?.type === IndexType.todo) {
        newLastHash = entry.todo.getHash();
      }
    }

    // Prepare new selection state
    let newSelection = next.selection;
    if (
      validatedCursorId !== next.selection.cursorId ||
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
          ...next.selection,
          cursorId: validatedCursorId,
        };
      }
    }

    next = {
      selection: newSelection,
      offsetRow: newOffsetRow,
      prevTodos: todos,
      prevIndexes: indexes,
      lastIndex: selectedRow !== -1 ? selectedRow : next.lastIndex,
      lastHash: newLastHash,
    };
  }

  // 2. Validation / Auto-Correction
  // Ensures selection is valid (exists in indexes) after Init, Filter change, or Guesstimate.
  const currentCursor = next.selection.cursorId;
  const validatedCursor = validateSelection(
    currentCursor,
    indexes,
    next.lastHash,
    next.lastIndex,
  );

  const indexesChanged = indexes !== next.prevIndexes;

  if (validatedCursor !== currentCursor || indexesChanged) {
    const selectedRow = validatedCursor
      ? indexes.findIndex(
          (e) => e.type === IndexType.todo && e.todo.id === validatedCursor,
        )
      : 0;

    const selectionRangeRows = getSelectionRangeRows(
      indexes,
      next.selection.rangeIds,
      selectedRow,
    );

    const newOffsetRow = calculateScrollOffset(
      selectedRow,
      selectionRangeRows,
      next.offsetRow,
      listHeight,
      indexes.length,
    );

    let newLastHash = next.lastHash;
    if (selectedRow !== -1 && validatedCursor) {
      const entry = indexes[selectedRow];
      if (entry?.type === IndexType.todo) {
        newLastHash = entry.todo.getHash();
      }
    }

    next = {
      ...next,
      selection: {
        ...next.selection,
        cursorId: validatedCursor,
      },
      offsetRow: newOffsetRow,
      prevIndexes: indexes,
      lastIndex: selectedRow !== -1 ? selectedRow : next.lastIndex,
      lastHash: newLastHash,
    };
  }

  // 3. Clear multi-select if any selected todo is filtered out
  if (next.selection.rangeIds.size > 0) {
    const visibleIds = new Set<symbol>();
    for (const entry of indexes) {
      if (entry.type === IndexType.todo) {
        visibleIds.add(entry.todo.id);
      }
    }

    for (const id of next.selection.rangeIds) {
      if (!visibleIds.has(id)) {
        next = {
          ...next,
          selection: {
            ...next.selection,
            rangeIds: new Set<symbol>(),
            anchorId: undefined,
          },
        };
        break;
      }
    }
  }

  return next;
}
