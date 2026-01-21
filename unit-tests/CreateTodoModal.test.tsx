import { render } from "ink-testing-library";
import { assertEquals, assertMatch } from "@std/assert";
import { useEffect } from "react";
import { Box } from "ink";

import { CreateTodoModal } from "../components/CreateTodoModal.tsx";
import { useModal } from "../contexts/modal-context.tsx";
import { Todo } from "../logic/todo.ts";
import { waitFor } from "./test-utils.ts";
import { FocusObserver, TestWrapper } from "./test-components.tsx";

Deno.test("CreateTodoModal: should render and handle input", async () => {
  let focusedTag: string | undefined;
  let addedText = "";

  const TestComponent = () => {
    const { openModal, activeModal } = useModal();
    useEffect(() => {
      openModal("create-todo");
    }, [openModal]);

    return (
      <Box flexDirection="column" height={20} width={80}>
        {activeModal === "create-todo" && <CreateTodoModal />}
        <FocusObserver onFocused={(tag) => focusedTag = tag} />
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
    assertMatch(lastFrame() || "", /Create new todo/);
    assertEquals(focusedTag, "create-todo-input");
  });

  // Type text
  stdin.write("New Todo Item");

  await waitFor(() => {
    assertMatch(lastFrame() || "", /New Todo Item/);
  });

  await waitFor(() => {
    stdin.write("\r");
    assertEquals(addedText, "New Todo Item");
  });

  unmount();
});
