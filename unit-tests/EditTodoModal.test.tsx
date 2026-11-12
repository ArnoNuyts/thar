import { expect, test } from "vitest";
import { render } from "ink-testing-library";

import { useEffect } from "react";
import { Box } from "ink";

import { EditTodoModal } from "../components/EditTodoModal.tsx";
import { useModal } from "../contexts/modal-context.tsx";
import { useToaster } from "../contexts/toaster-context.tsx";
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

test("EditTodoModal: rejects an impossible leading date and stays open", async () => {
  let updateCalls = 0;
  let toast: string | undefined;
  const todo = new Todo("2024-02-30 impossible");

  const TestComponent = () => {
    const { openModal, activeModal } = useModal();
    const { toasterMessage } = useToaster();

    useEffect(() => {
      openModal("edit-todo");
    }, [openModal]);

    useEffect(() => {
      toast = toasterMessage;
    }, [toasterMessage]);

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
        updateTodos: () => {
          updateCalls++;
        },
      }}
    >
      <TestComponent />
    </TestWrapper>,
  );

  await waitFor(() => {
    expect(lastFrame() || "").toMatch(/2024-02-30 impossible/);
  });

  stdin.write("\r");

  await waitFor(() => {
    expect(toast || "").toMatch(/impossible date/i);
  });
  expect(updateCalls).toEqual(0);
  expect(lastFrame() || "").toMatch(/Edit todo/);

  unmount();
});

test("EditTodoModal: rejects overlong text and stays open", async () => {
  let updateCalls = 0;
  let toast: string | undefined;
  let activeModalName: string | null = null;
  const todo = new Todo("a".repeat(2_001));

  const TestComponent = () => {
    const { openModal, activeModal } = useModal();
    const { toasterMessage } = useToaster();

    useEffect(() => {
      openModal("edit-todo");
    }, [openModal]);

    useEffect(() => {
      activeModalName = activeModal;
    }, [activeModal]);

    useEffect(() => {
      toast = toasterMessage;
    }, [toasterMessage]);

    return (
      <Box flexDirection="column" height={20} width={80}>
        {activeModal === "edit-todo" && <EditTodoModal />}
      </Box>
    );
  };

  const { unmount, stdin } = render(
    <TestWrapper
      navValue={{ getSelectedTodo: () => todo }}
      todoValue={{
        updateTodos: () => {
          updateCalls++;
        },
      }}
    >
      <TestComponent />
    </TestWrapper>,
  );

  await waitFor(() => {
    expect(activeModalName).toEqual("edit-todo");
  });

  stdin.write("\r");

  await waitFor(() => {
    expect(toast || "").toMatch(/too long/i);
  });
  expect(updateCalls).toEqual(0);
  expect(activeModalName).toEqual("edit-todo");

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
