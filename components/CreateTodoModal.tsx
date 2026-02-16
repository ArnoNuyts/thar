import { ModalTodoInput } from "./ModalTodoInput.tsx";
import { useTodo } from "../contexts/todo-context.tsx";
import { useNavigation } from "../contexts/navigation-context.tsx";
import { useSearch } from "../contexts/search-context.tsx";
import { extractTagsAndContextsFromSearch } from "../utils/search-utils.ts";

export const CreateTodoModal = () => {
  const { addTodos, todos } = useTodo();
  const { setSelectedTodoId } = useNavigation();
  const { searchQuery } = useSearch();

  const tagsFromSearch = extractTagsAndContextsFromSearch(searchQuery);

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
      initialValue={tagsFromSearch}
      initialCursorPos={0}
      onSubmit={handleSubmit}
      todos={todos}
    />
  );
};
