import { ModalTodoInput } from "./ModalTodoInput.tsx";
import { useTodo } from "../contexts/todo-context.tsx";
import { useNavigation } from "../contexts/navigation-context.tsx";
import { useToaster } from "../contexts/toaster-context.tsx";
import { findUnsafeTodoTextCodePoint } from "../logic/control-characters.ts";
import { toBoundedDisplayMessage } from "../logic/display-safety.ts";
import { TodoControlCharacterError } from "../logic/limits.ts";

export const EditTodoModal = () => {
  const { updateTodos, todos } = useTodo();
  const { getSelectedTodo } = useNavigation();
  const { showToaster } = useToaster();
  const todo = getSelectedTodo();

  const handleSubmit = (value: string) => {
    const codePoint = findUnsafeTodoTextCodePoint(value);
    if (codePoint !== undefined) {
      showToaster(
        toBoundedDisplayMessage(new TodoControlCharacterError(1, codePoint)),
      );
      return;
    }

    if (todo && value.trim().length > 0) {
      updateTodos([todo], (t) => t.setText(value, { preserveTags: true }));
    }
  };

  return (
    <ModalTodoInput
      mode="edit"
      initialValue={todo?.text || ""}
      onSubmit={handleSubmit}
      todos={todos}
    />
  );
};
