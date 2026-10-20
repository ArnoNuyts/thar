import { useEffect, useRef, useState } from "react";
import { Box, measureElement, Text, useWindowSize } from "ink";
import { Modal } from "./Modal.tsx";
import { useModal } from "../contexts/modal-context.tsx";
import { useFocusedInput } from "../hooks/useFocusedInput.ts";
import { useMouseInput } from "../hooks/useMouseInput.ts";
import { SuggestionInput } from "./SuggestionInput.tsx";
import { COLORS } from "../theme/colors.ts";
import { Button } from "./Button.tsx";
import { resolveModalWidth } from "../utils/modal-mouse.ts";
import {
  countWrappedLines,
  getHoveredButtonIndex,
} from "../utils/modal-layout.ts";
import { getTerminalSize } from "../utils/terminal-size.ts";

import type { Todos } from "../logic/Todos.ts";

const HELP_TEXT =
  "Tab/Shift+Tab = toggle action, Enter = selected action, Esc = cancel";

interface ModalTodoInputProps {
  mode: "create" | "edit";
  initialValue?: string;
  initialCursorPos?: number;
  onSubmit: (value: string) => void;
  todos: Todos;
  tag?: string;
}

export const ModalTodoInput = ({
  mode,
  initialValue = "",
  initialCursorPos,
  onSubmit,
  todos,
  tag,
}: ModalTodoInputProps) => {
  const { closeModal } = useModal();
  const [selectedButtonIndex, setSelectedButtonIndex] = useState(0);
  const [hoveredButtonIndex, setHoveredButtonIndex] = useState<number | null>(
    null,
  );
  const [hasSuggestions, setHasSuggestions] = useState(false);
  const [layoutSize, setLayoutSize] = useState<{
    rows?: number;
    columns?: number;
  }>({});

  const handleSubmit = (val: string) => {
    if (val.trim().length > 0) {
      onSubmit(val);
    }
    closeModal();
  };

  const handleCancel = () => {
    closeModal();
  };

  const { isFocused } = useFocusedInput(
    (_input, key) => {
      if (key.escape) {
        handleCancel();
        return;
      }

      if (key.tab && !hasSuggestions) {
        setSelectedButtonIndex((prev) => (prev === 0 ? 1 : 0));
        return;
      }
    },
    {
      autoFocus: true,
      tag: tag || (mode === "create" ? "create-todo-input" : "edit-todo-input"),
    },
  );
  const windowSize = useWindowSize();
  const { columns: terminalWidth, rows: terminalHeight } = getTerminalSize(
    windowSize,
    layoutSize,
  );

  const inputRef = useRef(null);
  const [inputDimensions, setInputDimensions] = useState({
    width: 0,
    height: 0,
  });
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    if (inputRef.current) {
      const { width, height } = measureElement(inputRef.current);
      if (width > 0 && height > 0) {
        setInputDimensions({ width, height });
      } else {
        // Fallback for tests or initial render
        setInputDimensions({ width: 80, height: 10 });
      }
    }
  }, [value]);

  const modalLeft = Math.floor((terminalWidth - inputDimensions.width) / 2);
  const modalTop = Math.floor((terminalHeight - inputDimensions.height) / 2);
  const modalWidth = resolveModalWidth(terminalWidth, "50%");
  const contentWidth = Math.max(1, modalWidth - 3);
  const inputTextWidth = Math.max(1, contentWidth - 2);
  const inputLineCount = Math.max(1, countWrappedLines(value, inputTextWidth));
  const helpLineCount = Math.max(1, countWrappedLines(HELP_TEXT, contentWidth));
  const buttonRowIndex = inputLineCount + 1;
  // Input row(s), spacer before buttons, buttons row, spacer before help, help row(s).
  const bodyRows = inputLineCount + 3 + helpLineCount;
  const handlePrimaryAction = () => {
    if (selectedButtonIndex === 0) {
      handleSubmit(value);
      return;
    }
    handleCancel();
  };

  const handleChange = (newValue: string) => {
    setValue(newValue);
  };

  const handleCursorChange = (_cursor: number, _value: string) => {};

  useMouseInput(
    (event) => {
      if (!isFocused) return;
      const hovered = getHoveredButtonIndex(event.x, event.y, {
        rows: terminalHeight,
        columns: terminalWidth,
        modalWidth,
        bodyRows,
        buttonRowIndex,
        labels: ["Save", "Cancel"],
      });

      if (event.move) {
        setHoveredButtonIndex(hovered);
        return;
      }

      if (!event.leftClick || hovered === null) return;
      setSelectedButtonIndex(hovered);
      if (hovered === 0) {
        handleSubmit(value);
        return;
      }
      handleCancel();
    },
    { isActive: isFocused },
  );

  return (
    <Modal
      title={mode === "create" ? "Create new todo" : "Edit todo"}
      onLayoutSizeChange={setLayoutSize}
    >
      <Box flexDirection="column" position="relative" ref={inputRef}>
        <Box flexDirection="row">
          <Box width={2}>
            <Text color={COLORS.secondary}>{`» `}</Text>
          </Box>
          <SuggestionInput
            value={value}
            onChange={handleChange}
            onCursorChange={handleCursorChange}
            onSubmit={handlePrimaryAction}
            onCancel={handleCancel}
            onSuggestionsStateChange={setHasSuggestions}
            isFocused={isFocused}
            todos={todos}
            left={modalLeft + 3}
            top={modalTop + 1}
            initialCursorPos={initialCursorPos}
          />
        </Box>
        <Box marginTop={1}>
          <Button.Group
            isFocused={false}
            selectedIndex={selectedButtonIndex}
            onSelectedIndexChange={setSelectedButtonIndex}
            hoveredIndex={hoveredButtonIndex}
            equalWidth
          >
            <Button label="Save" onPress={() => handleSubmit(value)} />
            <Button label="Cancel" onPress={handleCancel} />
          </Button.Group>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>{HELP_TEXT}</Text>
        </Box>
      </Box>
    </Modal>
  );
};
