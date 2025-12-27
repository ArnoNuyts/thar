import { ModalTodoInput } from "./ModalTodoInput.tsx";
import { useTodo } from "../contexts/todo-context.tsx";
import { useNavigation } from "../contexts/navigation-context.tsx";

export const EditTodoModal = () => {
  const { updateTodo, todos } = useTodo();
  const { useSelectedTodo } = useNavigation();
  const todo = useSelectedTodo();

  const handleSubmit = (value: string) => {
    if (todo && value.trim().length > 0) {
      const updatedTodo = todo.setText(value);
      updateTodo(todo, updatedTodo);
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
