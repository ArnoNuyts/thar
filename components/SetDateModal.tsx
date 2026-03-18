import { useState } from "react";
import { Box, Text } from "ink";
import { useFocusedInput } from "../hooks/useFocusedInput.ts";
import { useModalMouseList } from "../hooks/useModalMouseList.ts";
import { Modal } from "./Modal.tsx";
import { useModal } from "../contexts/modal-context.tsx";
import { useTodo } from "../contexts/todo-context.tsx";
import { useNavigation } from "../contexts/navigation-context.tsx";
import { Calendar } from "./Calendar.tsx";
import { format } from "date-fns";
import { SECONDARY_COLOR } from "../constants.ts";

const BASE_OPTIONS = [
  { label: "Today", value: "today" },
  { label: "Tomorrow", value: "tomorrow" },
  { label: "Next Week", value: "next-week" },
  { label: "Next Month", value: "next-month" },
  { label: "Custom", value: "custom" },
];

interface SetDateModalProps {
  type: "due" | "threshold";
}

export const SetDateModal = ({ type }: SetDateModalProps) => {
  const { closeModal } = useModal();
  const { updateTodos } = useTodo();
  const { useSelectedTodos } = useNavigation();
  const selectedTodos = useSelectedTodos();
  const todo = selectedTodos[0]; // Reference todo for initial values
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isCustom, setIsCustom] = useState(false);
  const [layoutSize, setLayoutSize] = useState<
    { rows?: number; columns?: number }
  >({});
  const [customDate, setCustomDate] = useState(() => {
    if (!todo) return new Date();
    const dateStr = type === "due" ? todo.tags.due : todo.tags.t;
    if (typeof dateStr === "string") {
      const [year, month, day] = dateStr.split("-").map(Number);
      return new Date(year, month - 1, day);
    }
    return new Date();
  });

  const options = [...BASE_OPTIONS];
  if (todo) {
    if (type === "due" && todo.tags.due) {
      options.push({ label: "Reset", value: "reset" });
    } else if (type === "threshold" && todo.tags.t) {
      options.push({ label: "Reset", value: "reset" });
    }
  }

  const title = type === "due" ? "Set Due Date" : "Set Threshold Date";

  const applyOption = (index: number) => {
    const selected = options[index];
    if (!selected) return;

    if (selected.value === "custom") {
      setIsCustom(true);
      return;
    }

    if (selected.value === "reset") {
      if (selectedTodos.length > 0) {
        updateTodos(
          selectedTodos,
          (t) => (type === "due" ? t.removeDue() : t.removeThreshold()),
        );
        closeModal();
      }
      return;
    }

    const date = new Date();
    switch (selected.value) {
      case "today":
        break;
      case "tomorrow":
        date.setDate(date.getDate() + 1);
        break;
      case "next-week":
        date.setDate(date.getDate() + 7);
        break;
      case "next-month":
        date.setMonth(date.getMonth() + 1);
        break;
    }

    if (selectedTodos.length > 0) {
      updateTodos(
        selectedTodos,
        (t) => (type === "due" ? t.setDue(date) : t.setThreshold(date)),
      );
    }
    closeModal();
  };

  const { isFocused } = useFocusedInput((_input, key) => {
    if (key.escape) {
      if (isCustom) {
        setIsCustom(false);
      } else {
        closeModal();
      }
      return;
    }

    if (isCustom) return; // Let Calendar handle input when custom is active

    if (key.return) {
      applyOption(selectedIndex);
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
  }, { autoFocus: true, tag: "set-date-modal" });

  useModalMouseList({
    isActive: isFocused && !isCustom,
    modalWidth: "50%",
    bodyRows: options.length,
    terminalSize: layoutSize,
    onRowClick: (rowInItems) => {
      setSelectedIndex(rowInItems);
      applyOption(rowInItems);
    },
  });

  const handleCustomSubmit = (date: Date) => {
    if (selectedTodos.length > 0) {
      updateTodos(
        selectedTodos,
        (t) => (type === "due" ? t.setDue(date) : t.setThreshold(date)),
      );
      closeModal();
    }
  };

  return (
    // @ts-ignore: children prop issue
    <Modal
      isFocused={isFocused}
      title={title}
      width={isCustom ? 30 : "50%"}
      onLayoutSizeChange={setLayoutSize}
    >
      {!isCustom
        ? (
          <Box flexDirection="column" paddingX={1}>
            {options.map((option, index) => {
              const isSelected = index === selectedIndex;
              return (
                <Box key={option.value}>
                  <Text color={SECONDARY_COLOR}>
                    {isSelected ? "» " : "  "}
                  </Text>
                  <Text wrap="truncate">{option.label}</Text>
                </Box>
              );
            })}
          </Box>
        )
        : (
          <Box flexDirection="column" alignItems="center">
            <Calendar
              value={customDate}
              onChange={setCustomDate}
              onSubmit={handleCustomSubmit}
              isFocused={isFocused}
            />
            <Box>
              <Text dimColor>Selected: {format(customDate, "yyyy-MM-dd")}</Text>
            </Box>
          </Box>
        )}
    </Modal>
  );
};
