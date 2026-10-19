import { ModalTodoInput } from "./ModalTodoInput.tsx";
import { useTodo } from "../contexts/todo-context.tsx";
import { useNavigation } from "../contexts/navigation-context.tsx";

export const EditTodoModal = () => {
  const { updateTodos, todos } = useTodo();
  const { useSelectedTodo } = useNavigation();
  const todo = useSelectedTodo();

  const handleSubmit = (value: string) => {
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
