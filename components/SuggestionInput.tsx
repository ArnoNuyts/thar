import { useEffect, useRef, useState } from "react";
import { Box, measureElement } from "ink";
import { ControlledTextInput } from "./ControlledTextInput.tsx";
import { useSuggestion } from "../contexts/suggestion-context.tsx";
import { useSuggestionInput } from "../hooks/useSuggestionInput.ts";
import { useTagSources } from "../hooks/useTagSources.ts";

import type { Todos } from "../logic/Todos.ts";

interface SuggestionInputProps {
  value: string;
  onChange: (value: string) => void;
  onCursorChange: (cursor: number, value: string) => void;
  onSubmit?: (value: string) => void;
  onCancel: () => void;
  onSuggestionsStateChange?: (hasSuggestions: boolean) => void;
  isFocused: boolean;
  todos: Todos;
  left: number;
  top: number;
  initialCursorPos?: number;
}

export const SuggestionInput = ({
  value,
  onChange,
  onCursorChange,
  onSubmit,
  onCancel,
  onSuggestionsStateChange,
  isFocused,
  todos,
  left,
  top,
  initialCursorPos,
}: SuggestionInputProps) => {
  const [cursorPos, setCursorPos] = useState(
    initialCursorPos !== undefined ? initialCursorPos : value.length,
  );
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const ref = useRef(null);

  const { setPosition } = useSuggestion();
  const tagSources = useTagSources(todos);

  const { suggestions, wordStartIndex, updateSuggestions } = useSuggestionInput(
    {
      value,
      cursor: cursorPos,
      source: tagSources,
      onApply: (newValue, newCursor) => {
        onChange(newValue);
        setCursorPos(newCursor);
        onCursorChange(newCursor, newValue);
      },
      isActive: isFocused,
      onUnhandledKey: (_input, key) => {
        if (key.escape) {
          onCancel();
        }
      },
    },
  );

  useEffect(() => {
    onSuggestionsStateChange?.(suggestions.length > 0);
  }, [onSuggestionsStateChange, suggestions.length]);

  useEffect(() => {
    if (ref.current) {
      const { width, height } = measureElement(ref.current);
      if (width > 0 || height > 0) {
        setDimensions({ width, height });
      } else {
        // Fallback for tests
        setDimensions({ width: 80, height: 1 });
      }
    }
  }, [value]);
  /*
  useEffect(() => {
  if (suggestions.length === 0) return;

  const textUpToCursor = value.slice(0, wordStartIndex);
  const charsPerLine = dimensions.width; // terminal columns
  const cursorCol = wordStartIndex % charsPerLine;
  const cursorLine = Math.floor(textUpToCursor.length / charsPerLine);

  setPosition({
    left: left + cursorCol,
    top: top + cursorLine + 1,
  });
}, [wordStartIndex, value, dimensions.width, suggestions.length, left, top]);

  useEffect(() => {
    if (!isFocused) {
      clearSuggestions();
    }
  }, [isFocused]);
  */

  useEffect(() => {
    if (suggestions.length === 0) return;

    const textUpToCursor = value.slice(0, wordStartIndex);
    const words = textUpToCursor.split(/(\s+)/);

    let cursorLine = 0;
    let lineLength = 0;

    for (const word of words) {
      const isWhitespace = /^\s+$/.test(word);

      if (isWhitespace) {
        // spaces fill character by character, wrapping as needed
        for (let i = 0; i < word.length; i++) {
          if (lineLength >= dimensions.width) {
            cursorLine++;
            lineLength = 0;
          }
          lineLength++;
        }
      } else {
        // words wrap as a unit (if they fit)
        if (lineLength + word.length > dimensions.width && lineLength > 0) {
          cursorLine++;
          lineLength = 0;
        }
        lineLength += word.length;
      }
    }

    setPosition({
      left: left + lineLength - 2,
      top: top + cursorLine + 1,
    });
  }, [wordStartIndex, value, dimensions.width, suggestions.length, left, top]);

  const handleChange = (newValue: string) => {
    onChange(newValue);
  };

  const handleCursorChange = (newCursor: number, newValue: string) => {
    setCursorPos(newCursor);
    updateSuggestions(newValue, newCursor);
    onCursorChange(newCursor, newValue);
  };

  return (
    <Box flexGrow={1} ref={ref}>
      <ControlledTextInput
        focus={isFocused}
        value={value}
        onChange={handleChange}
        onSubmit={suggestions.length === 0 ? onSubmit : undefined}
        onCursorChange={handleCursorChange}
        cursorOffset={cursorPos}
      />
    </Box>
  );
};
