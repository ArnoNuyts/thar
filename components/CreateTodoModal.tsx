import { Text, useStdout } from "ink";
import { Modal } from "./Modal.tsx";
import { useModal } from "../contexts/modal-context.tsx";
import { useTodo } from "../contexts/todo-context.tsx";
import { useNavigation } from "../contexts/navigation-context.tsx";
import { SharedTodoInput } from "./SharedTodoInput.tsx";
import { useFocusedInput } from "../hooks/useFocusedInput.ts";

export const CreateTodoModal = () => {
  const { closeModal } = useModal();
  const { addTodo, todos } = useTodo();
  const { setSelectedTodoId } = useNavigation();

  const { isFocused } = useFocusedInput(() => {}, { autoFocus: true });
  const { stdout } = useStdout();
  const maxWidth = Math.floor((stdout?.columns || 80) * 0.5) - 6; // 50% width - borders/padding

  const handleSubmit = (value: string) => {
    if (value.trim().length > 0) {
      const newTodo = addTodo(value);
      setSelectedTodoId(newTodo.id);
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
        footer={<Text dimColor>Enter = save, Esc = cancel</Text>}
        maxWidth={maxWidth}
        todos={todos}
      />
    </Modal>
  );
};
