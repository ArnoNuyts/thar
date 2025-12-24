import { Text, useStdout } from "ink";
import { Modal } from "./Modal.tsx";
import { useModal } from "../contexts/modal-context.tsx";
import { useTodo } from "../contexts/todo-context.tsx";
import { useNavigation } from "../contexts/navigation-context.tsx";
import { SharedTodoInput } from "./SharedTodoInput.tsx";
import { useFocusedInput } from "../hooks/useFocusedInput.ts";

export const EditTodoModal = () => {
  const { closeModal } = useModal();
  const { updateTodo, todos } = useTodo();
  const { useSelectedTodo } = useNavigation();
  const todo = useSelectedTodo();

  const { isFocused } = useFocusedInput(() => {}, { autoFocus: true });
  const { stdout } = useStdout();
  const terminalWidth = stdout?.columns || 80;
  const terminalHeight = stdout?.rows || 24;
  const maxWidth = Math.floor(terminalWidth * 0.5) - 6;

  const modalLeft = Math.floor(terminalWidth * 0.25);
  const modalTop = Math.floor(terminalHeight / 2) - 2;

  const handleSubmit = (value: string) => {
    if (todo && value.trim().length > 0) {
      const updatedTodo = todo.setText(value);
      updateTodo(todo, updatedTodo);
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
        maxWidth={maxWidth}
        todos={todos}
        modalLeft={modalLeft}
        modalTop={modalTop}
      />
    </Modal>
  );
};
