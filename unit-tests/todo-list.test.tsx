import { Runtime } from "../utils/runtime.ts";
import { expect, test } from "vitest";
import chalk from "chalk";

import { Box, Text } from "ink";
import { render } from "ink-testing-library";

import { Todo } from "../logic/todo.ts";
import type { Todos } from "../logic/Todos.ts";
import { SearchInput } from "../components/SearchInput.tsx";
import { MockTodoProvider } from "./mock-todo-provider.tsx";
import { restoreRuntimeMocks, waitFor } from "./test-utils.ts";

import { ActionBar } from "../components/ActionBar.tsx";
import { ConfirmModal } from "../components/ConfirmModal.tsx";
import { HiddenIndicator } from "../components/HiddenIndicator.tsx";
import { SetDateModal } from "../components/SetDateModal.tsx";
import { SetRecurrenceModal } from "../components/SetRecurrenceModal.tsx";
import { renderTodoText, TodoList } from "../components/TodoList.tsx";
import { COLORS } from "../theme/colors.ts";

import { FocusProvider } from "../contexts/focus-context.tsx";
import { ModalProvider, useModal } from "../contexts/modal-context.tsx";
import {
  NavigationContextType,
  NavigationProvider,
} from "../contexts/navigation-context.tsx";
import { SearchProvider, useSearch } from "../contexts/search-context.tsx";
import { SuggestionProvider } from "../contexts/suggestion-context.tsx";
import { ToasterProvider } from "../contexts/toaster-context.tsx";
import { UpdateProvider } from "../contexts/update-context.tsx";
import { MultiSelectMenu, TodoMenu } from "../components/TodoMenu.tsx";

import { useTodo } from "../contexts/todo-context.tsx";
import { useEffect } from "react";

// --- Helpers ---

// Wrapper to inject todos into NavigationProvider
const NavigationWrapper = ({ children }: { children: React.ReactNode }) => {
  const { todos } = useTodo();
  return (
    <NavigationProvider todos={todos} listHeightForTest={10}>
      {children}
    </NavigationProvider>
  );
};

// Wrapper that includes all providers
const TestWrapper = ({
  children,
  initialTodos = [],
  onTodosChange,
}: {
  children: React.ReactNode;
  initialTodos?: Todo[];
  onTodosChange?: (todos: Todo[]) => void;
}) => {
  return (
    <ToasterProvider>
      <UpdateProvider options={{ enabled: false }}>
        <MockTodoProvider
          initialTodos={initialTodos}
          onTodosChange={onTodosChange}
        >
          <FocusProvider>
            <SuggestionProvider>
              <SearchProvider>
                <NavigationWrapper>
                  <ModalProvider>{children}</ModalProvider>
                </NavigationWrapper>
              </SearchProvider>
            </SuggestionProvider>
          </FocusProvider>
        </MockTodoProvider>
      </UpdateProvider>
    </ToasterProvider>
  );
};

import {
  FocusObserver,
  NavController,
  SelectionObserver,
  SelectionStateObserver,
} from "./test-components.tsx";

// Mock App Content for TodoList tests
const AppContentMock = ({ todos = [] }: { todos?: Todos }) => {
  const { activeModal, modalData } = useModal();
  return (
    <Box flexDirection="column" position="relative" height={25}>
      <HiddenIndicator />
      <SearchInput todos={todos} />
      <TodoList />
      <ActionBar />
      {activeModal === "confirm-modal" && modalData && (
        <ConfirmModal
          title={modalData.title}
          message={modalData.message}
          onConfirm={modalData.onConfirm}
          onCancel={modalData.onCancel}
        />
      )}
      {activeModal === "create-todo" && <Text>Create Todo Modal</Text>}
      {activeModal === "edit-todo" && <Text>Edit Todo Modal</Text>}
      {activeModal === "set-due-date" && <SetDateModal type="due" />}
      {activeModal === "set-threshold-date" && (
        <SetDateModal type="threshold" />
      )}
      {activeModal === "set-recurrence" && <SetRecurrenceModal />}
      {activeModal === "todo-menu" && <TodoMenu />}
      {activeModal === "multi-select-menu" && <MultiSelectMenu />}
    </Box>
  );
};

const SearchQuerySetter = ({ query }: { query: string }) => {
  const { setSearchQuery } = useSearch();
  useEffect(() => {
    setSearchQuery(query);
  }, [query, setSearchQuery]);
  return null;
};

// Clipboard Mocks
const originalCommand = Runtime.Command;

function setupClipboardMock(text: string) {
  (Runtime as any).Command = class {
    command: string;
    constructor(command: string, _options: unknown) {
      this.command = command;
    }
    output() {
      if (
        this.command === "powershell.exe" ||
        this.command === "pbpaste" ||
        this.command === "xclip"
      ) {
        return Promise.resolve({
          stdout: new TextEncoder().encode(text),
          stderr: new Uint8Array(),
          success: true,
          code: 0,
        });
      }
      return Promise.resolve({
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
        success: true,
        code: 0,
      });
    }
    spawn() {
      return {
        stdin: {
          getWriter() {
            return {
              write: () => Promise.resolve(),
              close: () => Promise.resolve(),
            };
          },
        },
        status: Promise.resolve({ success: true, code: 0 }),
      };
    }
  };
}

function teardownClipboardMock() {
  (Runtime as any).Command = originalCommand;
  restoreRuntimeMocks();
}

// Custom clipboard mock for copy tests
function setupCaptureClipboardMock(onCapture: (text: string) => void) {
  const originalCommand = Runtime.Command;
  (Runtime as any).Command = class {
    command: string;
    constructor(command: string, _options: any) {
      this.command = command;
    }
    spawn(): any {
      return {
        stdin: {
          getWriter() {
            return {
              write: (data: Uint8Array) => {
                const text = new TextDecoder().decode(data);
                onCapture(text);
                return Promise.resolve();
              },
              close: () => Promise.resolve(),
            };
          },
        },
        status: Promise.resolve({ success: true, code: 0 }),
      };
    }
  };
  return () => {
    (Runtime as any).Command = originalCommand;
    restoreRuntimeMocks();
  };
}

// Clipboard mock that makes the copy command fail
function setupFailingClipboardMock(message: string) {
  const originalCommand = Runtime.Command;
  (Runtime as any).Command = class {
    command: string;
    constructor(command: string, _options: any) {
      this.command = command;
    }
    spawn(): any {
      return {
        stdin: {
          getWriter() {
            return {
              write: () => Promise.reject(new Error(message)),
              close: () => Promise.resolve(),
            };
          },
        },
        status: Promise.resolve({ success: false, code: 1 }),
      };
    }
  };
  return () => {
    (Runtime as any).Command = originalCommand;
    restoreRuntimeMocks();
  };
}

// --- Tests ---

test("TodoList: 'H' should toggle show hidden todos global state", async () => {
  const todoVisible = new Todo("visible todo");
  const todoHidden = new Todo("h:1 hidden todo");
  const initialTodos = [todoVisible, todoHidden];

  let isFocused = false;

  const { unmount, stdin, lastFrame } = render(
    <TestWrapper initialTodos={initialTodos}>
      <AppContentMock todos={[...initialTodos]} />
      <FocusObserver onFocused={() => (isFocused = true)} />
    </TestWrapper>,
  );

  // Initial check: only visible todo should be shown
  await waitFor(() => {
    const frame = lastFrame();
    expect(frame?.includes("visible todo")).toEqual(true);
    expect(frame?.includes("hidden todo")).toEqual(false);
    expect(isFocused).toEqual(true);
  });

  // Press 'H' to toggle showHidden
  stdin.write("H");

  // Check: both todos should be shown
  await waitFor(() => {
    const frame = lastFrame();
    expect(frame?.includes("visible todo")).toEqual(true);
    expect(frame?.includes("hidden todo")).toEqual(true);
  });

  // Press 'H' again to toggle back
  stdin.write("H");

  // Check: only visible todo should be shown again
  await waitFor(() => {
    const frame = lastFrame();
    expect(frame?.includes("visible todo")).toEqual(true);
    expect(frame?.includes("hidden todo")).toEqual(false);
  });

  unmount();
});

test("TodoList: 'h' should toggle selected todo hidden state", async () => {
  const todo1 = new Todo("Todo 1");
  const initialTodos = [todo1];

  let capturedTodos: Todo[] = [...initialTodos];
  let isFocused = false;

  const { unmount, stdin, lastFrame } = render(
    <TestWrapper
      initialTodos={initialTodos}
      onTodosChange={(todos) => (capturedTodos = todos)}
    >
      <AppContentMock todos={[...initialTodos]} />
      <FocusObserver onFocused={() => (isFocused = true)} />
    </TestWrapper>,
  );

  await waitFor(() => {
    expect(isFocused).toEqual(true);
    expect(lastFrame()?.includes("Todo 1")).toEqual(true);
  });

  // Initially not hidden
  expect(capturedTodos[0].isHidden()).toEqual(false);

  // Press 'h' to hide the selected todo
  stdin.write("h");

  // It should now be hidden in the business logic
  await waitFor(() => {
    expect(capturedTodos[0].isHidden()).toEqual(true);
  });

  // And it should disappear from the list (since showHidden is false)
  await waitFor(() => {
    const frame = lastFrame();
    expect(frame?.includes("Todo 1")).toEqual(false);
  });

  // Toggle 'H' to see it again
  stdin.write("H");
  await waitFor(() => {
    expect(lastFrame()?.includes("Todo 1")).toEqual(true);
  });

  // Press 'h' again to unhide
  stdin.write("h");
  await waitFor(() => {
    expect(capturedTodos[0].isHidden()).toEqual(false);
  });

  unmount();
});

test("TodoList: should paste todos when 'v' is pressed", async () => {
  setupClipboardMock("Pasted Todo 1\n  \n\nPasted Todo 2");

  const initialTodos = [new Todo("Existing Todo")];

  // We need to capture the todos to see if they were updated
  let capturedTodos: Todo[] = [...initialTodos];
  let isFocused = false;

  const { unmount, stdin, lastFrame } = render(
    <TestWrapper
      initialTodos={initialTodos}
      onTodosChange={(todos) => (capturedTodos = todos)}
    >
      <AppContentMock todos={[...initialTodos]} />
      <FocusObserver onFocused={() => (isFocused = true)} />
    </TestWrapper>,
  );

  // Initial check
  await waitFor(() => {
    const frame = lastFrame();
    expect(frame?.includes("Existing Todo")).toEqual(true);
    expect(isFocused).toEqual(true);
  });

  // Press 'v'
  stdin.write("v");

  // Wait for todos to be updated
  await waitFor(() => {
    expect(capturedTodos.length).toEqual(3);
    expect(capturedTodos[1].text).toEqual("Pasted Todo 1");
    expect(capturedTodos[2].text).toEqual("Pasted Todo 2");
  });

  unmount();
  teardownClipboardMock();
});

test("TodoList: should select the last pasted todo", async () => {
  setupClipboardMock("Pasted Todo 1\nPasted Todo 2");

  const initialTodos = [new Todo("Existing Todo")];

  let capturedTodos: Todo[] = [...initialTodos];
  let isFocused = false;
  let currentSelectionId: symbol | undefined = undefined;

  const { unmount, stdin } = render(
    <TestWrapper
      initialTodos={initialTodos}
      onTodosChange={(todos) => (capturedTodos = todos)}
    >
      <SelectionObserver
        onSelectionIdChange={(id) => (currentSelectionId = id)}
      />
      <AppContentMock todos={[...initialTodos]} />
      <FocusObserver onFocused={() => (isFocused = true)} />
    </TestWrapper>,
  );

  // Initial check - "Existing Todo" should be selected
  await waitFor(() => {
    expect(isFocused).toEqual(true);
    expect(currentSelectionId).toEqual(initialTodos[0].id);
  });

  // Press 'v'
  stdin.write("v");

  // Wait for todos to be updated and last one to be selected
  await waitFor(() => {
    expect(capturedTodos.length).toEqual(3);
    expect(capturedTodos[2].text).toEqual("Pasted Todo 2");
  });

  await waitFor(() => {
    expect(String(currentSelectionId)).toEqual(String(capturedTodos[2].id));
  });

  unmount();
  teardownClipboardMock();
});

test("TodoList: should show confirmation when pasting more than 10 todos", async () => {
  const manyTodos = Array.from({ length: 11 }, (_, i) => `Todo ${i + 1}`).join(
    "\n",
  );
  setupClipboardMock(manyTodos);

  const initialTodos: Todo[] = [];
  let capturedTodos: Todo[] = [...initialTodos];
  let focusCount = 0;

  const { unmount, stdin, lastFrame } = render(
    <TestWrapper
      initialTodos={initialTodos}
      onTodosChange={(todos) => (capturedTodos = todos)}
    >
      <AppContentMock todos={[...initialTodos]} />
      <FocusObserver onFocused={() => focusCount++} />
    </TestWrapper>,
  );

  // Wait for initial focus
  await waitFor(() => {
    expect(focusCount >= 1).toEqual(true);
  });

  // Press 'v'
  stdin.write("v");

  // Should show confirmation modal
  await waitFor(() => {
    const frame = lastFrame();
    expect(frame?.includes("Paste Multiple Todos")).toEqual(true);
    expect(frame?.includes("Are you sure you want to paste 11 todos?")).toEqual(
      true,
    );
  });

  // Wait for modal to gain focus (focusCount should increment)
  await waitFor(() => {
    expect(focusCount >= 2).toEqual(true);
  });

  // Press Enter to confirm

  stdin.write("\r");

  // Modal should disappear
  await waitFor(() => {
    const frame = lastFrame();
    expect(frame?.includes("Paste Multiple Todos")).toEqual(false);
  });

  // Wait for todos to be updated
  await waitFor(() => {
    expect(capturedTodos.length).toEqual(11);
  });

  unmount();
  teardownClipboardMock();
});

test("TodoList: should handle 'n' key", async () => {
  const initialTodos: Todo[] = [];
  let isFocused = false;

  const { unmount, stdin, lastFrame } = render(
    <TestWrapper initialTodos={initialTodos}>
      <AppContentMock todos={[...initialTodos]} />
      <FocusObserver onFocused={() => (isFocused = true)} />
    </TestWrapper>,
  );

  await waitFor(() => {
    const frame = lastFrame();
    expect(frame?.includes("Douglas Adams")).toEqual(true);
    expect(isFocused).toEqual(true);
  });

  // Press 'x'
  stdin.write("n");

  // Should show Todo Menu
  await waitFor(() => {
    const frame = lastFrame();
    expect(frame?.includes("Create Todo Modal")).toEqual(true);
  });

  unmount();
});

test("TodoList: should handle 'd' key with multi-selection", async () => {
  const todo1 = new Todo("Todo 1");
  const todo2 = new Todo("Todo 2");
  let capturedTodos: Todo[] = [];
  let focused = false;
  let focusCount = 0;
  let selectedCount = 0;
  let nav: NavigationContextType = null!;

  const { unmount, stdin, lastFrame } = render(
    <TestWrapper
      initialTodos={[todo1, todo2]}
      onTodosChange={(todos) => (capturedTodos = todos)}
    >
      <AppContentMock todos={[todo1, todo2]} />
      <FocusObserver
        onFocused={() => {
          focused = true;
          focusCount++;
        }}
      />
      <SelectionStateObserver
        onSelectionChange={(s) => (selectedCount = s.rangeIds.size)}
      />
      <NavController onNav={(n) => (nav = n)} />
    </TestWrapper>,
  );

  // Wait for focus and initial render
  await waitFor(() => {
    expect(focused).toEqual(true);
    const frame = lastFrame();
    expect(frame?.includes("Todo 1")).toEqual(true);
  });

  // Select both (Shift + Down)
  nav.navigateDown(true);
  await waitFor(() => expect(selectedCount).toEqual(2));

  // Press 'd'
  stdin.write("d");

  // Should show Set Due Date modal
  await waitFor(() => {
    const frame = lastFrame();
    expect(frame?.includes("Set Due Date")).toEqual(true);
  });

  // Wait for modal to gain focus
  await waitFor(() => {
    expect(focusCount >= 2).toEqual(true);
  });

  // Press Enter to set "Today" for both

  stdin.write("\r");

  // Modal should disappear
  await waitFor(() => {
    const frame = lastFrame();
    expect(frame?.includes("Set Due Date")).toEqual(false);
  });

  // BOTH should have due date
  await waitFor(() => {
    expect(capturedTodos.length >= 2).toEqual(true);
    expect(capturedTodos[0].tags.due !== undefined).toEqual(true);
    expect(capturedTodos[1].tags.due !== undefined).toEqual(true);
  });

  unmount();
});

test("TodoList: should handle 't' key with multi-selection", async () => {
  const todo1 = new Todo("Todo 1");
  const todo2 = new Todo("Todo 2");
  let capturedTodos: Todo[] = [];
  let focused = false;
  let focusCount = 0;
  let selectedCount = 0;
  let nav: NavigationContextType = null!;

  const { unmount, stdin, lastFrame } = render(
    <TestWrapper
      initialTodos={[todo1, todo2]}
      onTodosChange={(todos) => (capturedTodos = todos)}
    >
      <AppContentMock todos={[todo1, todo2]} />
      <FocusObserver onFocused={() => (focused = true)} />
      <SelectionStateObserver
        onSelectionChange={(s) => (selectedCount = s.rangeIds.size)}
      />
      <NavController onNav={(n) => (nav = n)} />
      <FocusObserver
        onFocused={() => {
          focused = true;
          focusCount++;
        }}
      />
    </TestWrapper>,
  );

  await waitFor(() => expect(focused).toEqual(true));

  // Select both
  nav.navigateDown(true);
  await waitFor(() => expect(selectedCount).toEqual(2));

  // Press 't'
  stdin.write("t");

  // Should show Set Threshold Date modal
  await waitFor(() => {
    const frame = lastFrame();
    expect(frame?.includes("Set Threshold Date")).toEqual(true);
  });

  // Wait for modal to gain focus
  await waitFor(() => {
    expect(focusCount >= 2).toEqual(true);
  });

  // Press Enter to set "Today" for both

  stdin.write("\r");

  // BOTH should have threshold date
  await waitFor(() => {
    expect(capturedTodos.length >= 2).toEqual(true);
    expect(capturedTodos[0].tags.t !== undefined).toEqual(true);
    expect(capturedTodos[1].tags.t !== undefined).toEqual(true);
  });

  unmount();
});

test("TodoList: should handle 'r' key with multi-selection", async () => {
  const todo1 = new Todo("Todo 1");
  const todo2 = new Todo("Todo 2");
  let capturedTodos: Todo[] = [];
  let focused = false;
  let focusCount = 0;
  let selectedCount = 0;
  let nav: NavigationContextType = null!;

  const { unmount, stdin, lastFrame } = render(
    <TestWrapper
      initialTodos={[todo1, todo2]}
      onTodosChange={(todos) => (capturedTodos = todos)}
    >
      <AppContentMock todos={[todo1, todo2]} />
      <FocusObserver onFocused={() => (focused = true)} />
      <SelectionStateObserver
        onSelectionChange={(s) => (selectedCount = s.rangeIds.size)}
      />
      <NavController onNav={(n) => (nav = n)} />
      <FocusObserver
        onFocused={() => {
          focused = true;
          focusCount++;
        }}
      />
    </TestWrapper>,
  );

  await waitFor(() => expect(focused).toEqual(true));

  // Select both
  nav.navigateDown(true);
  await waitFor(() => expect(selectedCount).toEqual(2));

  // Press 'r'
  stdin.write("r");

  // Should show Set Recurrence modal
  await waitFor(() => {
    const frame = lastFrame();
    expect(frame?.includes("Set Recurrence Base")).toEqual(true);
  });

  // Wait for modal to gain focus
  await waitFor(() => {
    expect(focusCount >= 2).toEqual(true);
  });

  // Select Daily (first option, just press Enter)
  stdin.write("\r");

  // Now it asks for amount
  await waitFor(() => {
    const frame = lastFrame();
    expect(frame?.includes("Set Recurrence Interval")).toEqual(true);
  });

  // Confirm amount "1" (default)

  stdin.write("\r");

  // BOTH should have recurrence
  await waitFor(() => {
    expect(capturedTodos.length >= 2).toEqual(true);
    expect(capturedTodos[0].tags.rec).toEqual("1d");
    expect(capturedTodos[1].tags.rec).toEqual("1d");
  });

  unmount();
});

test("TodoList: should only update priority for selected items", async () => {
  const todo1 = new Todo("Todo 1");
  const todo2 = new Todo("Todo 2");
  const todo3 = new Todo("Todo 3");
  let capturedTodos: Todo[] = [];
  let focused = false;
  let selectedCount = 0;
  let nav: NavigationContextType = null!;

  const { unmount, stdin } = render(
    <TestWrapper
      initialTodos={[todo1, todo2, todo3]}
      onTodosChange={(todos) => (capturedTodos = todos)}
    >
      <AppContentMock todos={[todo1, todo2, todo3]} />
      <FocusObserver onFocused={() => (focused = true)} />
      <SelectionStateObserver
        onSelectionChange={(s) => (selectedCount = s.rangeIds.size)}
      />
      <NavController onNav={(n) => (nav = n)} />
    </TestWrapper>,
  );

  await waitFor(() => expect(focused).toEqual(true));

  // Select 1 and 2
  nav.navigateDown(true);
  await waitFor(() => expect(selectedCount).toEqual(2));

  // Press 'A'
  stdin.write("A");

  // 1 and 2 should be A, 3 should be unset
  await waitFor(() => {
    expect(capturedTodos.length >= 3).toEqual(true);
    expect(capturedTodos[0].priority).toEqual("A");
    expect(capturedTodos[1].priority).toEqual("A");
    expect(capturedTodos[2].priority).toEqual(undefined);
  });

  unmount();
});

test("TodoList: should toggle multiple todos via menu", async () => {
  const todo1 = new Todo("Todo 1");
  const todo2 = new Todo("Todo 2");
  let capturedTodos: Todo[] = [];
  let focusCount = 0;
  let selectedCount = 0;
  let nav: NavigationContextType = null!;

  const { unmount, stdin, lastFrame } = render(
    <TestWrapper
      initialTodos={[todo1, todo2]}
      onTodosChange={(todos) => (capturedTodos = todos)}
    >
      <AppContentMock todos={[todo1, todo2]} />
      <FocusObserver onFocused={() => focusCount++} />
      <SelectionStateObserver
        onSelectionChange={(s) => (selectedCount = s.rangeIds.size)}
      />
      <NavController onNav={(n) => (nav = n)} />
    </TestWrapper>,
  );

  await waitFor(() => expect(focusCount >= 1).toEqual(true));
  nav.navigateDown(true);
  await waitFor(() => expect(selectedCount).toEqual(2));

  stdin.write("x");
  await waitFor(() =>
    expect(lastFrame()?.includes("Multi-select menu")).toEqual(true),
  );
  await waitFor(() => expect(focusCount >= 2).toEqual(true));

  stdin.write(" ");
  await waitFor(() => {
    expect(capturedTodos.length >= 2).toEqual(true);
    expect(capturedTodos[0].isDone()).toEqual(true);
    expect(capturedTodos[1].isDone()).toEqual(true);
  });

  unmount();
});

test("TodoList: should delete multiple todos via menu", async () => {
  const todo1 = new Todo("Todo 1");
  const todo2 = new Todo("Todo 2");
  let capturedTodos: Todo[] = [];
  let focusCount = 0;
  let selectedCount = 0;
  let nav: NavigationContextType = null!;

  const { unmount, stdin, lastFrame } = render(
    <TestWrapper
      initialTodos={[todo1, todo2]}
      onTodosChange={(todos) => (capturedTodos = todos)}
    >
      <AppContentMock todos={[todo1, todo2]} />
      <FocusObserver onFocused={() => focusCount++} />
      <SelectionStateObserver
        onSelectionChange={(s) => (selectedCount = s.rangeIds.size)}
      />
      <NavController onNav={(n) => (nav = n)} />
    </TestWrapper>,
  );

  await waitFor(() => expect(focusCount >= 1).toEqual(true));
  nav.navigateDown(true);
  await waitFor(() => expect(selectedCount).toEqual(2));

  stdin.write("x");
  await waitFor(() =>
    expect(lastFrame()?.includes("Multi-select menu")).toEqual(true),
  );
  await waitFor(() => expect(focusCount >= 2).toEqual(true));

  stdin.write("\x1b[3~"); // Delete
  await waitFor(() => {
    const frame = lastFrame();
    expect(frame?.includes("Are you sure you want to delete 2 todos?")).toEqual(
      true,
    );
  });
  await waitFor(() => expect(focusCount >= 3).toEqual(true));

  stdin.write("\r");
  await waitFor(() => expect(capturedTodos.length).toEqual(0));

  unmount();
});

test("TodoList: should copy multiple todos via menu", async () => {
  const restoreClipboard = setupCaptureClipboardMock(() => {});
  const todo1 = new Todo("Todo 1");
  const todo2 = new Todo("Todo 2");
  let focusCount = 0;
  let selectedCount = 0;
  let nav: NavigationContextType = null!;

  const { unmount, stdin, lastFrame } = render(
    <TestWrapper initialTodos={[todo1, todo2]}>
      <AppContentMock todos={[todo1, todo2]} />
      <FocusObserver onFocused={() => focusCount++} />
      <SelectionStateObserver
        onSelectionChange={(s) => (selectedCount = s.rangeIds.size)}
      />
      <NavController onNav={(n) => (nav = n)} />
    </TestWrapper>,
  );

  await waitFor(() => expect(focusCount >= 1).toEqual(true));
  nav.navigateDown(true);
  await waitFor(() => expect(selectedCount).toEqual(2));

  stdin.write("x"); // Use 'x' to test both
  await waitFor(() =>
    expect(lastFrame()?.includes("Multi-select menu")).toEqual(true),
  );
  await waitFor(() => expect(focusCount >= 2).toEqual(true));

  stdin.write("c");
  await waitFor(() =>
    expect(lastFrame()?.includes("Multi-select menu")).toEqual(false),
  );

  unmount();
  restoreClipboard();
});

test("TodoList: minimal should open menu", async () => {
  let isFocused = false;
  const { unmount, stdin, lastFrame } = render(
    <TestWrapper initialTodos={[new Todo("Test")]}>
      <AppContentMock todos={[new Todo("Test")]} />
      <FocusObserver onFocused={() => (isFocused = true)} />
    </TestWrapper>,
  );

  await waitFor(() => expect(isFocused).toEqual(true));

  stdin.write("x");
  await waitFor(() => {
    expect(lastFrame()?.includes("Todo menu")).toEqual(true);
  });

  unmount();
});

test("TodoList: 'c' should copy multiple selected todos", async () => {
  let capturedText = "";
  const restore = setupCaptureClipboardMock((text) => (capturedText = text));

  const todo1 = new Todo("Todo 1");
  const todo2 = new Todo("Todo 2");

  // We expect multiselect behavior.

  let focused = false;
  let selectedCount = 0;

  let nav: NavigationContextType = null!;

  const { unmount, stdin } = render(
    <TestWrapper initialTodos={[todo1, todo2]}>
      <AppContentMock todos={[todo1, todo2]} />
      <FocusObserver onFocused={() => (focused = true)} />
      <SelectionStateObserver
        onSelectionChange={(s) => (selectedCount = s.rangeIds.size)}
      />
      <NavController onNav={(n) => (nav = n)} />
    </TestWrapper>,
  );

  await waitFor(() => expect(focused).toEqual(true));

  // Select both (Shift + Down)
  nav.navigateDown(true);
  await waitFor(() => expect(selectedCount).toEqual(2));

  // Press 'c'
  stdin.write("c");

  // Check clipboard content
  await waitFor(() => {
    // We expect "Todo 1\nTodo 2" or "Todo 2\nTodo 1" depending on order logic.
    // Assuming implementation preserves list order.
    expect(capturedText).toMatch(/Todo 1/);
    expect(capturedText).toMatch(/Todo 2/);
    expect(capturedText.split(/\r?\n/).length).toEqual(2);
  });

  unmount();
  restore();
});

test("TodoList: 'c' should copy single todo", async () => {
  let capturedText = "";
  const restore = setupCaptureClipboardMock((text) => (capturedText = text));

  const todo1 = new Todo("Todo 1");

  let focused = false;

  const { unmount, stdin } = render(
    <TestWrapper initialTodos={[todo1]}>
      <AppContentMock />
      <FocusObserver onFocused={() => (focused = true)} />
    </TestWrapper>,
  );

  await waitFor(() => expect(focused).toEqual(true));

  // Press 'c'
  stdin.write("c");

  // Check clipboard content
  await waitFor(() => {
    expect(capturedText.trim()).toEqual("Todo 1");
  });

  unmount();
  restore();
});

test("TodoList: 'c' should show failure toast when clipboard copy fails", async () => {
  const restore = setupFailingClipboardMock("clipboard unavailable");

  const todo1 = new Todo("Todo 1");
  let focused = false;

  const { unmount, stdin, lastFrame } = render(
    <TestWrapper initialTodos={[todo1]}>
      <AppContentMock />
      <FocusObserver onFocused={() => (focused = true)} />
    </TestWrapper>,
  );

  await waitFor(() => expect(focused).toEqual(true));

  stdin.write("c");

  await waitFor(() => {
    expect(lastFrame()?.includes("Copy failed: clipboard unavailable")).toEqual(
      true,
    );
  });
  expect(lastFrame()?.includes("Todo copied")).toEqual(false);

  unmount();
  restore();
});

test("TodoList: should show WelcomeScreen when no todos and no search", async () => {
  const { unmount, lastFrame } = render(
    <TestWrapper initialTodos={[]}>
      <AppContentMock />
    </TestWrapper>,
  );

  await waitFor(() => {
    const frame = lastFrame();
    expect(frame?.includes("Douglas Adams")).toEqual(true);
    expect(frame?.includes("Press 'n' to create a new todo")).toEqual(true);
  });

  unmount();
});

test("TodoList: should show SearchEmptyState when search has no results (with todos)", async () => {
  const todos = [new Todo("Task A")];
  const { unmount, lastFrame } = render(
    <TestWrapper initialTodos={todos}>
      <SearchQuerySetter query="xyz123" />
      <AppContentMock />
    </TestWrapper>,
  );

  await waitFor(() => {
    const frame = lastFrame();
    expect(frame?.includes("No results found for")).toEqual(true);
    expect(frame?.includes("xyz123")).toEqual(true);
    expect(frame?.includes("Douglas Adams")).toEqual(false);
  });

  unmount();
});

test("TodoList: should show SearchEmptyState when search has no results (empty list)", async () => {
  const { unmount, lastFrame } = render(
    <TestWrapper initialTodos={[]}>
      <SearchQuerySetter query="abc" />
      <AppContentMock />
    </TestWrapper>,
  );

  await waitFor(() => {
    const frame = lastFrame();
    expect(frame?.includes("No results found for")).toEqual(true);
    expect(frame?.includes("abc")).toEqual(true);
    expect(frame?.includes("Douglas Adams")).toEqual(false);
  });

  unmount();
});

test("TodoList: should scroll selected todo into view after search cancel", async () => {
  const todos = Array.from(
    { length: 100 },
    (_, i) => new Todo(`Task ${String(i + 1).padStart(3, "0")}`),
  );
  let nav: NavigationContextType = null!;

  const { unmount, lastFrame, rerender } = render(
    <TestWrapper initialTodos={todos}>
      <SearchQuerySetter query="Task 099" />
      <AppContentMock />
      <NavController onNav={(n) => (nav = n)} />
    </TestWrapper>,
  );

  await waitFor(() => {
    const selectedTodo = todos.find((t) => t.id === nav.selectedTodoId);
    expect(selectedTodo?.text).toEqual("Task 099");
    expect(lastFrame()?.includes("Task 099")).toEqual(true);
  });

  rerender(
    <TestWrapper initialTodos={todos}>
      <SearchQuerySetter query="" />
      <AppContentMock />
      <NavController onNav={(n) => (nav = n)} />
    </TestWrapper>,
  );

  await waitFor(
    () => {
      expect(lastFrame()?.includes("Task 099")).toEqual(true);
    },
    { timeout: 2000 },
  );

  unmount();
});

test("TodoList: double click on checkbox toggles todo", async () => {
  const todo = new Todo("Toggle by bracket");
  let capturedTodos: Todo[] = [todo];

  const { unmount, stdin } = render(
    <TestWrapper
      initialTodos={[todo]}
      onTodosChange={(todos) => (capturedTodos = todos)}
    >
      <AppContentMock todos={[todo]} />
    </TestWrapper>,
  );

  // One uncategorized todo renders under the "None" header.
  // maxDigits=1 => checkbox columns are x=4..6, todo row y=2.
  stdin.write("\x1b[<0;4;2M");
  stdin.write("\x1b[<0;4;2M");

  await waitFor(() => {
    expect(capturedTodos[0].isDone()).toEqual(true);
  });

  unmount();
});

test("TodoList: double click on text opens edit modal", async () => {
  const todo = new Todo("Edit by text");
  let capturedTodos: Todo[] = [todo];

  const { unmount, stdin, lastFrame } = render(
    <TestWrapper
      initialTodos={[todo]}
      onTodosChange={(todos) => (capturedTodos = todos)}
    >
      <AppContentMock todos={[todo]} />
    </TestWrapper>,
  );

  // Click outside checkbox zone on the todo row below the "None" header.
  stdin.write("\x1b[<0;10;2M");
  stdin.write("\x1b[<0;10;2M");

  await waitFor(() => {
    expect(lastFrame()?.includes("Edit Todo Modal")).toEqual(true);
    expect(capturedTodos[0].isDone()).toEqual(false);
  });

  unmount();
});

test("TodoList: should scroll multi-selection range into view after search cancel", async () => {
  const todos = Array.from(
    { length: 100 },
    (_, i) => new Todo(`Task ${String(i + 1).padStart(3, "0")}`),
  );
  let nav: NavigationContextType = null!;

  let focusedTag: string | undefined;
  const { unmount, lastFrame, stdin } = render(
    <TestWrapper initialTodos={todos}>
      <AppContentMock todos={[...todos]} />
      <NavController onNav={(n) => (nav = n)} />
      <FocusObserver onFocused={(tag) => (focusedTag = tag)} />
    </TestWrapper>,
  );

  // Wait for initial focus
  await waitFor(() => {
    expect(focusedTag).toEqual("todo-list");
  });

  // 1. Focus search and type "Task 09"
  stdin.write("/");

  // Wait for search to be focused
  await waitFor(() => {
    expect(focusedTag).toEqual("search-input");
  });

  stdin.write("Task 09");

  // Filtered list will have Task 090, 091... 099
  // Wait for filter to apply
  await waitFor(() => {
    const frame = lastFrame();

    expect(frame?.includes("Task 090")).toEqual(true);
    expect(frame?.includes("Task 097")).toEqual(true);
  });

  // Select range 090 to 095
  const t090 = todos.find((t) => t.text === "Task 090")!;
  const t095 = todos.find((t) => t.text === "Task 095")!;

  // Select 090 via nav (since we can't easily click, and arrow keys might be tricky if selection reset)
  // Actually, let's use arrow keys to be safe OR just set it if we trust nav.
  // Ideally we use keys. Task 090 should be near top.
  // Let's force set it for stability of this specific test part.
  nav.setSelectedTodoId(t090.id);

  // Press Shift+Down 5 times to select up to 095
  stdin.write("\u001B[1;2B");
  stdin.write("\u001B[1;2B");
  stdin.write("\u001B[1;2B");
  stdin.write("\u001B[1;2B");
  stdin.write("\u001B[1;2B");

  await waitFor(() => {
    expect(nav.selectedTodoIds.has(t090.id)).toEqual(true);
    expect(nav.selectedTodoIds.has(t095.id)).toEqual(true);
  });

  // 3. Clear search via Escape (should clear search and focus list)
  stdin.write("\u001B");

  await waitFor(
    () => {
      const frame = lastFrame();

      // At least the cursor (095) should be in view
      expect(frame?.includes("Task 095")).toEqual(true);
      // And ideally some other parts of the range
      expect(frame?.includes("Task 090")).toEqual(true);
    },
    { timeout: 10000 },
  );

  unmount();
});

test("TodoList: repeated tags get unique content-offset keys and colors", () => {
  const text = "first @home second @home +work +work";
  const parts = renderTodoText(text, false, false);

  expect(parts.length).toEqual(9);

  const keys = parts.map((part) => String(part.key));
  expect(new Set(keys).size).toEqual(parts.length);
  keys.forEach((key, index) => {
    expect(key === String(index)).toEqual(false);
  });

  expect(parts[1].props.color).toEqual(COLORS.tagContext);
  expect(parts[3].props.color).toEqual(COLORS.tagContext);
  expect(parts[5].props.color).toEqual(COLORS.tagProject);
  expect(parts[7].props.color).toEqual(COLORS.tagProject);
  expect(parts[0].props.color).toEqual(undefined);

  const highlighted = renderTodoText(text, true, false);
  highlighted.forEach((part) => {
    expect(part.props.color).toEqual(COLORS.textOnHighlight);
  });

  const overdue = renderTodoText("late @home +work", false, true);
  expect(overdue[0].props.color).toEqual(COLORS.danger);
  expect(overdue[1].props.color).toEqual(COLORS.tagContext);
  expect(overdue[2].props.color).toEqual(COLORS.danger);
  expect(overdue[3].props.color).toEqual(COLORS.tagProject);
});

test("TodoList: repeated tag text renders without duplicate-key warnings", async () => {
  const text = "review @home then @home again +work and +work";
  const todo = new Todo(text);
  const originalError = console.error;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args.map((arg) => String(arg)).join(" "));
  };

  const { lastFrame, unmount } = render(
    <TestWrapper initialTodos={[todo]}>
      <AppContentMock todos={[todo]} />
    </TestWrapper>,
  );

  try {
    await waitFor(() => {
      expect(lastFrame()?.includes(text)).toEqual(true);
    });

    expect(errors.some((message) => message.includes("same key"))).toEqual(
      false,
    );
  } finally {
    unmount();
    console.error = originalError;
  }
});

test("TodoList: focus highlight follows the selected todo", async () => {
  const todos = [new Todo("Focus first"), new Todo("Focus second")];
  const previousLevel = chalk.level;
  // Ink only emits styles when chalk has a color level. Enable truecolor so
  // the focused row's background is observable in the frame.
  chalk.level = 3;

  const { stdin, lastFrame, unmount } = render(
    <TestWrapper initialTodos={todos}>
      <AppContentMock todos={todos} />
    </TestWrapper>,
  );

  const styled = chalk.bgHex(COLORS.focusBackground)("x");
  const focusBackground = styled.slice(0, styled.indexOf("x"));
  const lineFor = (text: string) =>
    (lastFrame() ?? "").split("\n").find((line) => line.includes(text));

  try {
    await waitFor(() => {
      expect(lineFor("Focus first")?.includes(focusBackground)).toEqual(true);
      expect(lineFor("Focus second")?.includes(focusBackground)).toEqual(false);
    });

    stdin.write("\x1b[B");

    await waitFor(() => {
      expect(lineFor("Focus second")?.includes(focusBackground)).toEqual(true);
      expect(lineFor("Focus first")?.includes(focusBackground)).toEqual(false);
    });
  } finally {
    chalk.level = previousLevel;
    unmount();
  }
});
