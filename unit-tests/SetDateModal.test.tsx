import { render } from "ink-testing-library";
import { assertEquals, assertMatch } from "@std/assert";
import { useEffect } from "react";
import { Box } from "ink";
import { format } from "date-fns";

import { SetDateModal } from "../components/SetDateModal.tsx";
import { useModal } from "../contexts/modal-context.tsx";
import { Todo } from "../logic/todo.ts";
import { waitFor } from "./test-utils.ts";
import { FocusObserver, TestWrapper } from "./test-components.tsx";

Deno.test("SetDateModal: should render due and set focus", async () => {
  let focusedTag: string | undefined;
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
    assertMatch(lastFrame() || "", /Set Due Date/);
    assertEquals(focusedTag, "set-date-modal");
  });

  // Initial is Today
  stdin.write("\r");

  await waitFor(() => {
    assertEquals(updatedTodo?.tags.due, format(new Date(), "yyyy-MM-dd"));
  });

  unmount();
});

Deno.test("SetDateModal: should render threshold and set focus", async () => {
  let focusedTag: string | undefined;
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
    assertMatch(lastFrame() || "", /Set Threshold Date/);
    assertEquals(focusedTag, "set-date-modal");
  });

  // Initial is Today
  stdin.write("\r");

  await waitFor(() => {
    assertEquals(updatedTodo?.tags.t, format(new Date(), "yyyy-MM-dd"));
  });

  unmount();
});

Deno.test("SetDateModal: should update multiple todos", async () => {
  let focusedTag: string | undefined;
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
    assertMatch(lastFrame() || "", /Set Due Date/);
    assertEquals(focusedTag, "set-date-modal");
  });

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

Deno.test("SetDateModal: mouse click should select an option", async () => {
  let updatedTodo: Todo | undefined;
  const todo = new Todo("Mouse Todo");

  const TestComponent = () => {
    const { openModal, activeModal } = useModal();
    useEffect(() => {
      openModal("set-due-date");
    }, [openModal]);

    return (
      <Box flexDirection="column" height={20} width={80}>
        {activeModal === "set-due-date" && <SetDateModal type="due" />}
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

  await waitFor(() => assertMatch(lastFrame() || "", /Set Due Date/));

  let clicked = false;
  for (let x = 1; x <= 120 && !clicked; x++) {
    for (let y = 1; y <= 40; y++) {
      stdin.write(`\x1b[<0;${x};${y}M`);
      await new Promise((resolve) => setTimeout(resolve, 4));
      if (updatedTodo?.tags.due) {
        clicked = true;
        break;
      }
    }
  }

  assertEquals(clicked, true);
  unmount();
});
