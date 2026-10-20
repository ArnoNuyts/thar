import { useState } from "react";
import { Box, Text } from "ink";
import { useFocusedInput } from "../hooks/useFocusedInput.ts";
import { useListSelection } from "../hooks/useListSelection.ts";
import { useModalMouseList } from "../hooks/useModalMouseList.ts";
import { Modal } from "./Modal.tsx";
import { SelectList } from "./SelectList.tsx";
import { useModal } from "../contexts/modal-context.tsx";
import { useTodo } from "../contexts/todo-context.tsx";
import { useNavigation } from "../contexts/navigation-context.tsx";
import { Calendar } from "./Calendar.tsx";
import { dateForOption, formatDateTag, parseDateTag } from "../logic/dates.ts";
import type { DateOptionValue } from "../logic/dates.ts";

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
  const { getSelectedTodos } = useNavigation();
  const selectedTodos = getSelectedTodos();
  const todo = selectedTodos[0]; // Reference todo for initial values
  const [isCustom, setIsCustom] = useState(false);
  const [layoutSize, setLayoutSize] = useState<{
    rows?: number;
    columns?: number;
  }>({});
  const [customDate, setCustomDate] = useState(() => {
    if (!todo) return new Date();
    const dateTag = type === "due" ? todo.tags.due : todo.tags.t;
    return parseDateTag(dateTag) ?? new Date();
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
        updateTodos(selectedTodos, (t) =>
          type === "due" ? t.removeDue() : t.removeThreshold(),
        );
        closeModal();
      }
      return;
    }

    const date = dateForOption(selected.value as DateOptionValue);

    if (selectedTodos.length > 0) {
      updateTodos(selectedTodos, (t) =>
        type === "due" ? t.setDue(date) : t.setThreshold(date),
      );
    }
    closeModal();
  };

  const selection = useListSelection({
    itemCount: options.length,
    isActive: !isCustom,
    onSelect: applyOption,
    // Escape leaves the calendar first, then closes the modal.
    onCancel: () => (isCustom ? setIsCustom(false) : closeModal()),
  });

  const { isFocused } = useFocusedInput(
    (_input, key) => {
      selection.handleKey(key);
    },
    { autoFocus: true, tag: "set-date-modal" },
  );

  useModalMouseList({
    isActive: isFocused && !isCustom,
    modalWidth: "50%",
    bodyRows: options.length,
    terminalSize: layoutSize,
    onRowClick: selection.selectAt,
    onRowHover: selection.setSelectedIndex,
  });

  const handleCustomSubmit = (date: Date) => {
    if (selectedTodos.length > 0) {
      updateTodos(selectedTodos, (t) =>
        type === "due" ? t.setDue(date) : t.setThreshold(date),
      );
      closeModal();
    }
  };

  return (
    // @ts-ignore: children prop issue
    <Modal
      title={title}
      width={isCustom ? 30 : "50%"}
      onLayoutSizeChange={setLayoutSize}
    >
      {!isCustom ? (
        <SelectList
          items={options.map((option) => ({
            key: option.value,
            label: option.label,
          }))}
          selectedIndex={selection.selectedIndex}
        />
      ) : (
        <Box flexDirection="column" alignItems="center">
          <Calendar
            value={customDate}
            onChange={setCustomDate}
            onSubmit={handleCustomSubmit}
            isFocused={isFocused}
          />
          <Box>
            <Text dimColor>Selected: {formatDateTag(customDate)}</Text>
          </Box>
        </Box>
      )}
    </Modal>
  );
};
