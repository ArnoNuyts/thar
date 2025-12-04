import { Text } from "ink";
import { Modal } from "./Modal.tsx";
import { useModal } from "../contexts/modal-context.tsx";
import { useTodo } from "../contexts/todo-context.tsx";
import { SharedTodoInput } from "./SharedTodoInput.tsx";
import { useFocusedInput } from "../hooks/useFocusedInput.ts";

export const CreateTodoModal = () => {
  const { closeModal } = useModal();
  const { addTodo } = useTodo();

  const { isFocused } = useFocusedInput(() => {}, { autoFocus: true });

  const handleSubmit = (value: string) => {
    if (value.trim().length > 0) {
      addTodo(value);
    }
    closeModal();
  };

  return (
    // @ts-ignore: children prop issue
    <Modal isFocused={isFocused} title="Create new todo">
      <SharedTodoInput
        isFocused={isFocused}
        onSubmit={handleSubmit}
        onCancel={closeModal}
      />
      <Text dimColor>Enter = save, Esc = cancel</Text>
    </Modal>
  );
};
