import { expect, test } from "vitest";
import { render } from "ink-testing-library";

import { useEffect } from "react";
import { Box } from "ink";
import { addDays, addMonths, format, startOfDay } from "date-fns";

import { SetDateModal } from "../components/SetDateModal.tsx";
import { useModal } from "../contexts/modal-context.tsx";
import { Todo } from "../logic/todo.ts";
import { waitFor } from "./test-utils.ts";
import { FocusObserver, TestWrapper } from "./test-components.tsx";

test("SetDateModal: should render due and set focus", async () => {
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
    expect(lastFrame() || "").toMatch(/Set Due Date/);
    expect(focusedTag).toEqual("set-date-modal");
  });

  // Initial is Today
  stdin.write("\r");

  await waitFor(() => {
    expect(updatedTodo?.tags.due).toEqual(format(new Date(), "yyyy-MM-dd"));
  });

  unmount();
});

test("SetDateModal: should render threshold and set focus", async () => {
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
    expect(lastFrame() || "").toMatch(/Set Threshold Date/);
    expect(focusedTag).toEqual("set-date-modal");
  });

  // Initial is Today
  stdin.write("\r");

  await waitFor(() => {
    expect(updatedTodo?.tags.t).toEqual(format(new Date(), "yyyy-MM-dd"));
  });

  unmount();
});

test("SetDateModal: should update multiple todos", async () => {
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
    expect(lastFrame() || "").toMatch(/Set Due Date/);
    expect(focusedTag).toEqual("set-date-modal");
  });

  // Select Today (default)
  stdin.write("\r");

  await waitFor(() => {
    expect(updatedTodos.length).toEqual(2);
    const today = format(new Date(), "yyyy-MM-dd");
    expect(updatedTodos[0].tags.due).toEqual(today);
    expect(updatedTodos[1].tags.due).toEqual(today);
  });

  unmount();
});

test("SetDateModal: mouse click should select an option", async () => {
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

  await waitFor(() => expect(lastFrame() || "").toMatch(/Set Due Date/));

  // rows=20, columns=80, width=40, bodyRows=5 => first body row at y=9, x in [21..60]
  stdin.write("\x1b[<0;40;9M");
  await waitFor(() => expect(typeof updatedTodo?.tags.due).toEqual("string"));
  unmount();
});

const renderDateModal = (type: "due" | "threshold", todos: Todo[]) => {
  let updatedTodos: Todo[] = [];
  const modalName = type === "due" ? "set-due-date" : "set-threshold-date";

  const TestComponent = () => {
    const { openModal, activeModal } = useModal();
    useEffect(() => {
      openModal(modalName);
    }, [openModal]);

    return (
      <Box flexDirection="column" height={20} width={80}>
        {activeModal === modalName && <SetDateModal type={type} />}
      </Box>
    );
  };

  const rendered = render(
    <TestWrapper
      navValue={{ getSelectedTodos: () => todos }}
      todoValue={{
        updateTodos: (selected: Todo[], transform: (t: Todo) => Todo) => {
          updatedTodos = selected.map(transform);
        },
      }}
    >
      <TestComponent />
    </TestWrapper>,
  );

  return { ...rendered, getUpdatedTodos: () => updatedTodos };
};

type DateModalHarness = ReturnType<typeof renderDateModal>;

/** Press down once and wait until `label` is the highlighted row. */
const pressDownTo = async (harness: DateModalHarness, label: string) => {
  harness.stdin.write("\x1b[B");
  await waitFor(() =>
    expect((harness.lastFrame() || "").includes(`» ${label}`)).toEqual(true),
  );
};

const moveToCustom = async (harness: DateModalHarness) => {
  await pressDownTo(harness, "Tomorrow");
  await pressDownTo(harness, "Next Week");
  await pressDownTo(harness, "Next Month");
  await pressDownTo(harness, "Custom");
  // Confirm the row to open the calendar step.
  harness.stdin.write("\r");
  await waitFor(() =>
    expect((harness.lastFrame() || "").includes("Selected:")).toEqual(true),
  );
};

test("SetDateModal: custom calendar starts on the due tag date", async () => {
  const todo = new Todo("Task due:2024-05-06");
  const harness = renderDateModal("due", [todo]);
  const { unmount, lastFrame } = harness;

  await waitFor(() => expect(lastFrame() || "").toMatch(/Set Due Date/));
  await moveToCustom(harness);

  await waitFor(() =>
    expect((lastFrame() || "").includes("Selected: 2024-05-06")).toEqual(true),
  );

  unmount();
});

test("SetDateModal: custom calendar starts on the threshold tag date", async () => {
  const todo = new Todo("Task t:2024-02-29");
  const harness = renderDateModal("threshold", [todo]);
  const { unmount, lastFrame } = harness;

  await waitFor(() => expect(lastFrame() || "").toMatch(/Set Threshold Date/));
  await moveToCustom(harness);

  await waitFor(() =>
    expect((lastFrame() || "").includes("Selected: 2024-02-29")).toEqual(true),
  );

  unmount();
});

test("SetDateModal: invalid custom date tag falls back to today", async () => {
  // The old manual split/Date construction rendered "Invalid Date" here.
  const todo = new Todo("Task due:not-a-date");
  const harness = renderDateModal("due", [todo]);
  const { unmount, lastFrame } = harness;

  await waitFor(() => expect(lastFrame() || "").toMatch(/Set Due Date/));
  await moveToCustom(harness);

  const today = format(new Date(), "yyyy-MM-dd");
  await waitFor(() =>
    expect((lastFrame() || "").includes(`Selected: ${today}`)).toEqual(true),
  );

  unmount();
});

test("SetDateModal: due option writes the due tag only", async () => {
  const todo = new Todo("Task");
  const harness = renderDateModal("due", [todo]);
  const { unmount, stdin, lastFrame } = harness;

  await waitFor(() => expect(lastFrame() || "").toMatch(/Set Due Date/));
  await pressDownTo(harness, "Tomorrow");
  stdin.write("\r");

  const tomorrow = format(addDays(startOfDay(new Date()), 1), "yyyy-MM-dd");
  await waitFor(() => {
    const updated = harness.getUpdatedTodos()[0];
    expect(updated.tags.due).toEqual(tomorrow);
    expect(updated.tags.t).toEqual(undefined);
  });

  unmount();
});

test("SetDateModal: threshold option writes the threshold tag only", async () => {
  const todo = new Todo("Task due:2024-05-06");
  const harness = renderDateModal("threshold", [todo]);
  const { unmount, stdin, lastFrame } = harness;

  await waitFor(() => expect(lastFrame() || "").toMatch(/Set Threshold Date/));
  await pressDownTo(harness, "Tomorrow");
  stdin.write("\r");

  const tomorrow = format(addDays(startOfDay(new Date()), 1), "yyyy-MM-dd");
  await waitFor(() => {
    const updated = harness.getUpdatedTodos()[0];
    expect(updated.tags.t).toEqual(tomorrow);
    expect(updated.tags.due).toEqual("2024-05-06");
  });

  unmount();
});

test("SetDateModal: reset removes the due tag only", async () => {
  const todo = new Todo("Task due:2024-05-06 t:2024-05-07");
  const harness = renderDateModal("due", [todo]);
  const { unmount, stdin, lastFrame } = harness;

  await waitFor(() => expect(lastFrame() || "").toMatch(/Set Due Date/));
  // Up from Today wraps to the appended Reset row.
  stdin.write("\x1b[A");
  await waitFor(() =>
    expect((lastFrame() || "").includes("» Reset")).toEqual(true),
  );
  stdin.write("\r");

  await waitFor(() => {
    const updated = harness.getUpdatedTodos()[0];
    expect(updated.tags.due).toEqual(undefined);
    expect(updated.tags.t).toEqual("2024-05-07");
  });

  unmount();
});

test("SetDateModal: reset removes the threshold tag only", async () => {
  const todo = new Todo("Task due:2024-05-06 t:2024-05-07");
  const harness = renderDateModal("threshold", [todo]);
  const { unmount, stdin, lastFrame } = harness;

  await waitFor(() => expect(lastFrame() || "").toMatch(/Set Threshold Date/));
  stdin.write("\x1b[A");
  await waitFor(() =>
    expect((lastFrame() || "").includes("» Reset")).toEqual(true),
  );
  stdin.write("\r");

  await waitFor(() => {
    const updated = harness.getUpdatedTodos()[0];
    expect(updated.tags.t).toEqual(undefined);
    expect(updated.tags.due).toEqual("2024-05-06");
  });

  unmount();
});

test("SetDateModal: Next Month uses addMonths semantics", async () => {
  const todo = new Todo("Task");
  const harness = renderDateModal("due", [todo]);
  const { unmount, stdin, lastFrame } = harness;

  await waitFor(() => expect(lastFrame() || "").toMatch(/Set Due Date/));
  await pressDownTo(harness, "Tomorrow");
  await pressDownTo(harness, "Next Week");
  await pressDownTo(harness, "Next Month");
  stdin.write("\r");

  const nextMonth = format(addMonths(startOfDay(new Date()), 1), "yyyy-MM-dd");
  await waitFor(() =>
    expect(harness.getUpdatedTodos()[0].tags.due).toEqual(nextMonth),
  );

  unmount();
});
