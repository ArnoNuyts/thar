import { render } from "ink-testing-library";
import { assertEquals } from "@std/assert";
import { useEffect } from "react";
import { Box } from "ink";

import { EditTodoModal } from "../components/EditTodoModal.tsx";
import { ModalProvider, useModal } from "../contexts/modal-context.tsx";
import { FocusProvider, useFocusManager } from "../contexts/focus-context.tsx";
import { SuggestionProvider } from "../contexts/suggestion-context.tsx";
import { TodoContext, TodoContextType } from "../contexts/todo-context.tsx";
import {
  NavigationContext,
  NavigationContextType,
} from "../contexts/navigation-context.tsx";
import { Todo } from "../logic/todo.ts";
import { Todos } from "../logic/Todos.ts";
import { waitFor } from "./test-utils.ts";

const FocusObserver = ({ onFocused }: { onFocused: () => void }) => {
  const { activeId } = useFocusManager();
  useEffect(() => {
    let timeoutId: number | undefined;
    if (activeId) {
      timeoutId = setTimeout(onFocused, 150);
    }
    return () => {
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [activeId, onFocused]);
  return null;
};

const TestWrapper = ({
  children,
  todoValue = {},
  navValue = {},
}: {
  children: React.ReactNode;
  todoValue?: Partial<TodoContextType>;
  navValue?: Partial<NavigationContextType>;
}) => {
  return (
    <TodoContext.Provider
      value={{
        updateTodos: () => {},
        todos: new Todos(),
        ...todoValue,
      } as TodoContextType}
    >
      <NavigationContext.Provider
        value={{
          useSelectedTodo: () => undefined,
          ...navValue,
        } as NavigationContextType}
      >
        <FocusProvider>
          <SuggestionProvider>
            <ModalProvider>
              {children}
            </ModalProvider>
          </SuggestionProvider>
        </FocusProvider>
      </NavigationContext.Provider>
    </TodoContext.Provider>
  );
};

Deno.test("EditTodoModal: should render and set focus", async () => {
  let focused = false;
  let updatedText = "";
  const todo = new Todo("Initial Text");

  const TestComponent = () => {
    const { openModal, activeModal } = useModal();
    useEffect(() => {
      openModal("edit-todo");
    }, [openModal]);

    return (
      <Box flexDirection="column" height={20} width={80}>
        {activeModal === "edit-todo" && <EditTodoModal />}
        <FocusObserver onFocused={() => focused = true} />
      </Box>
    );
  };

  const { unmount, lastFrame, stdin } = render(
    <TestWrapper
      navValue={{ useSelectedTodo: () => todo }}
      todoValue={{
        updateTodos: (todosToUpdate: Todo[], transform: (t: Todo) => Todo) => {
          const updatedTodo = transform(todosToUpdate[0]);
          updatedText = updatedTodo.text;
        },
      }}
    >
      <TestComponent />
    </TestWrapper>,
  );

  // Wait for title and focus
  await waitFor(() => {
    const frame = lastFrame();
    if (!frame?.includes("Edit todo")) throw new Error("Title not found");
    if (!focused) throw new Error("Not focused");
  });

  // Verify initial text
  await waitFor(() => {
    if (!lastFrame()?.includes("Initial Text")) {
      throw new Error("Initial text not found");
    }
  });

  // Add more text
  stdin.write(" Updated");

  await waitFor(() => {
    if (!lastFrame()?.includes("Initial Text Updated")) {
      throw new Error("Updated text not in frame");
    }
  });

  await new Promise((r) => setTimeout(r, 100));
  stdin.write("\r");

  await waitFor(() => {
    assertEquals(updatedText, "Initial Text Updated");
  });

  unmount();
});
