import { render } from "ink-testing-library";
import { assertEquals, assertMatch } from "@std/assert";
import { useEffect } from "react";
import { Box } from "ink";

import { SetPriorityModal } from "../components/SetPriorityModal.tsx";
import { useModal } from "../contexts/modal-context.tsx";
import { Todo } from "../logic/todo.ts";
import { waitFor } from "./test-utils.ts";
import { FocusObserver, TestWrapper } from "./test-components.tsx";

Deno.test("SetPriorityModal: should render and set focus", async () => {
  let focusedTag: string | undefined;
  let updatedTodo: Todo | undefined;
  const todo = new Todo("Test Todo");

  const TestComponent = () => {
    const { openModal } = useModal();
    useEffect(() => {
      openModal("set-priority");
    }, []);

    const { activeModal } = useModal();

    return (
      <Box flexDirection="column" height={20}>
        {activeModal === "set-priority" && <SetPriorityModal />}
        <FocusObserver onFocused={(tag) => focusedTag = tag} />
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

  await waitFor(() => {
    assertMatch(lastFrame() || "", /Set Priority/);
    assertEquals(focusedTag, "set-priority-modal");
  });

  // Options are A, B, C, D, E, F
  // Initial selected is A
  stdin.write("\r"); // Select A

  await waitFor(() => {
    assertEquals(updatedTodo?.priority, "A");
  });

  unmount();
});

Deno.test("SetPriorityModal: should update multiple todos", async () => {
  let focusedTag: string | undefined;
  let updatedTodos: Todo[] = [];
  const todo1 = new Todo("Todo 1");
  const todo2 = new Todo("Todo 2");

  const TestComponent = () => {
    const { openModal, activeModal } = useModal();
    useEffect(() => {
      openModal("set-priority");
    }, [openModal]);

    return (
      <Box flexDirection="column" height={20}>
        {activeModal === "set-priority" && <SetPriorityModal />}
        <FocusObserver onFocused={(tag) => focusedTag = tag} />
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

  await waitFor(() => {
    assertMatch(lastFrame() || "", /Set Priority/);
    assertEquals(focusedTag, "set-priority-modal");
  });

  // Default is 'A', press Enter
  stdin.write("\r");

  await waitFor(() => {
    assertEquals(updatedTodos.length, 2);
    assertEquals(updatedTodos[0].priority, "A");
    assertEquals(updatedTodos[1].priority, "A");
  });

  unmount();
});
