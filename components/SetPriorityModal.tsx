import { useState } from "react";
import { Box, Text } from "ink";
import { useFocusedInput } from "../hooks/useFocusedInput.ts";
import { Modal } from "./Modal.tsx";
import { useModal } from "../contexts/modal-context.tsx";
import { useTodo } from "../contexts/todo-context.tsx";
import { UpperCaseLetter } from "../types/types.ts";

const PRIORITIES: (UpperCaseLetter | "Unset")[] = [
  "A",
  "B",
  "C",
  "D",
  "E",
  "F",
];

export const SetPriorityModal = () => {
  const { closeModal } = useModal();
  const { useSelectedTodo, updateTodo } = useTodo();
  const todo = useSelectedTodo();
  const [selectedIndex, setSelectedIndex] = useState(0);

  const options = [...PRIORITIES];
  if (todo?.priority) {
    options.push("Unset");
  }

  const { isFocused } = useFocusedInput((_input, key) => {
    if (key.escape) {
      closeModal();
      return;
    }

    if (key.return) {
      if (!todo) return;

      const selected = options[selectedIndex];
      if (selected === "Unset") {
        todo.setPriority(undefined);
      } else {
        todo.setPriority(selected as UpperCaseLetter);
      }
      updateTodo(todo);
      closeModal();
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((
        prev: number,
      ) => (prev > 0 ? prev - 1 : options.length - 1));
      return;
    }

    if (key.downArrow) {
      setSelectedIndex((
        prev: number,
      ) => (prev < options.length - 1 ? prev + 1 : 0));
      return;
    }
  }, { autoFocus: true });

  return (
    <Modal isFocused={isFocused} title="Set Priority" width={30}>
      <Box flexDirection="column" paddingX={1}>
        {options.map((option, index) => {
          const isSelected = index === selectedIndex;
          return (
            <Box key={option}>
              <Text color="green">{isSelected ? "» " : "  "}</Text>
              <Text>{option}</Text>
            </Box>
          );
        })}
      </Box>
    </Modal>
  );
};
