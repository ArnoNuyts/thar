import { useState } from "react";
import { useSuggestion } from "../contexts/suggestion-context.tsx";
import { type Key, useInput } from "./useInput.ts";
import { matchTagWordStart } from "../logic/patterns.ts";
import type { TagSources } from "../logic/tag-sources.ts";

export interface UseSuggestionInputOptions {
  value: string;
  cursor: number;
  source: TagSources;
  onApply: (value: string, cursor: number) => void;
  isActive?: boolean;
  /**
   * Called for keys the suggestion mechanism does not handle. Components use
   * this for their own escape/navigation fallbacks.
   */
  onUnhandledKey?: (input: string, key: Key) => void;
}

/**
 * Shared project/context suggestion mechanism for text inputs.
 *
 * Owns filtering, selection wrapping, keyboard handling and insertion. The
 * caller owns the actual text value/cursor so each input can keep its own
 * component-specific behaviour around the suggestion mechanism.
 */
export const useSuggestionInput = ({
  value,
  cursor,
  source,
  onApply,
  isActive = true,
  onUnhandledKey,
}: UseSuggestionInputOptions) => {
  const {
    suggestions,
    setSuggestions,
    selectedIndex,
    setSelectedIndex,
    type: suggestionType,
    setType: setSuggestionType,
    clearSuggestions,
  } = useSuggestion();
  const [wordStartIndex, setWordStartIndex] = useState(0);

  const updateSuggestions = (text: string, nextCursor: number) => {
    const wordStart = matchTagWordStart(text.slice(0, nextCursor));

    if (wordStart) {
      const items =
        wordStart.type === "project" ? source.projects : source.contexts;
      const searchTerm = wordStart.searchTerm.toLowerCase();
      const matches = items.filter((item) =>
        item.toLowerCase().startsWith(searchTerm),
      );

      if (matches.length > 0) {
        setSuggestions(matches);
        setSuggestionType(wordStart.type);
        setSelectedIndex(0);
        setWordStartIndex(wordStart.startIndex);
        return;
      }
    }

    clearSuggestions();
  };

  const applySuggestion = () => {
    const suggestion = suggestions[selectedIndex];
    if (suggestion === undefined) return;

    const wordStart = matchTagWordStart(value.slice(0, cursor));
    if (!wordStart) return;

    const prefix = suggestionType === "project" ? "+" : "@";
    const newLeft =
      value.slice(0, wordStart.startIndex) + prefix + suggestion + " ";
    const newValue = newLeft + value.slice(cursor);

    onApply(newValue, newLeft.length);
    clearSuggestions();
  };

  useInput(
    (input, key) => {
      if (!isActive) return;

      if (suggestions.length > 0) {
        if (key.upArrow) {
          setSelectedIndex((prev) =>
            prev > 0 ? prev - 1 : suggestions.length - 1,
          );
          return;
        }

        if (key.downArrow) {
          setSelectedIndex((prev) =>
            prev < suggestions.length - 1 ? prev + 1 : 0,
          );
          return;
        }

        if (key.return || key.tab) {
          applySuggestion();
          return;
        }

        if (key.escape) {
          clearSuggestions();
          return;
        }
      }

      onUnhandledKey?.(input, key);
    },
    { isActive },
  );

  return {
    suggestions,
    selectedIndex,
    suggestionType,
    wordStartIndex,
    updateSuggestions,
    applySuggestion,
  };
};
