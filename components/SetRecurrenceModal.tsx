import { useState } from "react";
import { Box, Text } from "ink";
import { useFocusedInput } from "../hooks/useFocusedInput.ts";
import { useModalMouseList } from "../hooks/useModalMouseList.ts";
import { Modal } from "./Modal.tsx";
import { useModal } from "../contexts/modal-context.tsx";
import { useTodo } from "../contexts/todo-context.tsx";
import { useNavigation } from "../contexts/navigation-context.tsx";
import { SECONDARY_COLOR } from "../constants.ts";
import { ControlledTextInput } from "./ControlledTextInput.tsx";

const BASE_OPTIONS = [
  { label: "Daily", value: "d", unit: "day(s)" },
  { label: "Weekly", value: "w", unit: "week(s)" },
  { label: "Monthly", value: "m", unit: "month(s)" },
  { label: "Yearly", value: "y", unit: "year(s)" },
];

const RESET_OPTION = { label: "Reset", value: "reset", unit: "" };

export const SetRecurrenceModal = () => {
  const { closeModal } = useModal();
  const { updateTodos } = useTodo();
  const { useSelectedTodos } = useNavigation();
  const selectedTodos = useSelectedTodos();
  const todo = selectedTodos[0]; // Reference todo for initial values
  const hasRecurrence = todo?.tags.rec !== undefined;
  const options = hasRecurrence
    ? [...BASE_OPTIONS, RESET_OPTION]
    : BASE_OPTIONS;
  const [step, setStep] = useState<"base" | "amount">("base");
  const [selectedBaseIndex, setSelectedBaseIndex] = useState(0);
  const [amount, setAmount] = useState("1");
  const handleAmountChange = (value: string) => {
    setAmount(value.replace(/\D+/g, ""));
  };

  const selectBaseOption = (index: number) => {
    const selected = options[index];
    if (!selected) return;

    if (selected.value === "reset") {
      if (selectedTodos.length > 0) {
        updateTodos(selectedTodos, (t) => t.removeRecurrence());
        closeModal();
      }
      return;
    }

    setStep("amount");
  };

  const { isFocused } = useFocusedInput((_input, key) => {
    switch (true) {
      case key.escape && step === "amount":
        setStep("base");
        break;
      case key.escape:
        closeModal();
        break;
      case step === "base" && key.return:
        selectBaseOption(selectedBaseIndex);
        break;
      case step === "base" && key.upArrow:
        setSelectedBaseIndex((
          prev: number,
        ) => (prev > 0 ? prev - 1 : options.length - 1));
        break;
      case step === "base" && key.downArrow:
        setSelectedBaseIndex((
          prev: number,
        ) => (prev < options.length - 1 ? prev + 1 : 0));
        break;
      case step === "amount" && key.return:
        if (selectedTodos.length > 0 && amount.trim().length > 0) {
          const base = options[selectedBaseIndex].value;
          const recurrenceString = `${amount}${base}`;
          updateTodos(selectedTodos, (t) => t.setRecurrence(recurrenceString));
          closeModal();
        }
        break;
    }
  }, { autoFocus: true, tag: "set-recurrence-modal" });

  useModalMouseList({
    isActive: isFocused && step === "base",
    modalWidth: "50%",
    bodyRows: options.length,
    onRowClick: (rowInItems) => {
      setSelectedBaseIndex(rowInItems);
      selectBaseOption(rowInItems);
    },
  });

  const getTitle = () => {
    if (step === "base") return "Set Recurrence Base";
    const baseLabel = BASE_OPTIONS[selectedBaseIndex].label;
    return `Set Recurrence Interval (${baseLabel})`;
  };

  return (
    // @ts-ignore: children prop issue
    <Modal isFocused={isFocused} title={getTitle()}>
      {step === "base"
        ? (
          <Box flexDirection="column" paddingX={1}>
            {options.map((option, index) => {
              const isSelected = index === selectedBaseIndex;
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
          <Box flexDirection="column" paddingX={1}>
            <Box>
              <Text>Every</Text>
              <ControlledTextInput
                focus={isFocused}
                value={amount}
                onChange={handleAmountChange}
                showCursor
              />
              <Text>{BASE_OPTIONS[selectedBaseIndex].unit}</Text>
            </Box>
            <Text dimColor>Enter = save, Esc = back</Text>
          </Box>
        )}
    </Modal>
  );
};
