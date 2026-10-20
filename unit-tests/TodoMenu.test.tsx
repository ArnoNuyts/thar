import { Runtime } from "../utils/runtime.ts";
import { expect, test } from "vitest";
import { render } from "ink-testing-library";

import { useEffect } from "react";
import { Box, Text } from "ink";

import { Todo } from "../logic/todo.ts";
import { waitFor } from "./test-utils.ts";

import { MultiSelectMenu, TodoMenu } from "../components/TodoMenu.tsx";
import { useModal } from "../contexts/modal-context.tsx";
import { useToaster } from "../contexts/toaster-context.tsx";
import { ConfirmModal } from "../components/ConfirmModal.tsx";
import { isConfirmModalData } from "../contexts/modal-context.tsx";
import { FocusObserver, TestWrapper } from "./test-components.tsx";

const AppContentMock = () => {
  const { activeModal, modalData } = useModal();
  const { toasterMessage } = useToaster();
  return (
    <Box flexDirection="column" height={25} position="relative">
      <Box>
        <Text>Todo List Placeholder (Mocked)</Text>
        {toasterMessage && (
          <Text color="yellow">TOASTER: {toasterMessage}</Text>
        )}
      </Box>
      {activeModal === "todo-menu" && <TodoMenu />}
      {activeModal === "multi-select-menu" && <MultiSelectMenu />}
      {activeModal === "confirm-modal" && isConfirmModalData(modalData) && (
        <ConfirmModal
          title={modalData.title}
          message={modalData.message}
          onConfirm={modalData.onConfirm}
          onCancel={modalData.onCancel}
        />
      )}
      {activeModal === "edit-todo" && <Text>Edit Todo Modal</Text>}
      {activeModal === "set-due-date" && <Text>Set Due Date Modal</Text>}
      {activeModal === "set-threshold-date" && (
        <Text>Set Threshold Date Modal</Text>
      )}
      {activeModal === "set-recurrence" && <Text>Set Recurrence Modal</Text>}
      {activeModal === "set-priority" && <Text>Set Priority Modal</Text>}
    </Box>
  );
};

function ModalTrigger() {
  const { openModal } = useModal();
  useEffect(() => {
    openModal("todo-menu");
  }, []);
  return null;
}

function MultiSelectMenuTrigger() {
  const { openModal } = useModal();
  useEffect(() => {
    openModal("multi-select-menu");
  }, []);
  return null;
}

test("MultiSelectMenu: should show only selection-wide actions", async () => {
  const todo1 = new Todo("Todo 1");
  const todo2 = new Todo("Todo 2");
  let toggledTodos: Todo[] = [];

  let focusCount = 0;
  const { unmount, stdin, lastFrame } = render(
    <TestWrapper
      todoValue={{ toggleTodos: (todos: Todo[]) => (toggledTodos = todos) }}
      navValue={{
        getSelectedTodos: () => [todo1, todo2],
        getSelectedTodo: () => todo1,
      }}
    >
      <AppContentMock />
      <MultiSelectMenuTrigger />
      <FocusObserver onFocused={() => focusCount++} />
    </TestWrapper>,
  );

  await waitFor(() => expect(focusCount >= 1).toEqual(true));
  await waitFor(() =>
    expect(lastFrame()?.includes("Multi-select menu")).toEqual(true),
  );

  const frame = lastFrame() ?? "";
  expect(frame.includes("Edit")).toEqual(false);
  expect(frame.includes("Archive Completed")).toEqual(false);
  expect(frame.includes("Undo")).toEqual(false);
  expect(frame.includes("Redo")).toEqual(false);
  expect(frame.includes("Paste")).toEqual(false);

  stdin.write(" ");
  await waitFor(() => {
    expect(toggledTodos.length).toEqual(2);
    expect(toggledTodos[0].text).toEqual("Todo 1");
    expect(toggledTodos[1].text).toEqual("Todo 2");
  });

  unmount();
});

test("TodoMenu: should call toggleTodos for all selected items (Mocked)", async () => {
  const todo1 = new Todo("Todo 1");
  const todo2 = new Todo("Todo 2");
  let toggledTodos: Todo[] = [];

  let focusCount = 0;
  const { unmount, stdin, lastFrame } = render(
    <TestWrapper
      todoValue={{ toggleTodos: (todos: Todo[]) => (toggledTodos = todos) }}
      navValue={{
        getSelectedTodos: () => [todo1, todo2],
        getSelectedTodo: () => todo1,
      }}
    >
      <AppContentMock />
      <ModalTrigger />
      <FocusObserver onFocused={() => focusCount++} />
    </TestWrapper>,
  );

  await waitFor(() => expect(focusCount >= 1).toEqual(true));
  await waitFor(() => expect(lastFrame()?.includes("Todo menu")).toEqual(true));

  stdin.write(" "); // Space to toggle

  await waitFor(() => {
    expect(toggledTodos.length).toEqual(2);
    expect(toggledTodos[0].text).toEqual("Todo 1");
    expect(toggledTodos[1].text).toEqual("Todo 2");
  });

  unmount();
});

test("TodoMenu: should call deleteTodos after real confirmation (Mocked)", async () => {
  const todo1 = new Todo("Todo 1");
  const todo2 = new Todo("Todo 2");
  let deletedTodos: Todo[] = [];

  let focusCount = 0;
  const { unmount, stdin, lastFrame } = render(
    <TestWrapper
      todoValue={{ deleteTodos: (todos: Todo[]) => (deletedTodos = todos) }}
      navValue={{
        getSelectedTodos: () => [todo1, todo2],
        getSelectedTodo: () => todo1,
      }}
    >
      <AppContentMock />
      <ModalTrigger />
      <FocusObserver onFocused={() => focusCount++} />
    </TestWrapper>,
  );

  await waitFor(() => expect(focusCount >= 1).toEqual(true));
  await waitFor(() => expect(lastFrame()?.includes("Todo menu")).toEqual(true));

  stdin.write("\x1b[3~"); // Delete key

  await waitFor(() =>
    expect(
      lastFrame()?.includes("Are you sure you want to delete 2 todos?"),
    ).toEqual(true),
  );
  await waitFor(() => expect(focusCount >= 2).toEqual(true)); // Wait for confirm modal focus

  stdin.write("\r"); // Confirm

  await waitFor(() => {
    expect(deletedTodos.length).toEqual(2);
  });

  unmount();
});

test("TodoMenu: should call archiveCompletedTodos (Mocked)", async () => {
  let archived = false;

  let focusCount = 0;
  const { unmount, stdin, lastFrame } = render(
    <TestWrapper
      todoValue={{
        archiveCompletedTodos: () => {
          archived = true;
          return Promise.resolve();
        },
      }}
    >
      <AppContentMock />
      <ModalTrigger />
      <FocusObserver onFocused={() => focusCount++} />
    </TestWrapper>,
  );

  await waitFor(() => expect(focusCount >= 1).toEqual(true));
  await waitFor(() => expect(lastFrame()?.includes("Todo menu")).toEqual(true));

  stdin.write("a"); // a to archive

  await waitFor(() =>
    expect(
      lastFrame()?.includes("Archive all completed todos to done.txt?"),
    ).toEqual(true),
  );
  await waitFor(() => expect(focusCount >= 2).toEqual(true)); // Wait for confirm modal focus

  stdin.write("\r"); // Confirm

  await waitFor(() => {
    expect(archived).toEqual(true);
  });

  unmount();
});

test("TodoMenu: should call toggleHidden (Mocked)", async () => {
  const todo1 = new Todo("Todo 1");
  let toggledHidden: Todo[] = [];

  let isFocused = false;
  const { unmount, stdin, lastFrame } = render(
    <TestWrapper
      todoValue={{ toggleHidden: (todos: Todo[]) => (toggledHidden = todos) }}
      navValue={{
        getSelectedTodos: () => [todo1],
        getSelectedTodo: () => todo1,
      }}
    >
      <AppContentMock />
      <ModalTrigger />
      <FocusObserver onFocused={() => (isFocused = true)} />
    </TestWrapper>,
  );

  await waitFor(() => expect(isFocused).toEqual(true));
  await waitFor(() => expect(lastFrame()?.includes("Todo menu")).toEqual(true));

  stdin.write("h"); // h to toggle hidden

  await waitFor(() => {
    expect(toggledHidden.length).toEqual(1);
  });

  unmount();
});

test("TodoMenu: should open edit-todo modal", async () => {
  const todo1 = new Todo("Todo 1");
  let focusCount = 0;
  const { unmount, stdin, lastFrame } = render(
    <TestWrapper
      navValue={{
        getSelectedTodos: () => [todo1],
        getSelectedTodo: () => todo1,
      }}
    >
      <AppContentMock />
      <ModalTrigger />
      <FocusObserver onFocused={() => focusCount++} />
    </TestWrapper>,
  );

  await waitFor(() => expect(focusCount >= 1).toEqual(true));
  await waitFor(() => expect(lastFrame()?.includes("Todo menu")).toEqual(true));
  stdin.write("e");
  await waitFor(() =>
    expect(lastFrame()?.includes("Edit Todo Modal")).toEqual(true),
  );
  unmount();
});

test("TodoMenu: single mouse click should trigger menu item action", async () => {
  const todo1 = new Todo("Todo 1");
  let focusCount = 0;
  const { unmount, stdin, lastFrame } = render(
    <TestWrapper
      navValue={{
        getSelectedTodos: () => [todo1],
        getSelectedTodo: () => todo1,
      }}
    >
      <AppContentMock />
      <ModalTrigger />
      <FocusObserver onFocused={() => focusCount++} />
    </TestWrapper>,
  );

  await waitFor(() => expect(focusCount >= 1).toEqual(true));
  await waitFor(() => expect(lastFrame()?.includes("Todo menu")).toEqual(true));

  // Frame snapshot shows the "Edit" row sitting at y=6 when the menu is open (x=40 is within the modal body).
  stdin.write("\x1b[<0;40;6M");
  await waitFor(() =>
    expect(lastFrame()?.includes("Edit Todo Modal")).toEqual(true),
  );
  unmount();
});

test("TodoMenu: should open set-due-date modal", async () => {
  let focusCount = 0;
  const { unmount, stdin, lastFrame } = render(
    <TestWrapper>
      <AppContentMock />
      <ModalTrigger />
      <FocusObserver onFocused={() => focusCount++} />
    </TestWrapper>,
  );

  await waitFor(() => expect(focusCount >= 1).toEqual(true));
  stdin.write("d");
  await waitFor(() =>
    expect(lastFrame()?.includes("Set Due Date Modal")).toEqual(true),
  );
  unmount();
});

test("TodoMenu: should open set-threshold-date modal", async () => {
  let focusCount = 0;
  const { unmount, stdin, lastFrame } = render(
    <TestWrapper>
      <AppContentMock />
      <ModalTrigger />
      <FocusObserver onFocused={() => focusCount++} />
    </TestWrapper>,
  );

  await waitFor(() => expect(focusCount >= 1).toEqual(true));
  stdin.write("t");
  await waitFor(() =>
    expect(lastFrame()?.includes("Set Threshold Date Modal")).toEqual(true),
  );
  unmount();
});

test("TodoMenu: should open set-recurrence modal", async () => {
  let focusCount = 0;
  const { unmount, stdin, lastFrame } = render(
    <TestWrapper>
      <AppContentMock />
      <ModalTrigger />
      <FocusObserver onFocused={() => focusCount++} />
    </TestWrapper>,
  );

  await waitFor(() => expect(focusCount >= 1).toEqual(true));
  stdin.write("r");
  await waitFor(() =>
    expect(lastFrame()?.includes("Set Recurrence Modal")).toEqual(true),
  );
  unmount();
});

test("TodoMenu: should open set-priority modal", async () => {
  let focusCount = 0;
  const { unmount, stdin, lastFrame } = render(
    <TestWrapper>
      <AppContentMock />
      <ModalTrigger />
      <FocusObserver onFocused={() => focusCount++} />
    </TestWrapper>,
  );

  await waitFor(() => expect(focusCount >= 1).toEqual(true));
  stdin.write("p");
  await waitFor(() =>
    expect(lastFrame()?.includes("Set Priority Modal")).toEqual(true),
  );
  unmount();
});

test("TodoMenu: should call toggleShowHidden", async () => {
  let focusCount = 0;
  let toggledShowHidden = false;
  const { unmount, stdin } = render(
    <TestWrapper
      navValue={{ toggleShowHidden: () => (toggledShowHidden = true) }}
    >
      <AppContentMock />
      <ModalTrigger />
      <FocusObserver onFocused={() => focusCount++} />
    </TestWrapper>,
  );

  await waitFor(() => expect(focusCount >= 1).toEqual(true));
  stdin.write("H");
  await waitFor(() => expect(toggledShowHidden).toEqual(true));
  unmount();
});

test("TodoMenu: should call undo", async () => {
  let focusCount = 0;
  let undid = false;
  const { unmount, stdin } = render(
    <TestWrapper todoValue={{ undo: () => (undid = true) }}>
      <AppContentMock />
      <ModalTrigger />
      <FocusObserver onFocused={() => focusCount++} />
    </TestWrapper>,
  );

  await waitFor(() => expect(focusCount >= 1).toEqual(true));
  stdin.write("z");
  await waitFor(() => expect(undid).toEqual(true));
  unmount();
});

test("TodoMenu: should call redo", async () => {
  let focusCount = 0;
  let redid = false;
  const { unmount, stdin } = render(
    <TestWrapper todoValue={{ redo: () => (redid = true) }}>
      <AppContentMock />
      <ModalTrigger />
      <FocusObserver onFocused={() => focusCount++} />
    </TestWrapper>,
  );

  await waitFor(() => expect(focusCount >= 1).toEqual(true));
  stdin.write("Z");
  await waitFor(() => expect(redid).toEqual(true));
  unmount();
});

test("TodoMenu: should call copy", async () => {
  const originalCommand = (Runtime as any).Command;
  let testUnmount: (() => void) | undefined;
  try {
    (Runtime as any).Command = class {
      constructor() {}
      spawn() {
        return {
          stdin: {
            getWriter: () => ({
              write: () => Promise.resolve(),
              close: () => Promise.resolve(),
              releaseLock: () => {},
            }),
          },
          status: Promise.resolve({ success: true, code: 0 }),
        };
      }
    };

    const todo1 = new Todo("Todo 1");
    let focusCount = 0;
    const { unmount, stdin, lastFrame } = render(
      <TestWrapper
        navValue={{
          getSelectedTodos: () => [todo1],
          getSelectedTodo: () => todo1,
        }}
      >
        <AppContentMock />
        <ModalTrigger />
        <FocusObserver onFocused={() => focusCount++} />
      </TestWrapper>,
    );
    testUnmount = unmount;

    await waitFor(() => expect(focusCount >= 1).toEqual(true));
    stdin.write("c");

    // Copy should show toaster and close menu
    await waitFor(() =>
      expect(lastFrame()?.includes("Todo copied")).toEqual(true),
    );
    await waitFor(() =>
      expect(lastFrame()?.includes("Todo menu")).toEqual(false),
    );
  } finally {
    (Runtime as any).Command = originalCommand;
  }
  testUnmount?.();
});

test("TodoMenu: should show failure toast when clipboard copy fails", async () => {
  const originalCommand = (Runtime as any).Command;
  let testUnmount: (() => void) | undefined;
  try {
    (Runtime as any).Command = class {
      constructor() {}
      spawn() {
        return {
          stdin: {
            getWriter: () => ({
              write: () => Promise.reject(new Error("clipboard unavailable")),
              close: () => Promise.resolve(),
              releaseLock: () => {},
            }),
          },
          status: Promise.resolve({ success: false, code: 1 }),
        };
      }
    };

    const todo1 = new Todo("Todo 1");
    let focusCount = 0;
    const { unmount, stdin, lastFrame } = render(
      <TestWrapper
        navValue={{
          getSelectedTodos: () => [todo1],
          getSelectedTodo: () => todo1,
        }}
      >
        <AppContentMock />
        <ModalTrigger />
        <FocusObserver onFocused={() => focusCount++} />
      </TestWrapper>,
    );
    testUnmount = unmount;

    await waitFor(() => expect(focusCount >= 1).toEqual(true));
    stdin.write("c");

    await waitFor(() =>
      expect(
        lastFrame()?.includes("Copy failed: clipboard unavailable"),
      ).toEqual(true),
    );
    expect(lastFrame()?.includes("Todo copied")).toEqual(false);
    expect(lastFrame()?.includes("Todo menu")).toEqual(false);
  } finally {
    (Runtime as any).Command = originalCommand;
  }
  testUnmount?.();
});

test("TodoMenu: should call paste", async () => {
  const originalCommand = (Runtime as any).Command;
  let testUnmount: (() => void) | undefined;
  try {
    (Runtime as any).Command = class {
      constructor() {}
      output() {
        return Promise.resolve({
          stdout: new TextEncoder().encode("Pasted Todo\n"),
          stderr: new Uint8Array(),
          success: true,
          code: 0,
        });
      }
    };

    let pastedTexts: string[] = [];
    let focusCount = 0;
    const { unmount, stdin, lastFrame } = render(
      <TestWrapper
        todoValue={{
          addTodos: (...texts: string[]) => {
            pastedTexts = texts;
            return [];
          },
        }}
      >
        <AppContentMock />
        <ModalTrigger />
        <FocusObserver onFocused={() => focusCount++} />
      </TestWrapper>,
    );
    testUnmount = unmount;

    await waitFor(() => expect(focusCount >= 1).toEqual(true));
    stdin.write("v");

    await waitFor(() => {
      expect(pastedTexts.length).toEqual(1);
      expect(pastedTexts[0]).toEqual("Pasted Todo");
    });

    // Paste should close the menu
    await waitFor(() =>
      expect(lastFrame()?.includes("Todo menu")).toEqual(false),
    );
  } finally {
    (Runtime as any).Command = originalCommand;
  }
  testUnmount?.();
});
