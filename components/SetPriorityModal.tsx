import { useState } from "react";
import { useFocusedInput } from "../hooks/useFocusedInput.ts";
import { useListSelection } from "../hooks/useListSelection.ts";
import { useModalMouseList } from "../hooks/useModalMouseList.ts";
import { Modal } from "./Modal.tsx";
import { SelectList } from "./SelectList.tsx";
import { useModal } from "../contexts/modal-context.tsx";
import { useTodo } from "../contexts/todo-context.tsx";
import { useNavigation } from "../contexts/navigation-context.tsx";
import { getPriorityOptions, priorityValue } from "../logic/priority.ts";

export const SetPriorityModal = () => {
  const { closeModal } = useModal();
  const { updateTodos } = useTodo();
  const { getSelectedTodos } = useNavigation();
  const selectedTodos = getSelectedTodos();
  const todo = selectedTodos[0]; // Reference todo for initial values
  const [layoutSize, setLayoutSize] = useState<
    { rows?: number; columns?: number }
  >({});

  const options = getPriorityOptions(Boolean(todo?.priority));

  const applyPriority = (index: number) => {
    if (selectedTodos.length === 0) return;

    updateTodos(
      selectedTodos,
      (t) => t.setPriority(priorityValue(options[index])),
    );
    closeModal();
  };

  const selection = useListSelection({
    itemCount: options.length,
    onSelect: applyPriority,
    onCancel: closeModal,
  });

  const { isFocused } = useFocusedInput((_input, key) => {
    selection.handleKey(key);
  }, { autoFocus: true, tag: "set-priority-modal" });

  useModalMouseList({
    isActive: isFocused,
    modalWidth: 30,
    bodyRows: options.length,
    terminalSize: layoutSize,
    onRowClick: selection.selectAt,
    onRowHover: selection.setSelectedIndex,
  });

  return (
    <Modal
      title="Set Priority"
      width={30}
      onLayoutSizeChange={setLayoutSize}
    >
      <SelectList
        items={options.map((option) => ({ key: option, label: option }))}
        selectedIndex={selection.selectedIndex}
      />
    </Modal>
  );
};
