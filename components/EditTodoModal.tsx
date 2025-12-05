import { Text } from "ink";
import { Modal } from "./Modal.tsx";
import { useModal } from "../contexts/modal-context.tsx";
import { useTodo } from "../contexts/todo-context.tsx";
import { SharedTodoInput } from "./SharedTodoInput.tsx";
import { useFocusedInput } from "../hooks/useFocusedInput.ts";

export const EditTodoModal = () => {
  const { closeModal } = useModal();
  const { useSelectedTodo, updateTodo } = useTodo();
  const todo = useSelectedTodo();

  // We still need useFocusedInput to determine if the modal itself is focused/active in the focus chain
  // But the actual input handling is delegated to SharedTodoInput
  const { isFocused } = useFocusedInput(() => {}, { autoFocus: true });

  const handleSubmit = (value: string) => {
    if (todo && value.trim().length > 0) {
      todo.setText(value);
      updateTodo(todo);
    }
    closeModal();
  };

  return (
    // @ts-ignore: children prop issue
    <Modal isFocused={isFocused} title="Edit todo">
      <SharedTodoInput
        isFocused={isFocused}
        initialValue={todo?.text || ""}
        onSubmit={handleSubmit}
        onCancel={closeModal}
        footer={<Text dimColor>Enter = save, Esc = cancel</Text>}
      />
    </Modal>
  );
};
