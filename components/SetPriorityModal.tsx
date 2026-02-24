import { useState } from "react";
import { Box, Text } from "ink";
import { useFocusedInput } from "../hooks/useFocusedInput.ts";
import { useModalMouseList } from "../hooks/useModalMouseList.ts";
import { Modal } from "./Modal.tsx";
import { useModal } from "../contexts/modal-context.tsx";
import { useTodo } from "../contexts/todo-context.tsx";
import { useNavigation } from "../contexts/navigation-context.tsx";
import { UpperCaseLetter } from "../types/types.ts";
import { SECONDARY_COLOR } from "../constants.ts";

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
  const { updateTodos } = useTodo();
  const { useSelectedTodos } = useNavigation();
  const selectedTodos = useSelectedTodos();
  const todo = selectedTodos[0]; // Reference todo for initial values
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
      if (selectedTodos.length === 0) return;

      const selected = options[selectedIndex];
      const newPriority = selected === "Unset"
        ? undefined
        : selected as UpperCaseLetter;
      updateTodos(selectedTodos, (t) => t.setPriority(newPriority));
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
  }, { autoFocus: true, tag: "set-priority-modal" });

  useModalMouseList({
    isActive: isFocused,
    modalWidth: 30,
    bodyRows: options.length,
    onRowClick: (rowInItems) => {
      setSelectedIndex(rowInItems);
      if (selectedTodos.length === 0) return;
      const selected = options[rowInItems];
      const newPriority = selected === "Unset"
        ? undefined
        : selected as UpperCaseLetter;
      updateTodos(selectedTodos, (t) => t.setPriority(newPriority));
      closeModal();
    },
  });

  return (
    <Modal isFocused={isFocused} title="Set Priority" width={30}>
      <Box flexDirection="column" paddingX={1}>
        {options.map((option, index) => {
          const isSelected = index === selectedIndex;
          return (
            <Box key={option}>
              <Text color={SECONDARY_COLOR}>{isSelected ? "» " : "  "}</Text>
              <Text wrap="truncate">{option}</Text>
            </Box>
          );
        })}
      </Box>
    </Modal>
  );
};
