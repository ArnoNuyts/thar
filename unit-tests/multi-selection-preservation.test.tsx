import { render } from "ink-testing-library";
import { assertEquals } from "@std/assert";
import { useEffect } from "react";
import { Todo } from "../logic/todo.ts";
import { NavigationContextType } from "../contexts/navigation-context.tsx";
import { waitFor } from "./test-utils.ts";
import { MockTodoProvider } from "./mock-todo-provider.tsx";
import { ToasterProvider } from "../contexts/toaster-context.tsx";
import { FocusProvider } from "../contexts/focus-context.tsx";
import { SuggestionProvider } from "../contexts/suggestion-context.tsx";
import { SearchProvider } from "../contexts/search-context.tsx";
import { ModalProvider } from "../contexts/modal-context.tsx";
import {
  NavigationProvider,
  useNavigation,
} from "../contexts/navigation-context.tsx";
import { useTodo } from "../contexts/todo-context.tsx";

const NavigationWrapper = ({ children }: { children: React.ReactNode }) => {
  const { todos } = useTodo();
  return (
    <NavigationProvider todos={todos} listHeightForTest={10}>
      {children}
    </NavigationProvider>
  );
};

const TestWrapper = ({
  children,
  initialTodos = [],
}: {
  children: React.ReactNode;
  initialTodos?: Todo[];
}) => {
  return (
    <ToasterProvider>
      <MockTodoProvider initialTodos={initialTodos}>
        <FocusProvider>
          <SuggestionProvider>
            <SearchProvider>
              <NavigationWrapper>
                <ModalProvider>{children}</ModalProvider>
              </NavigationWrapper>
            </SearchProvider>
          </SuggestionProvider>
        </FocusProvider>
      </MockTodoProvider>
    </ToasterProvider>
  );
};

const SelectionObserver = ({
  onSelectionChange,
}: {
  onSelectionChange: (state: {
    cursorId: symbol | undefined;
    rangeIds: Set<symbol>;
  }) => void;
}) => {
  const { selectedTodoId, selectedTodoIds } = useNavigation();

  useEffect(() => {
    onSelectionChange({
      cursorId: selectedTodoId,
      rangeIds: new Set(selectedTodoIds),
    });
  }, [selectedTodoId, selectedTodoIds, onSelectionChange]);

  return null;
};

const ActionTrigger = ({
  onTrigger,
}: {
  onTrigger: (trigger: () => void) => void;
}) => {
  const { updateTodos, todos } = useTodo();
  const { selectedTodoIds } = useNavigation();

  useEffect(() => {
    onTrigger(() => {
      const todosToUpdate = todos.filter((t) => selectedTodoIds.has(t.id));
      updateTodos(todosToUpdate, (t) => t.setPriority("A"));
    });
  }, [todos, selectedTodoIds, updateTodos, onTrigger]);

  return null;
};

Deno.test({
  name: "Multi-selection preservation after updateTodos",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const todo1 = new Todo("Todo 1");
    const todo2 = new Todo("Todo 2");
    const todo3 = new Todo("Todo 3");
    const initialTodos = [todo1, todo2, todo3];

    let selection: { cursorId: symbol | undefined; rangeIds: Set<symbol> } = {
      cursorId: undefined,
      rangeIds: new Set(),
    };
    let trigger: (() => void) | undefined;

    let navContext: NavigationContextType = null!;
    const NavGetter = () => {
      navContext = useNavigation();
      return null;
    };

    const { unmount } = render(
      <TestWrapper initialTodos={initialTodos}>
        <SelectionObserver onSelectionChange={(s) => (selection = s)} />
        <ActionTrigger onTrigger={(t) => (trigger = t)} />
        <NavGetter />
      </TestWrapper>,
    );

    // Initial state
    await waitFor(() => assertEquals(selection.cursorId, todo1.id));

    // Select todo 1 and todo 2
    navContext.navigateDown(true);
    await waitFor(() => {
      assertEquals(selection.cursorId, todo2.id);
      assertEquals(selection.rangeIds.size, 2);
    });

    // Trigger updateTodos
    trigger!();

    // Verify that selection is preserved
    await waitFor(() => {
      assertEquals(selection.rangeIds.size, 2);
      assertEquals(selection.rangeIds.has(initialTodos[0].id), true);
      assertEquals(selection.rangeIds.has(initialTodos[1].id), true);
    });

    unmount();
  },
});
