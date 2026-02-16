import { useEffect, useRef, useState } from "react";
import { Box, measureElement, Newline, Text, useStdout } from "ink";
import { Modal } from "./Modal.tsx";
import { useModal } from "../contexts/modal-context.tsx";
import { useFocusedInput } from "../hooks/useFocusedInput.ts";
import { SuggestionInput } from "./SuggestionInput.tsx";
import { SECONDARY_COLOR } from "../constants.ts";

import { Todos } from "../logic/Todos.ts";

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
  const { isFocused } = useFocusedInput(() => {}, {
    autoFocus: true,
    tag: tag || (mode === "create" ? "create-todo-input" : "edit-todo-input"),
  });
  const { stdout } = useStdout();
  const terminalWidth = stdout?.columns || 80;
  const terminalHeight = stdout?.rows || 24;

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

  const handleChange = (newValue: string) => {
    setValue(newValue);
  };

  const handleCursorChange = (_cursor: number, _value: string) => {
  };

  const handleSubmit = (val: string) => {
    if (val.trim().length > 0) {
      onSubmit(val);
    }
    closeModal();
  };

  const handleCancel = () => {
    closeModal();
  };

  return (
    <Modal
      isFocused={isFocused}
      title={mode === "create" ? "Create new todo" : "Edit todo"}
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
            onSubmit={handleSubmit}
            onCancel={handleCancel}
            isFocused={isFocused}
            todos={todos}
            left={modalLeft + 3}
            top={modalTop + 1}
            initialCursorPos={initialCursorPos}
          />
        </Box>
        <Newline />
        <Text dimColor>Enter = save, Esc = cancel</Text>
      </Box>
    </Modal>
  );
};
