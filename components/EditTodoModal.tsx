import { useState } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import { useFocusedInput } from "../hooks/useFocusedInput.ts";
import { Modal } from "./Modal.tsx";
import { useModal } from "../contexts/modal-context.tsx";
import { useTodo } from "../contexts/todo-context.tsx";

export const EditTodoModal = () => {
  const { closeModal } = useModal();
  const { useSelectedTodo, updateTodo } = useTodo();
  const todo = useSelectedTodo();
  const [text, setText] = useState(todo?.text || "");

  const { isFocused } = useFocusedInput((_input, key) => {
    if (key.escape) {
      closeModal();
      return;
    }

    if (key.return) {
      if (todo && text.trim().length > 0) {
        todo.setText(text);
        updateTodo(todo);
      }
      closeModal();
      return;
    }
  }, { autoFocus: true });

  return (
    // @ts-ignore: children prop issue
    <Modal isFocused={isFocused} title="Edit todo">
      <Box>
        <Text color="green">»</Text>
        <TextInput
          focus={isFocused}
          value={text}
          onChange={setText}
        />
      </Box>
      <Text dimColor>Enter = save, Esc = cancel</Text>
    </Modal>
  );
};
