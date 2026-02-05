import { useEffect, useMemo, useState } from "react";
import { Box, Text } from "ink";
import { useInput } from "../hooks/useInput.ts";
import { ControlledTextInput } from "./ControlledTextInput.tsx";
import { useSuggestion } from "../contexts/suggestion-context.tsx";
import { useSearch } from "../contexts/search-context.tsx";
import { useFocusable } from "../hooks/useFocusable.ts";
import { useNavigation } from "../contexts/navigation-context.tsx";
import { SECONDARY_COLOR } from "../constants.ts";

import { Todos } from "../logic/Todos.ts";

export const SearchInput = ({ todos }: { todos: Todos }) => {
  const { searchQuery, setSearchQuery, focusRef, setIsSearchFocused } =
    useSearch();
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

  const { isFocused, focus, blur } = useFocusable({ tag: "search-input" });
  // Get navigation functions
  const {
    navigateUp,
    navigateDown,
    navigatePageUp,
    navigatePageDown,
    navigateHome,
    navigateEnd,
  } = useNavigation();
  const [cursorPos, setCursorPos] = useState(searchQuery.length);
  const [wordStartIndex, setWordStartIndex] = useState(0);

  // Register focus function with context ref (no useEffect to avoid re-render loop)
  focusRef.current = focus;

  // Clear suggestions when losing focus
  useEffect(() => {
    if (!isFocused) {
      clearSuggestions();
    }
    // Sync focus state with context
    setIsSearchFocused(isFocused);
  }, [isFocused, clearSuggestions, setIsSearchFocused]);

  // Extract all unique projects and contexts
  const { allProjects, allContexts } = useMemo(() => {
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
  }, [todos]);

  // Calculate dropdown position
  useEffect(() => {
    if (suggestions.length === 0) return;

    // Position dropdown below the input (fixed position at top of screen)
    setPosition({
      left: 3 + wordStartIndex,
      top: 1,
    });
  }, [wordStartIndex, suggestions.length, setPosition]);

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
    setSearchQuery(newValue);
  };

  const handleCursorChange = (newCursor: number, newValue: string) => {
    setCursorPos(newCursor);
    updateSuggestions(newValue, newCursor);
  };

  useInput((_input, key) => {
    if (!isFocused) return;

    if (suggestions.length > 0) {
      if (key.upArrow) {
        setSelectedIndex((prev) =>
          prev > 0 ? prev - 1 : suggestions.length - 1
        );
        return;
      }
      if (key.downArrow) {
        setSelectedIndex((prev) =>
          prev < suggestions.length - 1 ? prev + 1 : 0
        );
        return;
      }
      if (key.return || key.tab) {
        // Apply suggestion
        const suggestion = suggestions[selectedIndex];
        const prefix = suggestionType === "project" ? "+" : "@";

        const leftPart = searchQuery.slice(0, cursorPos);
        const rightPart = searchQuery.slice(cursorPos);

        const wordStartMatch = leftPart.match(/[\s]([\+@][\w\.\_\-]*)$/) ||
          leftPart.match(/^([\+@][\w\.\_\-]*)$/);

        if (wordStartMatch) {
          const word = wordStartMatch[1];
          const wordStart = leftPart.lastIndexOf(word);

          const newLeft = searchQuery.slice(0, wordStart) + prefix +
            suggestion + " ";
          const newValue = newLeft + rightPart;

          setSearchQuery(newValue);
          setCursorPos(newLeft.length);
          clearSuggestions();
        }
        return;
      }
      if (key.escape) {
        clearSuggestions();
        return;
      }
    }

    // Navigation fallback when no suggestions
    if (key.upArrow) {
      navigateUp(key.shift);
      return;
    }
    if (key.downArrow) {
      navigateDown(key.shift);
      return;
    }
    if (key.pageUp) {
      navigatePageUp(key.shift);
      return;
    }
    if (key.pageDown) {
      navigatePageDown(key.shift);
      return;
    }
    if (key.home) {
      navigateHome();
      return;
    }
    if (key.end) {
      navigateEnd();
      return;
    }

    if (key.return) {
      // Unfocus but keep filter active
      blur();
      return;
    }

    if (key.escape) {
      // Clear filter and unfocus
      setSearchQuery("");
      setCursorPos(0);
      blur();
      return;
    }
  });

  // Hide search bar when unfocused and empty
  const isVisible = isFocused || searchQuery.length > 0;

  if (!isVisible) {
    return null;
  }

  return (
    <Box
      flexDirection="row"
      borderStyle="single"
      borderTop={false}
      borderLeft={false}
      borderRight={false}
      borderBottom
    >
      <Text color={isFocused ? SECONDARY_COLOR : "gray"}>{` / `}</Text>
      <Box flexGrow={1}>
        {isFocused
          ? (
            <ControlledTextInput
              focus={isFocused}
              value={searchQuery}
              onChange={handleChange}
              onCursorChange={handleCursorChange}
              cursorOffset={cursorPos}
            />
          )
          : (
            <Text color="white">
              {searchQuery}
            </Text>
          )}
      </Box>
      <Text color={isFocused ? SECONDARY_COLOR : "gray"}>{` / `}</Text>
    </Box>
  );
};
