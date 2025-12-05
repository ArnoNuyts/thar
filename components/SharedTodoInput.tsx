import { useMemo, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import { ControlledTextInput } from "./ControlledTextInput.tsx";
import { useTodo } from "../contexts/todo-context.tsx";

interface SharedTodoInputProps {
  initialValue?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
  isFocused: boolean;
  footer?: React.ReactNode;
}

export const SharedTodoInput = ({
  initialValue = "",
  onSubmit,
  onCancel,
  isFocused: parentIsFocused,
  footer,
}: SharedTodoInputProps) => {
  const [value, setValue] = useState(initialValue);
  const { todos } = useTodo();
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [suggestionType, setSuggestionType] = useState<
    "project" | "context" | null
  >(null);
  const [wordStartIndex, setWordStartIndex] = useState(0);

  // Get terminal width for line wrap calculation
  const { stdout } = useStdout();
  const terminalWidth = stdout?.columns || 80;

  // We need to track cursor position manually because ink-text-input doesn't expose it in onChange
  // Initialize to end of string
  const [cursorPos, setCursorPos] = useState(initialValue.length);

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
  const { dropdownLeft, dropdownTop } = useMemo(() => {
    // Account for the "» " prefix (2 characters)
    const prefixLen = 2;
    const effectivePos = wordStartIndex + prefixLen;

    // Calculate which line and column the word starts on
    const line = Math.floor(effectivePos / terminalWidth);
    const col = effectivePos % terminalWidth;

    return {
      dropdownLeft: col,
      dropdownTop: line + 1, // +1 to appear below the text line
    };
  }, [wordStartIndex, terminalWidth]);

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

    setSuggestions([]);
    setSuggestionType(null);
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
          setSuggestions([]);
          setSuggestionType(null);
        }
        return;
      }
      if (key.escape) {
        setSuggestions([]);
        setSuggestionType(null);
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
      {suggestions.length > 0 && (
        <Box
          flexDirection="column"
          borderStyle="single"
          borderColor="yellow"
          position="absolute"
          marginTop={dropdownTop}
          marginLeft={dropdownLeft}
          backgroundColor="black"
        >
          {suggestions.map((suggestion, index) => (
            <Text
              key={suggestion}
              color={index === selectedIndex ? "blue" : "white"}
              backgroundColor={index === selectedIndex ? "white" : undefined}
            >
              {suggestionType === "project" ? "+" : "@"}
              {suggestion}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
};
