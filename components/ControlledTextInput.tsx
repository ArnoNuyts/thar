import { useEffect, useRef, useState } from "react";
import { Text, useInput, useStdin } from "ink";
import chalk from "chalk";
import { Buffer } from "node:buffer";

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

  // Track the last raw key sequence to distinguish backspace from delete
  // Use ref instead of state to avoid race condition with useInput
  const lastRawKeyRef = useRef<string>("");
  const { stdin } = useStdin();

  // Use controlled cursor offset if provided, otherwise use internal state
  const cursorOffset = controlledCursorOffset ?? internalCursorOffset;

  // Listen to raw stdin to capture actual key sequences
  useEffect(() => {
    if (!stdin || !focus) return;

    const handleRawData = (data: Buffer) => {
      const str = data.toString();
      lastRawKeyRef.current = str;
    };

    stdin.on("data", handleRawData);
    return () => {
      stdin.off("data", handleRawData);
    };
  }, [stdin, focus]);

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
      if (
        key.upArrow ||
        key.downArrow ||
        (key.ctrl && input === "c") ||
        key.tab ||
        (key.shift && key.tab)
      ) {
        return;
      }

      if (key.return) {
        if (onSubmit) {
          onSubmit(originalValue);
        }
        return;
      }

      let nextCursorOffset = cursorOffset;
      let nextValue = originalValue;

      if (key.leftArrow) {
        if (showCursor) {
          nextCursorOffset = Math.max(0, cursorOffset - 1);
        }
      } else if (key.rightArrow) {
        if (showCursor) {
          nextCursorOffset = Math.min(originalValue.length, cursorOffset + 1);
        }
      } else if (key.backspace || key.delete) {
        // On Windows, backspace sends \x7f and delete sends \x1b[3~
        // Use the raw key sequence to distinguish them
        const isActualBackspace = lastRawKeyRef.current === "\x7f" ||
          key.backspace;

        if (isActualBackspace && cursorOffset > 0) {
          // Backspace: delete character before cursor
          nextValue = originalValue.slice(0, cursorOffset - 1) +
            originalValue.slice(cursorOffset, originalValue.length);
          nextCursorOffset = cursorOffset - 1;
        } else if (!isActualBackspace && cursorOffset < originalValue.length) {
          // Delete: delete character at cursor
          nextValue = originalValue.slice(0, cursorOffset) +
            originalValue.slice(cursorOffset + 1, originalValue.length);
          nextCursorOffset = cursorOffset;
        }
      } else if (key.escape) {
        // Don't handle escape here, let parent handle it
        return;
      } else {
        nextValue = originalValue.slice(0, cursorOffset) +
          input +
          originalValue.slice(cursorOffset, originalValue.length);
        nextCursorOffset = cursorOffset + input.length;
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
