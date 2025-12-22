import { useState } from "react";
import { Box, Text } from "ink";
import { useFocusedInput } from "../hooks/useFocusedInput.ts";
import { Modal } from "./Modal.tsx";
import { useModal } from "../contexts/modal-context.tsx";
import { useTodo } from "../contexts/todo-context.tsx";
import { useNavigation } from "../contexts/navigation-context.tsx";
import { Calendar } from "./Calendar.tsx";
import { format } from "date-fns";

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
  const { updateTodo } = useTodo();
  const { useSelectedTodo } = useNavigation();
  const todo = useSelectedTodo();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isCustom, setIsCustom] = useState(false);
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
      const selected = options[selectedIndex];
      if (selected.value === "custom") {
        setIsCustom(true);
      } else if (selected.value === "reset") {
        if (todo) {
          const updatedTodo = type === "due"
            ? todo.removeDue()
            : todo.removeThreshold();
          updateTodo(todo, updatedTodo);
          closeModal();
        }
      } else {
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
        if (todo) {
          const updatedTodo = type === "due"
            ? todo.setDue(date)
            : todo.setThreshold(date);
          updateTodo(todo, updatedTodo);
        }
        closeModal();
      }
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

  const handleCustomSubmit = (date: Date) => {
    if (todo) {
      const updatedTodo = type === "due"
        ? todo.setDue(date)
        : todo.setThreshold(date);
      updateTodo(todo, updatedTodo);
      closeModal();
    }
  };

  return (
    // @ts-ignore: children prop issue
    <Modal isFocused={isFocused} title={title} width={isCustom ? 30 : "50%"}>
      {!isCustom
        ? (
          <Box flexDirection="column" paddingX={1}>
            {options.map((option, index) => {
              const isSelected = index === selectedIndex;
              return (
                <Box key={option.value}>
                  <Text color="green">{isSelected ? "» " : "  "}</Text>
                  <Text>{option.label}</Text>
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
