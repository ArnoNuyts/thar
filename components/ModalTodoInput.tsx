import { useEffect, useRef, useState } from "react";
import { Box, measureElement, Text, useStdout } from "ink";
import { Modal } from "./Modal.tsx";
import { useModal } from "../contexts/modal-context.tsx";
import { useFocusedInput } from "../hooks/useFocusedInput.ts";
import { useMouseInput } from "../hooks/useMouseInput.ts";
import { SuggestionInput } from "./SuggestionInput.tsx";
import { SECONDARY_COLOR } from "../constants.ts";
import { Button } from "./Button.tsx";
import { resolveModalWidth } from "../utils/modal-mouse.ts";
import { getTerminalSize } from "../utils/terminal-size.ts";

import { Todos } from "../logic/Todos.ts";

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
  const [layoutSize, setLayoutSize] = useState<
    { rows?: number; columns?: number }
  >({});

  const handleSubmit = (val: string) => {
    if (val.trim().length > 0) {
      onSubmit(val);
    }
    closeModal();
  };

  const handleCancel = () => {
    closeModal();
  };

  const { isFocused } = useFocusedInput((_input, key) => {
    if (key.escape) {
      handleCancel();
      return;
    }

    if (key.tab && !hasSuggestions) {
      setSelectedButtonIndex((prev) => (prev === 0 ? 1 : 0));
      return;
    }
  }, {
    autoFocus: true,
    tag: tag || (mode === "create" ? "create-todo-input" : "edit-todo-input"),
  });
  const { stdout } = useStdout();
  const { columns: terminalWidth, rows: terminalHeight } = getTerminalSize(
    stdout,
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

  const handleCursorChange = (_cursor: number, _value: string) => {
  };

  useMouseInput((event) => {
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
  }, { isActive: isFocused });

  return (
    <Modal
      isFocused={isFocused}
      title={mode === "create" ? "Create new todo" : "Edit todo"}
      onLayoutSizeChange={setLayoutSize}
    >
      <Box flexDirection="column" position="relative" ref={inputRef}>
        <Box flexDirection="row">
          <Box width={2}>
            <Text color={SECONDARY_COLOR}>{`» `}</Text>
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
          <Text dimColor>
            {HELP_TEXT}
          </Text>
        </Box>
      </Box>
    </Modal>
  );
};

interface HoverHitOptions {
  rows: number;
  columns: number;
  modalWidth: number;
  bodyRows: number;
  buttonRowIndex: number;
  labels: [string, string];
}

const getHoveredButtonIndex = (
  x: number | undefined,
  y: number | undefined,
  opts: HoverHitOptions,
): number | null => {
  if (x === undefined || y === undefined) return null;

  const modalTopChromeRows = 3;
  const modalBottomChromeRows = 2;
  const modalHeight = modalTopChromeRows + opts.bodyRows +
    modalBottomChromeRows;
  const modalLeft = Math.floor((opts.columns - opts.modalWidth) / 2) + 1;
  const modalTop = Math.ceil((opts.rows - modalHeight) / 2) + 1;
  const buttonY = modalTop + modalTopChromeRows + opts.buttonRowIndex;
  if (y !== buttonY) return null;

  const leftHalfWidth = Math.floor(opts.modalWidth / 2);
  const rightHalfWidth = opts.modalWidth - leftHalfWidth;
  const leftLabel = `« ${opts.labels[0]} »`;
  const rightLabel = `« ${opts.labels[1]} »`;
  const leftWidth = Array.from(leftLabel).length;
  const rightWidth = Array.from(rightLabel).length;

  const leftStart = modalLeft + Math.floor((leftHalfWidth - leftWidth) / 2);
  const leftEnd = leftStart + leftWidth - 1;
  if (x >= leftStart && x <= leftEnd) return 0;

  const rightHalfLeft = modalLeft + leftHalfWidth;
  const rightStart = rightHalfLeft +
    Math.floor((rightHalfWidth - rightWidth) / 2);
  const rightEnd = rightStart + rightWidth - 1;
  if (x >= rightStart && x <= rightEnd) return 1;

  return null;
};

const countWrappedLines = (text: string, width: number): number => {
  if (width <= 0) return 1;
  if (text.length === 0) return 1;

  const paragraphs = text.split("\n");
  let lineCount = 0;

  for (const paragraph of paragraphs) {
    if (paragraph.length === 0) {
      lineCount += 1;
      continue;
    }

    let remaining = paragraph;
    while (remaining.length > width) {
      const candidate = remaining.slice(0, width + 1);
      const breakAt = candidate.lastIndexOf(" ");
      if (breakAt > 0) {
        remaining = remaining.slice(breakAt + 1);
      } else {
        remaining = remaining.slice(width);
      }
      lineCount += 1;
    }
    lineCount += 1;
  }

  return lineCount;
};
