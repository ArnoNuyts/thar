import { IndexEntry } from "./indexes.ts";
import { IndexType } from "../types/enums.ts";

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
