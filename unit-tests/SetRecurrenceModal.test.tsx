import { render } from "ink-testing-library";
import { assertEquals, assertMatch } from "@std/assert";
import { useEffect } from "react";
import { Box } from "ink";

import { SetRecurrenceModal } from "../components/SetRecurrenceModal.tsx";
import { useModal } from "../contexts/modal-context.tsx";
import { Todo } from "../logic/todo.ts";
import { waitFor } from "./test-utils.ts";
import { FocusObserver, TestWrapper } from "./test-components.tsx";

Deno.test("SetRecurrenceModal: should render and set focus", async () => {
  let focusedTag: string | undefined;
  let updatedTodo: Todo | undefined;
  const todo = new Todo("Test Todo");

  const TestComponent = () => {
    const { openModal } = useModal();
    useEffect(() => {
      openModal("set-recurrence");
    }, []);

    const { activeModal } = useModal();

    return (
      <Box flexDirection="column" height={20}>
        {activeModal === "set-recurrence" && <SetRecurrenceModal />}
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
    assertMatch(lastFrame() || "", /Set Recurrence Base/);
    assertEquals(focusedTag, "set-recurrence-modal");
  });

  // Options are Daily, Weekly, Monthly, Yearly
  // Select Daily (Initial)
  stdin.write("\r");

  await waitFor(() =>
    assertMatch(lastFrame() || "", /Set Recurrence Interval \(Daily\)/)
  );

  // Initial amount is "1"
  stdin.write("\r"); // Confirm 1d

  await waitFor(() => {
    assertEquals(updatedTodo?.tags.rec, "1d");
  });

  unmount();
});

Deno.test("SetRecurrenceModal: should update multiple todos", async () => {
  let focusedTag: string | undefined;
  let updatedTodos: Todo[] = [];
  const todo1 = new Todo("Todo 1");
  const todo2 = new Todo("Todo 2");

  const TestComponent = () => {
    const { openModal, activeModal } = useModal();
    useEffect(() => {
      openModal("set-recurrence");
    }, [openModal]);

    return (
      <Box flexDirection="column" height={20} width={80}>
        {activeModal === "set-recurrence" && <SetRecurrenceModal />}
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
    assertMatch(lastFrame() || "", /Set Recurrence Base/);
    assertEquals(focusedTag, "set-recurrence-modal");
  });

  // Daily
  stdin.write("\r");
  await waitFor(() =>
    assertMatch(lastFrame() || "", /Set Recurrence Interval \(Daily\)/)
  );

  // 1
  stdin.write("\r");

  await waitFor(() => {
    assertEquals(updatedTodos.length, 2);
    assertEquals(updatedTodos[0].tags.rec, "1d");
    assertEquals(updatedTodos[1].tags.rec, "1d");
  });

  unmount();
});
