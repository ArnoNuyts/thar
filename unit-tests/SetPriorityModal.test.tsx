import { expect, test } from "vitest";
import { render } from "ink-testing-library";

import { useEffect } from "react";
import { Box } from "ink";

import { SetPriorityModal } from "../components/SetPriorityModal.tsx";
import { useModal } from "../contexts/modal-context.tsx";
import { Todo } from "../logic/todo.ts";
import { waitFor } from "./test-utils.ts";
import { FocusObserver, TestWrapper } from "./test-components.tsx";

test("SetPriorityModal: should render and set focus", async () => {
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
        <FocusObserver onFocused={(tag) => (focusedTag = tag)} />
      </Box>
    );
  };

  const { unmount, lastFrame, stdin } = render(
    <TestWrapper
      navValue={{ getSelectedTodos: () => [todo] }}
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
    expect(lastFrame() || "").toMatch(/Set Priority/);
    expect(focusedTag).toEqual("set-priority-modal");
  });

  // Options are A, B, C, D, E, F
  // Initial selected is A
  stdin.write("\r"); // Select A

  await waitFor(() => {
    expect(updatedTodo?.priority).toEqual("A");
  });

  unmount();
});

test("SetPriorityModal: should update multiple todos", async () => {
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
        <FocusObserver onFocused={(tag) => (focusedTag = tag)} />
      </Box>
    );
  };

  const { unmount, lastFrame, stdin } = render(
    <TestWrapper
      navValue={{
        getSelectedTodos: () => [todo1, todo2],
        getSelectedTodo: () => todo1,
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
    expect(lastFrame() || "").toMatch(/Set Priority/);
    expect(focusedTag).toEqual("set-priority-modal");
  });

  // Default is 'A', press Enter
  stdin.write("\r");

  await waitFor(() => {
    expect(updatedTodos.length).toEqual(2);
    expect(updatedTodos[0].priority).toEqual("A");
    expect(updatedTodos[1].priority).toEqual("A");
  });

  unmount();
});

test("SetPriorityModal: mouse click should select priority", async () => {
  let updatedTodo: Todo | undefined;
  const todo = new Todo("Mouse Todo");

  const TestComponent = () => {
    const { openModal, activeModal } = useModal();
    useEffect(() => {
      openModal("set-priority");
    }, [openModal]);

    return (
      <Box flexDirection="column" height={20} width={80}>
        {activeModal === "set-priority" && <SetPriorityModal />}
      </Box>
    );
  };

  const { unmount, lastFrame, stdin } = render(
    <TestWrapper
      navValue={{ getSelectedTodos: () => [todo] }}
      todoValue={{
        updateTodos: (todos: Todo[], transform: (t: Todo) => Todo) => {
          updatedTodo = transform(todos[0]);
        },
      }}
    >
      <TestComponent />
    </TestWrapper>,
  );

  await waitFor(() => expect(lastFrame() || "").toMatch(/Set Priority/));

  // rows=20, columns=80, width=30, bodyRows=6 => first body row at y=9, x in [26..55]
  stdin.write("\x1b[<0;40;9M");
  await waitFor(() => expect(updatedTodo?.priority).toEqual("A"));
  unmount();
});

test("SetPriorityModal: integration click maps first row on odd height", async () => {
  let updatedTodo: Todo | undefined;
  const todo = new Todo("Odd Rows Todo A");

  const TestComponent = () => {
    const { openModal, activeModal } = useModal();
    useEffect(() => {
      openModal("set-priority");
    }, [openModal]);

    return (
      <Box flexDirection="column" height={25} width={101}>
        {activeModal === "set-priority" && <SetPriorityModal />}
      </Box>
    );
  };

  const { unmount, lastFrame, stdin } = render(
    <TestWrapper
      navValue={{ getSelectedTodos: () => [todo] }}
      todoValue={{
        updateTodos: (todos: Todo[], transform: (t: Todo) => Todo) => {
          updatedTodo = transform(todos[0]);
        },
      }}
    >
      <TestComponent />
    </TestWrapper>,
  );

  await waitFor(() => expect(lastFrame() || "").toMatch(/Set Priority/));

  // rows=25, columns=101, width=30, bodyRows=6 => first body row at y=11, x in [36..65]
  stdin.write("\x1b[<0;36;11M");

  await waitFor(() => {
    expect(updatedTodo?.priority).toEqual("A");
  });

  unmount();
});

test("SetPriorityModal: integration click maps last row on odd height", async () => {
  let updatedTodo: Todo | undefined;
  const todo = new Todo("Odd Rows Todo F");

  const TestComponent = () => {
    const { openModal, activeModal } = useModal();
    useEffect(() => {
      openModal("set-priority");
    }, [openModal]);

    return (
      <Box flexDirection="column" height={25} width={101}>
        {activeModal === "set-priority" && <SetPriorityModal />}
      </Box>
    );
  };

  const { unmount, lastFrame, stdin } = render(
    <TestWrapper
      navValue={{ getSelectedTodos: () => [todo] }}
      todoValue={{
        updateTodos: (todos: Todo[], transform: (t: Todo) => Todo) => {
          updatedTodo = transform(todos[0]);
        },
      }}
    >
      <TestComponent />
    </TestWrapper>,
  );

  await waitFor(() => expect(lastFrame() || "").toMatch(/Set Priority/));

  // rows=25, columns=101, width=30, bodyRows=6 => last body row at y=16 (index 5 => F)
  stdin.write("\x1b[<0;36;16M");

  await waitFor(() => {
    expect(updatedTodo?.priority).toEqual("F");
  });

  unmount();
});

test("SetPriorityModal: integration click maps first row on even height", async () => {
  let updatedTodo: Todo | undefined;
  const todo = new Todo("Even Rows Todo A");

  const TestComponent = () => {
    const { openModal, activeModal } = useModal();
    useEffect(() => {
      openModal("set-priority");
    }, [openModal]);

    return (
      <Box flexDirection="column" height={24} width={101}>
        {activeModal === "set-priority" && <SetPriorityModal />}
      </Box>
    );
  };

  const { unmount, lastFrame, stdin } = render(
    <TestWrapper
      navValue={{ getSelectedTodos: () => [todo] }}
      todoValue={{
        updateTodos: (todos: Todo[], transform: (t: Todo) => Todo) => {
          updatedTodo = transform(todos[0]);
        },
      }}
    >
      <TestComponent />
    </TestWrapper>,
  );

  await waitFor(() => expect(lastFrame() || "").toMatch(/Set Priority/));

  // rows=24, columns=101, width=30, bodyRows=6 => first body row at y=11
  stdin.write("\x1b[<0;36;11M");

  await waitFor(() => {
    expect(updatedTodo?.priority).toEqual("A");
  });

  unmount();
});

test("SetPriorityModal: integration click maps last row on even height", async () => {
  let updatedTodo: Todo | undefined;
  const todo = new Todo("Even Rows Todo F");

  const TestComponent = () => {
    const { openModal, activeModal } = useModal();
    useEffect(() => {
      openModal("set-priority");
    }, [openModal]);

    return (
      <Box flexDirection="column" height={24} width={101}>
        {activeModal === "set-priority" && <SetPriorityModal />}
      </Box>
    );
  };

  const { unmount, lastFrame, stdin } = render(
    <TestWrapper
      navValue={{ getSelectedTodos: () => [todo] }}
      todoValue={{
        updateTodos: (todos: Todo[], transform: (t: Todo) => Todo) => {
          updatedTodo = transform(todos[0]);
        },
      }}
    >
      <TestComponent />
    </TestWrapper>,
  );

  await waitFor(() => expect(lastFrame() || "").toMatch(/Set Priority/));

  // rows=24, columns=101, width=30, bodyRows=6 => last body row at y=16
  stdin.write("\x1b[<0;36;16M");

  await waitFor(() => {
    expect(updatedTodo?.priority).toEqual("F");
  });

  unmount();
});
