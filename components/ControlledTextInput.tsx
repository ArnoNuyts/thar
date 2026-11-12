import { useEffect, useRef, useState } from "react";
import { Text } from "ink";
import chalk from "chalk";
import { type Key, useInput } from "../hooks/useInput.ts";
import { sanitizeForDisplay } from "../logic/display-safety.ts";

interface ControlledTextInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  onCursorChange?: (offset: number, newValue: string) => void;
  placeholder?: string;
  focus?: boolean;
  showCursor?: boolean;
  cursorOffset?: number; // New: Allow parent to control cursor position
}

/** Move to the start of the word before `offset`, skipping leading spaces. */
function moveWordLeft(value: string, offset: number): number {
  let newOffset = offset;

  while (newOffset > 0 && value[newOffset - 1] === " ") {
    newOffset--;
  }
  while (newOffset > 0 && value[newOffset - 1] !== " ") {
    newOffset--;
  }

  return newOffset;
}

/**
 * Move right over the word at `offset`, then past any following spaces.
 *
 * With `spaceFirst`, spaces at `offset` are skipped before the next word is
 * consumed, and trailing spaces after that word are left in place. This is the
 * behavior Ctrl+Delete needs when the cursor starts on whitespace.
 */
function moveWordRight(
  value: string,
  offset: number,
  spaceFirst = false,
): number {
  let newOffset = offset;

  if (spaceFirst) {
    while (newOffset < value.length && value[newOffset] === " ") {
      newOffset++;
    }
  }
  while (newOffset < value.length && value[newOffset] !== " ") {
    newOffset++;
  }
  if (!spaceFirst) {
    while (newOffset < value.length && value[newOffset] === " ") {
      newOffset++;
    }
  }

  return newOffset;
}

interface EditResult {
  value: string;
  cursorOffset: number;
}

/** Apply cursor movement keys, or return null for other keys. */
function moveCursor(value: string, offset: number, key: Key): number | null {
  if (key.leftArrow) {
    return key.ctrl ? moveWordLeft(value, offset) : Math.max(0, offset - 1);
  }
  if (key.rightArrow) {
    return key.ctrl
      ? moveWordRight(value, offset)
      : Math.min(value.length, offset + 1);
  }
  if (key.home) {
    return 0;
  }
  if (key.end) {
    return value.length;
  }

  return null;
}

/** Apply Backspace/Delete, or return null for other keys. */
function deleteAtCursor(
  value: string,
  offset: number,
  key: Key,
): EditResult | null {
  if (key.backspace) {
    if (offset === 0) {
      return { value, cursorOffset: offset };
    }

    if (key.ctrl || key.meta) {
      const start = moveWordLeft(value, offset);
      return {
        value: value.slice(0, start) + value.slice(offset),
        cursorOffset: start,
      };
    }

    return {
      value: value.slice(0, offset - 1) + value.slice(offset),
      cursorOffset: offset - 1,
    };
  }

  if (key.delete) {
    if (offset >= value.length) {
      return { value, cursorOffset: offset };
    }

    if (key.ctrl || key.meta) {
      const end = moveWordRight(value, offset, value[offset] === " ");
      return {
        value: value.slice(0, offset) + value.slice(end),
        cursorOffset: offset,
      };
    }

    return {
      value: value.slice(0, offset) + value.slice(offset + 1),
      cursorOffset: offset,
    };
  }

  return null;
}

/** Apply typed or pasted text, or return null when there is nothing to insert. */
function insertAtCursor(
  value: string,
  offset: number,
  input: string,
): EditResult | null {
  // Filter out newlines (e.g. from pasted text).
  let text = input.replace(/[\r\n]+/g, "");
  if (text.length === 0) {
    return null;
  }

  // Multi-character input is treated as a paste; trim surrounding spaces.
  if (text.length > 1) {
    text = text.trim();
  }

  return {
    value: value.slice(0, offset) + text + value.slice(offset),
    cursorOffset: offset + text.length,
  };
}

interface RenderedText {
  renderedValue: string;
  renderedPlaceholder: string | undefined;
}

/** Render the value with an inverse-video cursor at `cursorOffset`. */
function renderText(
  value: string,
  cursorOffset: number,
  placeholder: string,
  showCursor: boolean,
  focus: boolean,
): RenderedText {
  // The stored value and cursor offsets stay over the raw text; only the
  // rendered copy escapes control characters. Sanitizing one raw character at
  // a time keeps the cursor offset meaningful even when one character expands
  // to a six-character `\uXXXX` escape.
  const safePlaceholder = sanitizeForDisplay(placeholder);

  if (!showCursor || !focus) {
    return {
      renderedValue: sanitizeForDisplay(value),
      renderedPlaceholder: placeholder
        ? chalk.grey(safePlaceholder)
        : undefined,
    };
  }

  const renderedPlaceholder =
    safePlaceholder.length > 0
      ? chalk.inverse(safePlaceholder[0]) + chalk.grey(safePlaceholder.slice(1))
      : chalk.inverse(" ");

  let renderedValue = value.length > 0 ? "" : chalk.inverse(" ");

  let offset = 0;
  for (const char of value) {
    const safeChar = sanitizeForDisplay(char);
    const charEnd = offset + char.length;
    const isCursor = cursorOffset >= offset && cursorOffset < charEnd;
    renderedValue += isCursor ? chalk.inverse(safeChar) : safeChar;
    offset = charEnd;
  }

  if (value.length > 0 && cursorOffset === value.length) {
    renderedValue += chalk.inverse(" ");
  }

  return { renderedValue, renderedPlaceholder };
}

/** Resolve a key press into the next value and cursor offset. */
function resolveEdit(
  value: string,
  offset: number,
  input: string,
  key: Key,
  showCursor: boolean,
): EditResult | null {
  if (key.leftArrow || key.rightArrow || key.home || key.end) {
    const nextOffset = showCursor ? moveCursor(value, offset, key) : offset;
    return { value, cursorOffset: nextOffset ?? offset };
  }

  if (key.backspace || key.delete) {
    return deleteAtCursor(value, offset, key);
  }

  if (input.length > 0 && !key.ctrl && !key.meta) {
    return insertAtCursor(value, offset, input);
  }

  return null;
}

export function ControlledTextInput({
  value: originalValue,
  placeholder = "",
  focus = true,
  showCursor = true,
  cursorOffset: controlledCursorOffset,
  onChange,
  onSubmit,
  onCursorChange,
}: ControlledTextInputProps) {
  const value = originalValue;
  const [internalCursorOffset, setInternalCursorOffset] = useState(
    value.length,
  );

  // A controlled offset always wins. In uncontrolled mode, clamp the stored
  // cursor while rendering so a shorter value can never leave it out of range.
  const cursorOffset =
    controlledCursorOffset ?? Math.min(internalCursorOffset, value.length);

  // Track latest values in REFs to avoid stale closures in useInput
  const valueRef = useRef(value);
  const cursorOffsetRef = useRef(cursorOffset);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  useEffect(() => {
    cursorOffsetRef.current = cursorOffset;
  }, [cursorOffset]);

  const { renderedValue, renderedPlaceholder } = renderText(
    value,
    cursorOffset,
    placeholder,
    showCursor,
    focus,
  );

  useInput(
    (input, key) => {
      // Use REFs for latest state
      const currentValue = valueRef.current;
      const currentCursorOffset = cursorOffsetRef.current;

      if (
        key.upArrow ||
        key.downArrow ||
        key.tab ||
        (key.ctrl && input === "c")
      ) {
        return;
      }

      if (key.return) {
        onSubmit?.(currentValue);
        return;
      }

      if (key.escape) {
        // Don't handle escape here, let parent handle it
        return;
      }

      const edit = resolveEdit(
        currentValue,
        currentCursorOffset,
        input,
        key,
        showCursor,
      );
      if (!edit) return;

      const nextCursorOffset = Math.max(
        0,
        Math.min(edit.cursorOffset, edit.value.length),
      );

      setInternalCursorOffset(nextCursorOffset);
      cursorOffsetRef.current = nextCursorOffset; // Update REF immediately for next potential sync event

      onCursorChange?.(nextCursorOffset, edit.value);

      if (edit.value !== currentValue) {
        valueRef.current = edit.value; // Update REF immediately!
        onChange(edit.value);
      }
    },
    { isActive: focus },
  );

  const display =
    placeholder && value.length === 0 ? renderedPlaceholder : renderedValue;

  return <Text>{display}</Text>;
}
