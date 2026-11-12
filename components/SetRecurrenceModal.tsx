import { useRef, useState } from "react";
import { Box, Text } from "ink";
import { useFocusedInput } from "../hooks/useFocusedInput.ts";
import { useListSelection } from "../hooks/useListSelection.ts";
import { useModalMouseList } from "../hooks/useModalMouseList.ts";
import { Modal } from "./Modal.tsx";
import { SelectList } from "./SelectList.tsx";
import { useModal } from "../contexts/modal-context.tsx";
import { useTodo } from "../contexts/todo-context.tsx";
import { useNavigation } from "../contexts/navigation-context.tsx";
import { useToaster } from "../contexts/toaster-context.tsx";
import { ControlledTextInput } from "./ControlledTextInput.tsx";
import { MAX_RECURRENCE_AMOUNT, isValidRecurrence } from "../logic/todo.ts";

const BASE_OPTIONS = [
  { label: "Daily", value: "d", unit: "day(s)" },
  { label: "Weekly", value: "w", unit: "week(s)" },
  { label: "Monthly", value: "m", unit: "month(s)" },
  { label: "Yearly", value: "y", unit: "year(s)" },
];

const RESET_OPTION = { label: "Reset", value: "reset", unit: "" };

export const SetRecurrenceModal = () => {
  const { closeModal } = useModal();
  const { showToaster } = useToaster();
  const { updateTodos } = useTodo();
  const { getSelectedTodos } = useNavigation();
  const selectedTodos = getSelectedTodos();
  const todo = selectedTodos[0]; // Reference todo for initial values
  const hasRecurrence = todo?.tags.rec !== undefined;
  const options = hasRecurrence
    ? [...BASE_OPTIONS, RESET_OPTION]
    : BASE_OPTIONS;
  const [step, setStep] = useState<"base" | "amount">("base");
  const [amount, setAmount] = useState("1");
  const hasEditedAmountRef = useRef(false);
  const [layoutSize, setLayoutSize] = useState<{
    rows?: number;
    columns?: number;
  }>({});
  const amountRef = useRef(amount);

  const handleAmountChange = (value: string) => {
    let digitsOnly = value.replace(/\D+/g, "");
    if (
      !hasEditedAmountRef.current &&
      amountRef.current === "1" &&
      digitsOnly.length > 1
    ) {
      digitsOnly = digitsOnly.slice(1);
    }
    hasEditedAmountRef.current = true;
    setAmount(digitsOnly);
    amountRef.current = digitsOnly;
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

    hasEditedAmountRef.current = false;
    setAmount("1");
    amountRef.current = "1";
    setStep("amount");
  };

  const selection = useListSelection({
    itemCount: options.length,
    isActive: step === "base",
    onSelect: selectBaseOption,
    // Escape returns to the base list first, then closes the modal.
    onCancel: () => (step === "amount" ? setStep("base") : closeModal()),
  });

  const { isFocused } = useFocusedInput(
    (_input, key) => {
      if (selection.handleKey(key)) return;

      if (step === "amount" && key.return) {
        if (selectedTodos.length > 0 && amountRef.current.trim().length > 0) {
          const base = options[selection.selectedIndex].value;
          const recurrenceString = `${amountRef.current}${base}`;
          if (!isValidRecurrence(recurrenceString)) {
            showToaster(
              `Recurrence must be a whole number from 1 to ${MAX_RECURRENCE_AMOUNT}`,
            );
            return;
          }
          updateTodos(selectedTodos, (t) => t.setRecurrence(recurrenceString));
          closeModal();
        }
      }
    },
    { autoFocus: true, tag: "set-recurrence-modal" },
  );

  useModalMouseList({
    isActive: isFocused && step === "base",
    modalWidth: "50%",
    bodyRows: options.length,
    terminalSize: layoutSize,
    onRowClick: selection.selectAt,
    onRowHover: selection.setSelectedIndex,
  });

  const getTitle = () => {
    if (step === "base") return "Set Recurrence Base";
    const baseLabel = BASE_OPTIONS[selection.selectedIndex].label;
    return `Set Recurrence Interval (${baseLabel})`;
  };

  return (
    // @ts-ignore: children prop issue
    <Modal title={getTitle()} onLayoutSizeChange={setLayoutSize}>
      {step === "base" ? (
        <SelectList
          items={options.map((option) => ({
            key: option.value,
            label: option.label,
          }))}
          selectedIndex={selection.selectedIndex}
        />
      ) : (
        <Box flexDirection="column" paddingX={1}>
          <Box>
            <Text>Every</Text>
            <ControlledTextInput
              focus={isFocused}
              value={amount}
              onChange={handleAmountChange}
              showCursor
            />
            <Text>{BASE_OPTIONS[selection.selectedIndex].unit}</Text>
          </Box>
          <Text dimColor>Enter = save, Esc = back</Text>
        </Box>
      )}
    </Modal>
  );
};
