import { useEffect, useState } from "react";
import { Text } from "ink";
import chalk from "chalk";
import { useInput } from "../hooks/useInput.ts";

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
  const [internalCursorOffset, setInternalCursorOffset] = useState(
    (originalValue || "").length,
  );

  // Use controlled cursor offset if provided, otherwise use internal state
  const cursorOffset = controlledCursorOffset ?? internalCursorOffset;

  // Listen to raw stdin to capture actual key sequences
  // DELETED: Raw data listener is now handled in custom useInput

  // Sync cursor when controlled offset changes
  useEffect(() => {
    if (controlledCursorOffset !== undefined) {
      setInternalCursorOffset(controlledCursorOffset);
    }
  }, [controlledCursorOffset]);

  // Adjust cursor if it goes beyond value length
  useEffect(() => {
    if (!focus || !showCursor) {
      return;
    }

    const newValue = originalValue || "";

    if (internalCursorOffset > newValue.length) {
      setInternalCursorOffset(newValue.length);
      onCursorChange?.(newValue.length, newValue);
    }
  }, [originalValue, focus, showCursor, internalCursorOffset, onCursorChange]);

  const value = originalValue;
  let renderedValue = value;
  let renderedPlaceholder = placeholder ? chalk.grey(placeholder) : undefined;

  // Render cursor
  if (showCursor && focus) {
    renderedPlaceholder = placeholder.length > 0
      ? chalk.inverse(placeholder[0]) + chalk.grey(placeholder.slice(1))
      : chalk.inverse(" ");

    renderedValue = value.length > 0 ? "" : chalk.inverse(" ");

    let i = 0;
    for (const char of value) {
      renderedValue += i === cursorOffset ? chalk.inverse(char) : char;
      i++;
    }

    if (value.length > 0 && cursorOffset === value.length) {
      renderedValue += chalk.inverse(" ");
    }
  }

  useInput(
    (input, key) => {
      let nextCursorOffset = cursorOffset;
      let nextValue = originalValue;

      switch (true) {
        case key.upArrow:
        case key.downArrow:
        case key.tab:
        case key.ctrl && input === "c":
          return;

        case key.return:
          onSubmit?.(originalValue);
          return;

        case key.escape:
          // Don't handle escape here, let parent handle it
          return;

        case key.leftArrow:
          if (showCursor) {
            nextCursorOffset = Math.max(0, cursorOffset - 1);
          }
          break;

        case key.rightArrow:
          if (showCursor) {
            nextCursorOffset = Math.min(originalValue.length, cursorOffset + 1);
          }
          break;

        case key.home:
          if (showCursor) {
            nextCursorOffset = 0;
          }
          break;

        case key.end:
          if (showCursor) {
            nextCursorOffset = originalValue.length;
          }
          break;

        case key.backspace:
          if (cursorOffset > 0) {
            // Backspace: delete character before cursor
            nextValue = originalValue.slice(0, cursorOffset - 1) +
              originalValue.slice(cursorOffset, originalValue.length);
            nextCursorOffset = cursorOffset - 1;
          }
          break;

        case key.delete:
          if (cursorOffset < originalValue.length) {
            // Delete: delete character at cursor
            nextValue = originalValue.slice(0, cursorOffset) +
              originalValue.slice(cursorOffset + 1, originalValue.length);
            nextCursorOffset = cursorOffset;
          }
          break;

        default:
          if (input.length > 0) {
            nextValue = originalValue.slice(0, cursorOffset) +
              input +
              originalValue.slice(cursorOffset, originalValue.length);
            nextCursorOffset = cursorOffset + input.length;
          } else {
            // No relevant key or text input, return early
            return;
          }
          break;
      }

      // Bounds check
      if (nextCursorOffset < 0) {
        nextCursorOffset = 0;
      }
      if (nextCursorOffset > nextValue.length) {
        nextCursorOffset = nextValue.length;
      }

      setInternalCursorOffset(nextCursorOffset);
      onCursorChange?.(nextCursorOffset, nextValue);

      if (nextValue !== originalValue) {
        onChange(nextValue);
      }
    },
    { isActive: focus },
  );

  return (
    <Text>
      {placeholder
        ? value.length > 0 ? renderedValue : renderedPlaceholder
        : renderedValue}
    </Text>
  );
}
