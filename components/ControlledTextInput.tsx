import { useEffect, useRef, useState } from "react";
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

  // Track latest values in REFs to avoid stale closures in useInput
  const valueRef = useRef(originalValue);
  const cursorOffsetRef = useRef(cursorOffset);

  useEffect(() => {
    valueRef.current = originalValue;
  }, [originalValue]);

  useEffect(() => {
    cursorOffsetRef.current = cursorOffset;
  }, [cursorOffset]);

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
      // Use REFs for latest state
      const currentOriginalValue = valueRef.current;
      const currentCursorOffset = cursorOffsetRef.current;

      let nextCursorOffset = currentCursorOffset;
      let nextValue = currentOriginalValue;

      switch (true) {
        case key.upArrow:
        case key.downArrow:
        case key.tab:
        case key.ctrl && input === "c":
          return;

        case key.return:
          onSubmit?.(currentOriginalValue);
          return;

        case key.escape:
          // Don't handle escape here, let parent handle it
          return;

        case key.leftArrow:
          if (showCursor) {
            if (key.ctrl) {
              let newPos = currentCursorOffset;
              // Skip preceding whitespace
              while (newPos > 0 && currentOriginalValue[newPos - 1] === " ") {
                newPos--;
              }
              // Skip preceding non-whitespace
              while (newPos > 0 && currentOriginalValue[newPos - 1] !== " ") {
                newPos--;
              }
              nextCursorOffset = newPos;
            } else {
              nextCursorOffset = Math.max(0, currentCursorOffset - 1);
            }
          }
          break;

        case key.rightArrow:
          if (showCursor) {
            if (key.ctrl) {
              let newPos = currentCursorOffset;
              // Skip current non-whitespace
              while (
                newPos < currentOriginalValue.length &&
                currentOriginalValue[newPos] !== " "
              ) {
                newPos++;
              }
              // Skip following whitespace
              while (
                newPos < currentOriginalValue.length &&
                currentOriginalValue[newPos] === " "
              ) {
                newPos++;
              }
              nextCursorOffset = newPos;
            } else {
              nextCursorOffset = Math.min(
                currentOriginalValue.length,
                currentCursorOffset + 1,
              );
            }
          }
          break;

        case key.home:
          if (showCursor) {
            nextCursorOffset = 0;
          }
          break;

        case key.end:
          if (showCursor) {
            nextCursorOffset = currentOriginalValue.length;
          }
          break;

        case key.backspace:
          if (currentCursorOffset > 0) {
            if (key.ctrl || key.meta) {
              // Ctrl+Backspace: delete word before cursor
              let newPos = currentCursorOffset;
              // Skip preceding whitespace
              while (newPos > 0 && currentOriginalValue[newPos - 1] === " ") {
                newPos--;
              }
              // Skip preceding non-whitespace
              while (newPos > 0 && currentOriginalValue[newPos - 1] !== " ") {
                newPos--;
              }

              nextValue = currentOriginalValue.slice(0, newPos) +
                currentOriginalValue.slice(
                  currentCursorOffset,
                  currentOriginalValue.length,
                );
              nextCursorOffset = newPos;
            } else {
              // Backspace: delete character before cursor
              nextValue =
                currentOriginalValue.slice(0, currentCursorOffset - 1) +
                currentOriginalValue.slice(
                  currentCursorOffset,
                  currentOriginalValue.length,
                );
              nextCursorOffset = currentCursorOffset - 1;
            }
          }
          break;

        case key.delete:
          if (currentCursorOffset < currentOriginalValue.length) {
            if (key.ctrl || key.meta) {
              // Ctrl+Delete: delete word after cursor
              let newPos = currentCursorOffset;

              const startOnSpace =
                currentOriginalValue[currentCursorOffset] === " ";

              if (startOnSpace) {
                // Skip current whitespace
                while (
                  newPos < currentOriginalValue.length &&
                  currentOriginalValue[newPos] === " "
                ) {
                  newPos++;
                }
                // Skip following word
                while (
                  newPos < currentOriginalValue.length &&
                  currentOriginalValue[newPos] !== " "
                ) {
                  newPos++;
                }
              } else {
                // Skip current word
                while (
                  newPos < currentOriginalValue.length &&
                  currentOriginalValue[newPos] !== " "
                ) {
                  newPos++;
                }
                // Skip following whitespace
                while (
                  newPos < currentOriginalValue.length &&
                  currentOriginalValue[newPos] === " "
                ) {
                  newPos++;
                }
              }

              nextValue = currentOriginalValue.slice(0, currentCursorOffset) +
                currentOriginalValue.slice(newPos, currentOriginalValue.length);
              nextCursorOffset = currentCursorOffset;
            } else {
              // Delete: delete character at cursor
              nextValue = currentOriginalValue.slice(0, currentCursorOffset) +
                currentOriginalValue.slice(
                  currentCursorOffset + 1,
                  currentOriginalValue.length,
                );
              nextCursorOffset = currentCursorOffset;
            }
          }
          break;

        default:
          if (input.length > 0 && !key.ctrl && !key.meta) {
            // Filter out newlines (e.g. from pasted text)
            let cleanInput = input.replace(/[\r\n]+/g, "");
            if (cleanInput.length === 0) return;

            // If input is longer than 1 character, assume it's a paste and trim surrounding spaces
            if (cleanInput.length > 1) {
              cleanInput = cleanInput.trim();
            }

            nextValue = currentOriginalValue.slice(0, currentCursorOffset) +
              cleanInput +
              currentOriginalValue.slice(
                currentCursorOffset,
                currentOriginalValue.length,
              );
            nextCursorOffset = currentCursorOffset + cleanInput.length;
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
      cursorOffsetRef.current = nextCursorOffset; // Update REF immediately for next potential sync event

      onCursorChange?.(nextCursorOffset, nextValue);

      if (nextValue !== currentOriginalValue) {
        valueRef.current = nextValue; // Update REF immediately!
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
