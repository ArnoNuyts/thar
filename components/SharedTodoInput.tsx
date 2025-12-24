import { useState } from "react";
import { Box, Newline, Text } from "ink";
import { SuggestionInput } from "./SuggestionInput.tsx";
import { SECONDARY_COLOR } from "../constants.ts";

import { Todos } from "../logic/Todos.ts";

interface SharedTodoInputProps {
  initialValue?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
  isFocused: boolean;
  footer?: React.ReactNode;
  maxWidth?: number;
  todos: Todos;
  modalLeft: number;
  modalTop: number;
}

export const SharedTodoInput = ({
  initialValue = "",
  onSubmit,
  onCancel,
  isFocused: parentIsFocused,
  footer,
  todos,
  modalLeft,
  modalTop,
}: SharedTodoInputProps) => {
  const [value, setValue] = useState(initialValue);

  const handleChange = (newValue: string) => {
    setValue(newValue);
  };

  const handleCursorChange = (_cursor: number, _value: string) => {
  };

  const handleSubmit = (val: string) => {
    if (val.trim().length > 0) {
      onSubmit(val);
    }
  };

  return (
    <Box flexDirection="column" position="relative">
      <Box flexDirection="row">
        <Box width={2}>
          <Text color={SECONDARY_COLOR}>{`» `}</Text>
        </Box>
        <SuggestionInput
          value={value}
          onChange={handleChange}
          onCursorChange={handleCursorChange}
          onSubmit={handleSubmit}
          onCancel={onCancel}
          isFocused={parentIsFocused}
          todos={todos}
          modalLeft={modalLeft}
          modalTop={modalTop}
        />
      </Box>
      <Newline />
      {footer}
    </Box>
  );
};
