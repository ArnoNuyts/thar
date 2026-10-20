import { expect, test } from "vitest";
import { render } from "ink-testing-library";

import { useEffect } from "react";
import { Box } from "ink";

import { EditTodoModal } from "../components/EditTodoModal.tsx";
import { useModal } from "../contexts/modal-context.tsx";
import { Todo } from "../logic/todo.ts";
import { waitFor } from "./test-utils.ts";
import { FocusObserver, TestWrapper } from "./test-components.tsx";

test("EditTodoModal: should render and set focus", async () => {
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
        <FocusObserver onFocused={(tag) => (focusedTag = tag)} />
      </Box>
    );
  };

  const { unmount, lastFrame, stdin } = render(
    <TestWrapper
      navValue={{ getSelectedTodo: () => todo }}
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
    expect(focusedTag).toEqual("edit-todo-input");
    expect(lastFrame() || "").toMatch(/Initial Text/);
  });

  stdin.write(" ");
  stdin.write("Updated");

  await waitFor(() => {
    expect(lastFrame() || "").toMatch(/Initial Text Updated/);
  });

  stdin.write("\r");
  await waitFor(() => {
    expect(updatedText).toEqual("Initial Text Updated");
  });

  unmount();
});

test("EditTodoModal: preserves tags when editing text", async () => {
  let updatedTodo: Todo | undefined;
  // todo.text has its tags stripped, which is what the modal starts with.
  const todo = new Todo("Initial Text rec:1d due:2026-10-25 t:2026-10-22 h:1");

  const TestComponent = () => {
    const { openModal, activeModal } = useModal();
    useEffect(() => {
      openModal("edit-todo");
    }, [openModal]);

    return (
      <Box flexDirection="column" height={20} width={80}>
        {activeModal === "edit-todo" && <EditTodoModal />}
      </Box>
    );
  };

  const { unmount, lastFrame, stdin } = render(
    <TestWrapper
      navValue={{ getSelectedTodo: () => todo }}
      todoValue={{
        updateTodos: (todosToUpdate: Todo[], transform: (t: Todo) => Todo) => {
          updatedTodo = transform(todosToUpdate[0]);
        },
      }}
    >
      <TestComponent />
    </TestWrapper>,
  );

  await waitFor(() => {
    expect(lastFrame() || "").toMatch(/Initial Text/);
  });

  stdin.write(" ");
  stdin.write("Updated");

  await waitFor(() => {
    expect(lastFrame() || "").toMatch(/Initial Text Updated/);
  });

  stdin.write("\r");
  await waitFor(() => {
    expect(updatedTodo?.text).toEqual("Initial Text Updated");
    expect(updatedTodo?.tags).toEqual({
      rec: "1d",
      due: "2026-10-25",
      t: "2026-10-22",
      h: "1",
    });
  });

  unmount();
});

test("EditTodoModal: tags typed in the modal override preserved tags", async () => {
  let updatedTodo: Todo | undefined;
  const todo = new Todo("Initial Text rec:1d due:2026-10-25");

  const TestComponent = () => {
    const { openModal, activeModal } = useModal();
    useEffect(() => {
      openModal("edit-todo");
    }, [openModal]);

    return (
      <Box flexDirection="column" height={20} width={80}>
        {activeModal === "edit-todo" && <EditTodoModal />}
      </Box>
    );
  };

  const { unmount, lastFrame, stdin } = render(
    <TestWrapper
      navValue={{ getSelectedTodo: () => todo }}
      todoValue={{
        updateTodos: (todosToUpdate: Todo[], transform: (t: Todo) => Todo) => {
          updatedTodo = transform(todosToUpdate[0]);
        },
      }}
    >
      <TestComponent />
    </TestWrapper>,
  );

  await waitFor(() => {
    expect(lastFrame() || "").toMatch(/Initial Text/);
  });

  stdin.write(" ");
  stdin.write("rec:2d");

  await waitFor(() => {
    expect(lastFrame() || "").toMatch(/Initial Text rec:2d/);
  });

  stdin.write("\r");
  await waitFor(() => {
    expect(updatedTodo?.text).toEqual("Initial Text");
    expect(updatedTodo?.tags).toEqual({
      rec: "2d",
      due: "2026-10-25",
    });
  });

  unmount();
});
