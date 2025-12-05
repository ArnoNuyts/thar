import { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import { ControlledTextInput } from "./ControlledTextInput.tsx";
import { useTodo } from "../contexts/todo-context.tsx";
import { useSuggestion } from "../contexts/suggestion-context.tsx";

interface SharedTodoInputProps {
  initialValue?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
  isFocused: boolean;
  footer?: React.ReactNode;
  maxWidth?: number;
}

export const SharedTodoInput = ({
  initialValue = "",
  onSubmit,
  onCancel,
  isFocused: parentIsFocused,
  footer,
  maxWidth,
}: SharedTodoInputProps) => {
  const [value, setValue] = useState(initialValue);
  const { todos } = useTodo();
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

  const [wordStartIndex, setWordStartIndex] = useState(0);

  // Get terminal width for line wrap calculation
  const { stdout } = useStdout();
  const terminalWidth = stdout?.columns;
  const terminalHeight = stdout?.rows;

  // We need to track cursor position manually because ink-text-input doesn't expose it in onChange
  // Initialize to end of string
  const [cursorPos, setCursorPos] = useState(initialValue.length);
  /* const [debugInfo, setDebugInfo] = useState<{
    col?: number;
    line?: number;
    modalLeft?: number;
    modalTop?: number;
    absLeft?: number;
    absTop?: number;
    termW?: number;
    termH?: number;
  }>({}); */

  // Clear suggestions when unmounting or losing focus
  useEffect(() => {
    if (!parentIsFocused) {
      clearSuggestions();
    }
  }, [parentIsFocused]);

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

  // Calculate dropdown position based on word start and terminal width
  useEffect(() => {
    if (suggestions.length === 0) return;

    // Account for the "» " prefix (2 characters)
    const effectivePos = wordStartIndex;

    // Calculate which line and column the word starts on relative to the input box
    const inputWidth = Math.floor(terminalWidth / 2 - 3);
    const line = Math.floor(effectivePos / inputWidth);
    const col = effectivePos % inputWidth;
    const modalHeight = 4 + line;

    // Approximate modal position (centered)
    // We assume the modal width is maxWidth
    // We assume the modal height is roughly 10 lines (title + input + footer + padding)
    // This is a rough estimation and might need tuning or a better way to get absolute coordinates

    // If maxWidth is provided, it means we are in a constrained box (modal)
    // The modal is centered in the terminal
    const modalLeft = Math.floor((terminalWidth / 2) - inputWidth / 2);
    const modalTop = Math.floor(
      (terminalHeight - 2) / 2 - (modalHeight / 2) + 4,
    );

    // Absolute position
    // +1 for the border of the modal
    // +1 for the title of the modal
    // +1 to appear below the text line
    // User feedback: 1 char too much to the right -> remove +1
    // User feedback: 4 lines too high -> add 4 to +3 = +7
    const absLeft = modalLeft + col;
    const absTop = modalTop + line;

    // Debug info
    /* setDebugInfo({
      col,
      line,
      modalLeft,
      modalTop,
      absLeft,
      absTop,
      termW: terminalWidth,
      termH: terminalHeight,
    }); */

    setPosition({
      left: absLeft,
      top: absTop,
    });
  }, [
    wordStartIndex,
    terminalWidth,
    suggestions.length,
    stdout?.columns,
    terminalHeight,
    maxWidth,
  ]);

  const updateSuggestions = (text: string, cursor: number) => {
    // Find word at cursor
    // Search backwards from cursor for space or start
    const leftPart = text.slice(0, cursor);

    const wordStartMatch = leftPart.match(/[\s]([\+@][\w\.\_\-]*)$/) ||
      leftPart.match(/^([\+@][\w\.\_\-]*)$/);

    if (wordStartMatch) {
      const fullWordStart = wordStartMatch[1]; // e.g. "+foo"
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
    setValue(newValue);
  };

  const handleCursorChange = (newCursor: number) => {
    setCursorPos(newCursor);
    updateSuggestions(value, newCursor);
  };

  useInput((_input, key) => {
    if (!parentIsFocused) return;

    if (suggestions.length > 0) {
      if (key.upArrow) {
        setSelectedIndex((
          prev,
        ) => (prev > 0 ? prev - 1 : suggestions.length - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedIndex((
          prev,
        ) => (prev < suggestions.length - 1 ? prev + 1 : 0));
        return;
      }
      if (key.return || key.tab) {
        // Apply suggestion
        const suggestion = suggestions[selectedIndex];
        const prefix = suggestionType === "project" ? "+" : "@";

        // We need to replace the word at the cursor
        const leftPart = value.slice(0, cursorPos);
        const rightPart = value.slice(cursorPos);

        const wordStartMatch = leftPart.match(/[\s]([\+@][\w\.\_\-]*)$/) ||
          leftPart.match(/^([\+@][\w\.\_\-]*)$/);

        if (wordStartMatch) {
          const word = wordStartMatch[1];
          const wordStart = leftPart.lastIndexOf(word);

          const newLeft = value.slice(0, wordStart) + prefix + suggestion + " ";
          const newValue = newLeft + rightPart;

          setValue(newValue);
          // Set cursor to end of new value to ensure it moves forward
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

    if (key.return) {
      if (value.trim().length > 0) {
        onSubmit(value);
      }
      return;
    }

    if (key.escape) {
      onCancel();
      return;
    }
  });

  const handleSubmit = (val: string) => {
    if (val.trim().length > 0) {
      onSubmit(val);
    }
  };

  return (
    <Box flexDirection="column" position="relative">
      {/* Debug Info */}
      {
        /* <Box position="absolute" marginTop={-5} marginLeft={0}>
        <Text color="magenta">
          {`DEBUG: col=${debugInfo.col} line=${debugInfo.line} modalLeft=${debugInfo.modalLeft} modalTop=${debugInfo.modalTop} absLeft=${debugInfo.absLeft} absTop=${debugInfo.absTop}`}
        </Text>
      </Box> */
      }
      <Box>
        <Text color="green">{`» `}</Text>
        <ControlledTextInput
          focus={parentIsFocused}
          value={value}
          onChange={handleChange}
          onSubmit={suggestions.length === 0 ? handleSubmit : undefined}
          onCursorChange={handleCursorChange}
          cursorOffset={cursorPos}
        />
      </Box>

      {footer}
    </Box>
  );
};
