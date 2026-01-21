import { ModalTodoInput } from "./ModalTodoInput.tsx";
import { useTodo } from "../contexts/todo-context.tsx";
import { useNavigation } from "../contexts/navigation-context.tsx";

export const CreateTodoModal = () => {
  const { addTodos, todos } = useTodo();
  const { setSelectedTodoId } = useNavigation();

  const handleSubmit = (value: string) => {
    if (value.trim().length > 0) {
      const added = addTodos(value);
      if (added.length > 0) {
        setSelectedTodoId(added[0].id);
      }
    }
  };

  return (
    <ModalTodoInput
      mode="create"
      onSubmit={handleSubmit}
      todos={todos}
    />
  );
};
