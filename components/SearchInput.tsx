import { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { ControlledTextInput } from "./ControlledTextInput.tsx";
import { useSuggestion } from "../contexts/suggestion-context.tsx";
import { useSearch } from "../contexts/search-context.tsx";
import { useFocusable } from "../hooks/useFocusable.ts";
import { useNavigation } from "../contexts/navigation-context.tsx";
import { useSuggestionInput } from "../hooks/useSuggestionInput.ts";
import { useTagSources } from "../hooks/useTagSources.ts";
import { SECONDARY_COLOR } from "../constants.ts";
import { COLORS } from "../theme/colors.ts";

import type { Todos } from "../logic/Todos.ts";

export const SearchInput = ({ todos }: { todos: Todos }) => {
  const { searchQuery, setSearchQuery, focusRef, setIsSearchFocused } =
    useSearch();
  const { setPosition, clearSuggestions } = useSuggestion();

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
  const tagSources = useTagSources(todos);

  // Register focus function with context ref after commit so we never write to
  // the ref during render.
  useEffect(() => {
    focusRef.current = focus;
  }, [focusRef, focus]);

  // Clear suggestions when losing focus
  useEffect(() => {
    if (!isFocused) {
      clearSuggestions();
    }
    // Sync focus state with context
    setIsSearchFocused(isFocused);
  }, [isFocused, clearSuggestions, setIsSearchFocused]);

  const { suggestions, wordStartIndex, updateSuggestions } = useSuggestionInput(
    {
      value: searchQuery,
      cursor: cursorPos,
      source: tagSources,
      onApply: (newValue, newCursor) => {
        setSearchQuery(newValue);
        setCursorPos(newCursor);
      },
      isActive: isFocused,
      onUnhandledKey: (_input, key) => {
        // Navigation fallback when no suggestions are open
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
      },
    },
  );

  // Calculate dropdown position
  useEffect(() => {
    if (suggestions.length === 0) return;

    // Position dropdown below the input (fixed position at top of screen)
    setPosition({
      left: 3 + wordStartIndex,
      top: 1,
    });
  }, [wordStartIndex, suggestions.length, setPosition]);

  const handleChange = (newValue: string) => {
    setSearchQuery(newValue);
  };

  const handleCursorChange = (newCursor: number, newValue: string) => {
    setCursorPos(newCursor);
    updateSuggestions(newValue, newCursor);
  };

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
      <Text color={isFocused ? SECONDARY_COLOR : COLORS.muted}>{` / `}</Text>
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
            <Text color={COLORS.foreground}>
              {searchQuery}
            </Text>
          )}
      </Box>
      <Text color={isFocused ? SECONDARY_COLOR : COLORS.muted}>{` / `}</Text>
    </Box>
  );
};
