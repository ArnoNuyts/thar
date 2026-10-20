import { expect, test } from "vitest";
import { render } from "ink-testing-library";

import { useEffect } from "react";
import { Box, Text } from "ink";

import { SetPriorityModal } from "../components/SetPriorityModal.tsx";
import { TodoMenu } from "../components/TodoMenu.tsx";
import { useModal } from "../contexts/modal-context.tsx";
import { Todo } from "../logic/todo.ts";
import { waitFor } from "./test-utils.ts";
import { TestWrapper } from "./test-components.tsx";

const hasHighlight = (frame: string | undefined, label: string) =>
  (frame ?? "").includes(`» ${label}`);

const alwaysSelected = (todo: Todo) => ({
  navValue: { getSelectedTodos: () => [todo] },
});

type PriorityHarness = {
  updatePriority: () => ReturnType<typeof render>;
  getUpdatedPriority: () => string | undefined;
  getActiveModal: () => string | null;
};

const renderPriorityModal = (): PriorityHarness => {
  const todo = new Todo("Select list todo");
  let updatedPriority: string | undefined;
  let activeModal: string | null = null;

  const Host = () => {
    const { openModal } = useModal();
    const modal = useModal().activeModal;

    useEffect(() => {
      openModal("set-priority");
    }, [openModal]);

    useEffect(() => {
      activeModal = modal;
    }, [modal]);

    return (
      <Box flexDirection="column" height={25} width={101}>
        {modal === "set-priority" && <SetPriorityModal />}
      </Box>
    );
  };

  const result = render(
    <TestWrapper
      {...alwaysSelected(todo)}
      todoValue={{
        updateTodos: (todos: Todo[], transform: (t: Todo) => Todo) => {
          updatedPriority = transform(todos[0]).priority;
        },
      }}
    >
      <Host />
    </TestWrapper>,
  );

  return {
    updatePriority: () => result,
    getUpdatedPriority: () => updatedPriority,
    getActiveModal: () => activeModal,
  };
};

test("select list: up/down wrap around at both ends", async () => {
  const harness = renderPriorityModal();
  const { stdin, lastFrame, unmount } = harness.updatePriority();

  await waitFor(() => expect(hasHighlight(lastFrame(), "A")).toEqual(true));

  // Up from the first item wraps to the last item.
  stdin.write("\x1b[A");
  await waitFor(() => expect(hasHighlight(lastFrame(), "F")).toEqual(true));

  // Down from the last item wraps back to the first.
  stdin.write("\x1b[B");
  await waitFor(() => expect(hasHighlight(lastFrame(), "A")).toEqual(true));

  // Normal movement in both directions still works.
  stdin.write("\x1b[B");
  await waitFor(() => expect(hasHighlight(lastFrame(), "B")).toEqual(true));
  stdin.write("\x1b[A");
  await waitFor(() => expect(hasHighlight(lastFrame(), "A")).toEqual(true));

  unmount();
});

test("select list: enter selects the highlighted item", async () => {
  const harness = renderPriorityModal();
  const { stdin, lastFrame, unmount } = harness.updatePriority();

  await waitFor(() => expect(hasHighlight(lastFrame(), "A")).toEqual(true));

  stdin.write("\x1b[A"); // wrap to F
  await waitFor(() => expect(hasHighlight(lastFrame(), "F")).toEqual(true));

  stdin.write("\r");
  await waitFor(() => expect(harness.getUpdatedPriority()).toEqual("F"));
  await waitFor(() => expect(harness.getActiveModal()).toEqual(null));

  unmount();
});

test("select list: escape cancels without selecting", async () => {
  const harness = renderPriorityModal();
  const { stdin, lastFrame, unmount } = harness.updatePriority();

  await waitFor(() => expect(hasHighlight(lastFrame(), "A")).toEqual(true));

  stdin.write("\x1b[B"); // move to B, but do not select it
  await waitFor(() => expect(hasHighlight(lastFrame(), "B")).toEqual(true));

  stdin.write("\x1b");
  await waitFor(() => expect(harness.getActiveModal()).toEqual(null));
  expect(harness.getUpdatedPriority()).toEqual(undefined);

  unmount();
});

test("select list: mouse hover changes the highlighted item", async () => {
  const harness = renderPriorityModal();
  const { stdin, lastFrame, unmount } = harness.updatePriority();

  await waitFor(() => expect(hasHighlight(lastFrame(), "A")).toEqual(true));

  // rows=25, columns=101, width=30, bodyRows=6: F is the last body row (y=16).
  stdin.write("\x1b[<35;36;16M");
  await waitFor(() => expect(hasHighlight(lastFrame(), "F")).toEqual(true));
  // Hovering only moves the marker; it must not select.
  expect(harness.getUpdatedPriority()).toEqual(undefined);
  expect(harness.getActiveModal()).toEqual("set-priority");

  // Move back over the first row (y=11).
  stdin.write("\x1b[<35;36;11M");
  await waitFor(() => expect(hasHighlight(lastFrame(), "A")).toEqual(true));

  unmount();
});

test("select list: mouse click selects the clicked item", async () => {
  const harness = renderPriorityModal();
  const { stdin, lastFrame, unmount } = harness.updatePriority();

  await waitFor(() => expect(hasHighlight(lastFrame(), "A")).toEqual(true));

  // rows=25, columns=101, width=30, bodyRows=6: C is the third body row (y=13).
  stdin.write("\x1b[<0;36;13M");
  await waitFor(() => expect(harness.getUpdatedPriority()).toEqual("C"));
  await waitFor(() => expect(harness.getActiveModal()).toEqual(null));

  unmount();
});

const renderTodoMenu = () => {
  const todo = new Todo("Menu todo");
  let activeModal: string | null = null;
  let toggled: Todo[] = [];

  const Host = () => {
    const { openModal, activeModal: modal } = useModal();

    useEffect(() => {
      openModal("todo-menu");
    }, [openModal]);

    useEffect(() => {
      activeModal = modal;
    }, [modal]);

    return (
      <Box flexDirection="column" height={25} width={101}>
        {modal === "todo-menu" && <TodoMenu />}
        {modal === "edit-todo" && <Text>Edit Todo Modal</Text>}
      </Box>
    );
  };

  const result = render(
    <TestWrapper
      {...alwaysSelected(todo)}
      todoValue={{
        toggleTodos: (todos: Todo[]) => {
          toggled = todos;
        },
      }}
    >
      <Host />
    </TestWrapper>,
  );

  return {
    ...result,
    getActiveModal: () => activeModal,
    getToggled: () => toggled,
  };
};

test("select list: menu wraps and enter runs the highlighted action", async () => {
  const menu = renderTodoMenu();
  const { stdin, lastFrame, unmount } = menu;

  await waitFor(() => expect(hasHighlight(lastFrame(), "Edit")).toEqual(true));

  // Up from Edit wraps to the last menu item.
  stdin.write("\x1b[A");
  await waitFor(() => expect(hasHighlight(lastFrame(), "Paste")).toEqual(true));

  // Down from the last item wraps back to Edit.
  stdin.write("\x1b[B");
  await waitFor(() => expect(hasHighlight(lastFrame(), "Edit")).toEqual(true));

  // Move to "Toggle Complete" and run it with Enter.
  stdin.write("\x1b[B");
  stdin.write("\x1b[B");
  await waitFor(() =>
    expect(hasHighlight(lastFrame(), "Toggle Complete")).toEqual(true),
  );
  stdin.write("\r");
  await waitFor(() => expect(menu.getToggled().length).toEqual(1));

  unmount();
});

test("select list: menu escape closes without running an action", async () => {
  const menu = renderTodoMenu();
  const { stdin, lastFrame, unmount } = menu;

  await waitFor(() => expect(hasHighlight(lastFrame(), "Edit")).toEqual(true));

  stdin.write("\x1b");
  await waitFor(() => expect(menu.getActiveModal()).toEqual(null));
  expect(menu.getToggled().length).toEqual(0);
  expect((lastFrame() ?? "").includes("Edit Todo Modal")).toEqual(false);

  unmount();
});
