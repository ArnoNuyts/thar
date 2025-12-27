import { useEffect, useRef, useState } from "react";
import { Box, measureElement, Text } from "ink";
import { useInput } from "../hooks/useInput.ts";
import { ControlledTextInput } from "./ControlledTextInput.tsx";
import { useSuggestion } from "../contexts/suggestion-context.tsx";

import { Todos } from "../logic/Todos.ts";

interface SuggestionInputProps {
  value: string;
  onChange: (value: string) => void;
  onCursorChange: (cursor: number, value: string) => void;
  onSubmit?: (value: string) => void;
  onCancel: () => void;
  isFocused: boolean;
  todos: Todos;
  left: number;
  top: number;
}

export const SuggestionInput = ({
  value,
  onChange,
  onCursorChange,
  onSubmit,
  onCancel,
  isFocused,
  todos,
  left,
  top,
}: SuggestionInputProps) => {
  const [cursorPos, setCursorPos] = useState(value.length);
  const [wordStartIndex, setWordStartIndex] = useState(0);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const ref = useRef(null);

  const {
    suggestions,
    setSuggestions,
    selectedIndex,
    setSelectedIndex,
    type: suggestionType,
    setType: setSuggestionType,
    setPosition,
    clearSuggestions,
  } = useSuggestion();

  const { allProjects, allContexts } = (() => {
    const projects = new Set<string>();
    const contexts = new Set<string>();
    todos.forEach((todo) => {
      todo.projects.forEach((p) => projects.add(p));
      todo.contexts.forEach((c) => contexts.add(c));
    });
    return {
      allProjects: Array.from(projects).sort(),
      allContexts: Array.from(contexts).sort(),
    };
  })();

  useEffect(() => {
    if (ref.current) {
      const { width, height } = measureElement(ref.current);
      setDimensions({ width, height });
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

  const updateSuggestions = (text: string, cursor: number) => {
    const leftPart = text.slice(0, cursor);

    const wordStartMatch = leftPart.match(/[\s]([\+@][\w\.\_\-]*)$/) ||
      leftPart.match(/^([\+@][\w\.\_\-]*)$/);

    if (wordStartMatch) {
      const fullWordStart = wordStartMatch[1];
      const startIdx = leftPart.lastIndexOf(fullWordStart);

      const type = fullWordStart.startsWith("+") ? "project" : "context";
      const searchTerm = fullWordStart.substring(1);

      const source = type === "project" ? allProjects : allContexts;
      const matches = source.filter((item) =>
        item.toLowerCase().startsWith(searchTerm.toLowerCase())
      );

      if (matches.length > 0) {
        setSuggestions(matches);
        setSuggestionType(type);
        setSelectedIndex(0);
        setWordStartIndex(startIdx);
        return;
      }
    }

    clearSuggestions();
  };

  const handleChange = (newValue: string) => {
    onChange(newValue);
  };

  const handleCursorChange = (newCursor: number, newValue: string) => {
    setCursorPos(newCursor);
    updateSuggestions(newValue, newCursor);
    onCursorChange(newCursor, newValue);
  };

  useInput((_input, key) => {
    if (!isFocused) return;

    const hasSuggestions = suggestions.length > 0;

    switch (true) {
      case key.upArrow && hasSuggestions:
        setSelectedIndex((
          prev,
        ) => (prev > 0 ? prev - 1 : suggestions.length - 1));
        break;

      case key.downArrow && hasSuggestions:
        setSelectedIndex((
          prev,
        ) => (prev < suggestions.length - 1 ? prev + 1 : 0));
        break;

      case (key.return || key.tab) && hasSuggestions: {
        const suggestion = suggestions[selectedIndex];
        const prefix = suggestionType === "project" ? "+" : "@";

        const leftPart = value.slice(0, cursorPos);
        const rightPart = value.slice(cursorPos);

        const wordStartMatch = leftPart.match(/[\s]([\+@][\w\.\_\-]*)$/) ||
          leftPart.match(/^([\+@][\w\.\_\-]*)$/);

        if (wordStartMatch) {
          const word = wordStartMatch[1];
          const wordStart = leftPart.lastIndexOf(word);

          const newLeft = value.slice(0, wordStart) + prefix + suggestion + " ";
          const newValue = newLeft + rightPart;

          onChange(newValue);
          setCursorPos(newLeft.length);
          clearSuggestions();
          onCursorChange(newLeft.length, newValue);
        }
        break;
      }

      case key.escape:
        if (hasSuggestions) {
          clearSuggestions();
        } else {
          onCancel();
        }
        break;

      default:
        break;
    }
  });

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
