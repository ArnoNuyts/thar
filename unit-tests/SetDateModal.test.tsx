import { render } from "ink-testing-library";
import { assertEquals } from "@std/assert";
import { useEffect } from "react";
import { Box } from "ink";
import { format } from "date-fns";

import { SetDateModal } from "../components/SetDateModal.tsx";
import { ModalProvider, useModal } from "../contexts/modal-context.tsx";
import { FocusProvider, useFocusManager } from "../contexts/focus-context.tsx";
import { TodoContext, TodoContextType } from "../contexts/todo-context.tsx";
import {
  NavigationContext,
  NavigationContextType,
} from "../contexts/navigation-context.tsx";
import { Todo } from "../logic/todo.ts";
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
        ...todoValue,
      } as TodoContextType}
    >
      <NavigationContext.Provider
        value={{
          useSelectedTodos: () => [],
          ...navValue,
        } as NavigationContextType}
      >
        <FocusProvider>
          <ModalProvider>
            {children}
          </ModalProvider>
        </FocusProvider>
      </NavigationContext.Provider>
    </TodoContext.Provider>
  );
};

Deno.test("SetDateModal: should render due and set focus", async () => {
  let focused = false;
  let updatedTodo: Todo | undefined;
  const todo = new Todo("Test Todo");

  const TestComponent = () => {
    const { openModal } = useModal();
    useEffect(() => {
      openModal("set-due-date");
    }, []);

    const { activeModal } = useModal();

    return (
      <Box flexDirection="column" height={20}>
        {activeModal === "set-due-date" && <SetDateModal type="due" />}
        <FocusObserver onFocused={() => focused = true} />
      </Box>
    );
  };

  const { unmount, lastFrame, stdin } = render(
    <TestWrapper
      navValue={{ useSelectedTodos: () => [todo] }}
      todoValue={{
        updateTodos: (todos: Todo[], transform: (t: Todo) => Todo) => {
          updatedTodo = transform(todos[0]);
        },
      }}
    >
      <TestComponent />
    </TestWrapper>,
  );

  await waitFor(() =>
    assertEquals(lastFrame()?.includes("Set Due Date"), true)
  );
  await waitFor(() => assertEquals(focused, true));

  // Initial is Today
  stdin.write("\r");

  await waitFor(() => {
    assertEquals(updatedTodo?.tags.due, format(new Date(), "yyyy-MM-dd"));
  });

  unmount();
});

Deno.test("SetDateModal: should render threshold and set focus", async () => {
  let focused = false;
  let updatedTodo: Todo | undefined;
  const todo = new Todo("Test Todo");

  const TestComponent = () => {
    const { openModal } = useModal();
    useEffect(() => {
      openModal("set-threshold-date");
    }, []);

    const { activeModal } = useModal();

    return (
      <Box flexDirection="column" height={20}>
        {activeModal === "set-threshold-date" && (
          <SetDateModal type="threshold" />
        )}
        <FocusObserver onFocused={() => focused = true} />
      </Box>
    );
  };

  const { unmount, lastFrame, stdin } = render(
    <TestWrapper
      navValue={{ useSelectedTodos: () => [todo] }}
      todoValue={{
        updateTodos: (todos: Todo[], transform: (t: Todo) => Todo) => {
          updatedTodo = transform(todos[0]);
        },
      }}
    >
      <TestComponent />
    </TestWrapper>,
  );

  await waitFor(() =>
    assertEquals(lastFrame()?.includes("Set Threshold Date"), true)
  );
  await waitFor(() => assertEquals(focused, true));

  // Initial is Today
  stdin.write("\r");

  await waitFor(() => {
    assertEquals(updatedTodo?.tags.t, format(new Date(), "yyyy-MM-dd"));
  });

  unmount();
});

Deno.test("SetDateModal: should update multiple todos", async () => {
  let focused = false;
  let updatedTodos: Todo[] = [];
  const todo1 = new Todo("Todo 1");
  const todo2 = new Todo("Todo 2");

  const TestComponent = () => {
    const { openModal, activeModal } = useModal();
    useEffect(() => {
      openModal("set-due-date");
    }, [openModal]);

    return (
      <Box flexDirection="column" height={20} width={80}>
        {activeModal === "set-due-date" && <SetDateModal type="due" />}
        <FocusObserver onFocused={() => focused = true} />
      </Box>
    );
  };

  const { unmount, lastFrame, stdin } = render(
    <TestWrapper
      navValue={{
        useSelectedTodos: () => [todo1, todo2],
        useSelectedTodo: () => todo1,
      }}
      todoValue={{
        updateTodos: (todos: Todo[], transform: (t: Todo) => Todo) => {
          updatedTodos = todos.map(transform);
        },
      }}
    >
      <TestComponent />
    </TestWrapper>,
  );

  await waitFor(() =>
    assertEquals(lastFrame()?.includes("Set Due Date"), true)
  );
  await waitFor(() => assertEquals(focused, true));

  // Select Today (default)
  stdin.write("\r");

  await waitFor(() => {
    assertEquals(updatedTodos.length, 2);
    const today = format(new Date(), "yyyy-MM-dd");
    assertEquals(updatedTodos[0].tags.due, today);
    assertEquals(updatedTodos[1].tags.due, today);
  });

  unmount();
});
