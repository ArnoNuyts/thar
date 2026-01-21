import { render } from "ink-testing-library";
import { assertEquals, assertMatch } from "@std/assert";
import { useEffect } from "react";
import { Box } from "ink";

import { EditTodoModal } from "../components/EditTodoModal.tsx";
import { useModal } from "../contexts/modal-context.tsx";
import { Todo } from "../logic/todo.ts";
import { waitFor } from "./test-utils.ts";
import { FocusObserver, TestWrapper } from "./test-components.tsx";

Deno.test("EditTodoModal: should render and set focus", async () => {
  let focusedTag: string | undefined;
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
        <FocusObserver onFocused={(tag) => focusedTag = tag} />
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

  await waitFor(() => {
    assertEquals(focusedTag, "edit-todo-input");
    assertMatch(lastFrame() || "", /Initial Text/);
  });

  stdin.write(" Updated");

  await waitFor(() => {
    assertMatch(lastFrame() || "", /Initial Text Updated/);
  });

  await waitFor(() => {
    stdin.write("\r");
    assertEquals(updatedText, "Initial Text Updated");
  });

  unmount();
});
