import { render } from "ink-testing-library";
import { assertEquals } from "@std/assert";
import { useEffect } from "react";
import { Box } from "ink";

import { CreateTodoModal } from "../components/CreateTodoModal.tsx";
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
        addTodos: () => [],
        todos: new Todos(),
        ...todoValue,
      } as TodoContextType}
    >
      <NavigationContext.Provider
        value={{
          setSelectedTodoId: () => {},
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

Deno.test("CreateTodoModal: should render and handle input", async () => {
  let focused = false;
  let addedText = "";

  const TestComponent = () => {
    const { openModal, activeModal } = useModal();
    useEffect(() => {
      openModal("create-todo");
    }, [openModal]);

    return (
      <Box flexDirection="column" height={20} width={80}>
        {activeModal === "create-todo" && <CreateTodoModal />}
        <FocusObserver onFocused={() => focused = true} />
      </Box>
    );
  };

  const { unmount, lastFrame, stdin } = render(
    <TestWrapper
      todoValue={{
        addTodos: (text: string) => {
          addedText = text;
          return [new Todo(text)];
        },
      }}
    >
      <TestComponent />
    </TestWrapper>,
  );

  // Wait for title and focus
  await waitFor(() => {
    const frame = lastFrame();
    if (!frame?.includes("Create new todo")) throw new Error("Title not found");
    if (!focused) throw new Error("Not focused");
  });

  // Type text
  stdin.write("New Todo Item");

  await waitFor(() => {
    if (!lastFrame()?.includes("New Todo Item")) {
      throw new Error("Typed text not in frame");
    }
  });

  await new Promise((r) => setTimeout(r, 100));
  stdin.write("\r");

  await waitFor(() => {
    assertEquals(addedText, "New Todo Item");
  });

  unmount();
});
