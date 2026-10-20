import { useEffect, useRef, useState } from "react";
import { Box, measureElement } from "ink";
import { ControlledTextInput } from "./ControlledTextInput.tsx";
import { useSuggestion } from "../contexts/suggestion-context.tsx";
import { useSuggestionInput } from "../hooks/useSuggestionInput.ts";
import { useTagSources } from "../hooks/useTagSources.ts";
import { useInput } from "../hooks/useInput.ts";
import { matchTagWordStart } from "../logic/patterns.ts";

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

  // Same criterion `useSuggestionInput` uses to decide whether a tag word
  // start has matches. Kept in sync with that hook so the parent notification
  // can happen on the input event instead of in an effect.
  const hasMatchingSuggestions = (text: string, cursor: number) => {
    const wordStart = matchTagWordStart(text.slice(0, cursor));
    if (!wordStart) return false;

    const items = wordStart.type === "project"
      ? tagSources.projects
      : tagSources.contexts;
    const searchTerm = wordStart.searchTerm.toLowerCase();
    return items.some((item) => item.toLowerCase().startsWith(searchTerm));
  };

  const { suggestions, wordStartIndex, updateSuggestions } = useSuggestionInput(
    {
      value,
      cursor: cursorPos,
      source: tagSources,
      onApply: (newValue, newCursor) => {
        onChange(newValue);
        setCursorPos(newCursor);
        onCursorChange(newCursor, newValue);
        // Applying a suggestion clears the suggestion list.
        onSuggestionsStateChange?.(false);
      },
      isActive: isFocused,
      onUnhandledKey: (_input, key) => {
        if (key.escape) {
          onCancel();
        }
      },
    },
  );

  // `useSuggestionInput` clears the list itself on Escape, so mirror that
  // transition from the key event rather than re-deriving it in an effect.
  useInput((_input, key) => {
    if (key.escape && suggestions.length > 0) {
      onSuggestionsStateChange?.(false);
    }
  }, { isActive: isFocused });

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
  }, [
    wordStartIndex,
    value,
    dimensions.width,
    suggestions.length,
    left,
    top,
    setPosition,
  ]);

  const handleChange = (newValue: string) => {
    onChange(newValue);
  };

  const handleCursorChange = (newCursor: number, newValue: string) => {
    setCursorPos(newCursor);
    updateSuggestions(newValue, newCursor);
    onCursorChange(newCursor, newValue);
    onSuggestionsStateChange?.(hasMatchingSuggestions(newValue, newCursor));
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
