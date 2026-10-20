import { expect, test } from "vitest";
import { render } from "ink-testing-library";

import { useEffect } from "react";
import { Box } from "ink";

import { SetRecurrenceModal } from "../components/SetRecurrenceModal.tsx";
import { useModal } from "../contexts/modal-context.tsx";
import { Todo } from "../logic/todo.ts";
import { waitFor } from "./test-utils.ts";
import { FocusObserver, TestWrapper } from "./test-components.tsx";

test("SetRecurrenceModal: should render and set focus", async () => {
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
    expect(lastFrame() || "").toMatch(/Set Recurrence Base/);
    expect(focusedTag).toEqual("set-recurrence-modal");
  });

  // Options are Daily, Weekly, Monthly, Yearly
  // Select Daily (Initial)
  stdin.write("\r");

  await waitFor(() =>
    expect(lastFrame() || "").toMatch(/Set Recurrence Interval \(Daily\)/),
  );

  // Initial amount is "1"
  stdin.write("\r"); // Confirm 1d

  await waitFor(() => {
    expect(updatedTodo?.tags.rec).toEqual("1d");
  });

  unmount();
});

test("SetRecurrenceModal: should update multiple todos", async () => {
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
    expect(lastFrame() || "").toMatch(/Set Recurrence Base/);
    expect(focusedTag).toEqual("set-recurrence-modal");
  });

  // Daily
  stdin.write("\r");
  await waitFor(() =>
    expect(lastFrame() || "").toMatch(/Set Recurrence Interval \(Daily\)/),
  );

  // 1
  stdin.write("\r");

  await waitFor(() => {
    expect(updatedTodos.length).toEqual(2);
    expect(updatedTodos[0].tags.rec).toEqual("1d");
    expect(updatedTodos[1].tags.rec).toEqual("1d");
  });

  unmount();
});

test("SetRecurrenceModal: mouse click should select recurrence base", async () => {
  const todo = new Todo("Mouse Todo");

  const TestComponent = () => {
    const { openModal, activeModal } = useModal();
    useEffect(() => {
      openModal("set-recurrence");
    }, [openModal]);

    return (
      <Box flexDirection="column" height={20} width={80}>
        {activeModal === "set-recurrence" && <SetRecurrenceModal />}
      </Box>
    );
  };

  const { unmount, lastFrame, stdin } = render(
    <TestWrapper navValue={{ getSelectedTodos: () => [todo] }}>
      <TestComponent />
    </TestWrapper>,
  );

  await waitFor(() => expect(lastFrame() || "").toMatch(/Set Recurrence Base/));

  // rows=20, columns=80, width=40, bodyRows=4 => first body row at y=10, x in [21..60]
  stdin.write("\x1b[<0;40;10M");
  await waitFor(() =>
    expect((lastFrame() || "").includes("Set Recurrence Interval")).toEqual(
      true,
    ),
  );
  unmount();
});

test("SetRecurrenceModal: amount should only keep digits", async () => {
  let updatedTodo: Todo | undefined;
  const todo = new Todo("Digits only todo");

  const TestComponent = () => {
    const { openModal, activeModal } = useModal();
    useEffect(() => {
      openModal("set-recurrence");
    }, [openModal]);

    return (
      <Box flexDirection="column" height={20} width={80}>
        {activeModal === "set-recurrence" && <SetRecurrenceModal />}
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

  await waitFor(() => expect(lastFrame() || "").toMatch(/Set Recurrence Base/));
  stdin.write("\r"); // enter amount step with Daily base
  await waitFor(() =>
    expect(lastFrame() || "").toMatch(/Set Recurrence Interval \(Daily\)/),
  );

  // Mix text and a mouse packet; only digits should remain.
  stdin.write("a1b2");
  stdin.write("\x1b[<64;10;5M");
  stdin.write("\r");

  await waitFor(() => {
    expect(updatedTodo?.tags.rec).toEqual("12d");
  });

  unmount();
});

test("SetRecurrenceModal: first typed digit replaces the default amount and resets between bases", async () => {
  let updatedTodo: Todo | undefined;
  const todo = new Todo("Amount editing todo");

  const TestComponent = () => {
    const { openModal, activeModal } = useModal();
    useEffect(() => {
      openModal("set-recurrence");
    }, [openModal]);

    return (
      <Box flexDirection="column" height={20} width={80}>
        {activeModal === "set-recurrence" && <SetRecurrenceModal />}
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

  await waitFor(() => expect(lastFrame() || "").toMatch(/Set Recurrence Base/));

  stdin.write("\r"); // Daily
  await waitFor(() =>
    expect(lastFrame() || "").toMatch(/Set Recurrence Interval \(Daily\)/),
  );

  // Edit the amount (a paste replaces the default "1" then keeps digits),
  // then back out to the base list.
  stdin.write("23");
  await waitFor(() => expect(lastFrame() || "").toMatch(/Every23/));
  stdin.write("\x1b"); // Esc: back to base list

  await waitFor(() => expect(lastFrame() || "").toMatch(/Set Recurrence Base/));

  stdin.write("\u001B[B"); // Down: Weekly
  stdin.write("\r");
  await waitFor(() =>
    expect(lastFrame() || "").toMatch(/Set Recurrence Interval \(Weekly\)/),
  );

  // Choosing a new base resets the amount to "1", so "45" replaces it.
  await waitFor(() => expect(lastFrame() || "").toMatch(/Every1/));
  stdin.write("45");
  await waitFor(() => expect(lastFrame() || "").toMatch(/Every45/));
  stdin.write("\r");

  await waitFor(() => {
    expect(updatedTodo?.tags.rec).toEqual("45w");
  });

  unmount();
});
