import { useState } from "react";
import { Key } from "./useInput.ts";

export interface UseListSelectionOptions {
  /** Number of selectable rows; changes when an optional row is appended. */
  itemCount: number;
  /** Row highlighted on first render. */
  initialIndex?: number;
  /**
   * When false, only escape is handled. Useful for multi-step modals whose
   * second step owns enter/arrow keys.
   */
  isActive?: boolean;
  /** Called with the highlighted row on enter or a mouse click. */
  onSelect?: (index: number) => void;
  /** Called on escape. */
  onCancel?: () => void;
}

/**
 * Index state and key handling shared by the selectable-list modals and the
 * todo menu. Rendering stays with each caller so labels, markers, and layout
 * can differ.
 */
export const useListSelection = ({
  itemCount,
  initialIndex = 0,
  isActive = true,
  onSelect,
  onCancel,
}: UseListSelectionOptions) => {
  const [selectedIndex, setSelectedIndexState] = useState(initialIndex);

  const clamp = (index: number) =>
    itemCount <= 0 ? 0 : Math.min(Math.max(index, 0), itemCount - 1);

  const setSelectedIndex = (index: number) => {
    setSelectedIndexState(clamp(index));
  };

  const moveUp = () => {
    setSelectedIndexState((prev) =>
      itemCount <= 0 ? 0 : prev > 0 ? prev - 1 : itemCount - 1,
    );
  };

  const moveDown = () => {
    setSelectedIndexState((prev) =>
      itemCount <= 0 ? 0 : prev < itemCount - 1 ? prev + 1 : 0,
    );
  };

  /** Move the marker and activate the row (mouse click). */
  const selectAt = (index: number) => {
    const next = clamp(index);
    setSelectedIndexState(next);
    onSelect?.(next);
  };

  /** Returns true when the key was consumed. */
  const handleKey = (key: Key): boolean => {
    if (key.escape) {
      onCancel?.();
      return true;
    }

    if (!isActive) return false;

    if (key.upArrow) {
      moveUp();
      return true;
    }

    if (key.downArrow) {
      moveDown();
      return true;
    }

    if (key.return) {
      onSelect?.(selectedIndex);
      return true;
    }

    return false;
  };

  return {
    selectedIndex,
    setSelectedIndex,
    selectAt,
    moveUp,
    moveDown,
    handleKey,
  };
};
