import { assertEquals, assertMatch } from "@std/assert";
import { Box, Text } from "ink";
import { render } from "ink-testing-library";

import { Todo } from "../logic/todo.ts";
import type { Todos } from "../logic/Todos.ts";
import { SearchInput } from "../components/SearchInput.tsx";
import { MockTodoProvider } from "./mock-todo-provider.tsx";
import { restoreDenoMocks, waitFor } from "./test-utils.ts";

import { ActionBar } from "../components/ActionBar.tsx";
import { ConfirmModal } from "../components/ConfirmModal.tsx";
import { HiddenIndicator } from "../components/HiddenIndicator.tsx";
import { SetDateModal } from "../components/SetDateModal.tsx";
import { SetRecurrenceModal } from "../components/SetRecurrenceModal.tsx";
import { TodoList } from "../components/TodoList.tsx";

import { FocusProvider } from "../contexts/focus-context.tsx";
import {
  isConfirmModalData,
  ModalProvider,
  useModal,
} from "../contexts/modal-context.tsx";
import {
  NavigationContextType,
  NavigationProvider,
} from "../contexts/navigation-context.tsx";
import { SearchProvider, useSearch } from "../contexts/search-context.tsx";
import { SuggestionProvider } from "../contexts/suggestion-context.tsx";
import { ToasterProvider } from "../contexts/toaster-context.tsx";
import { TodoMenu } from "../components/TodoMenu.tsx";

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
      {activeModal === "confirm-modal" && isConfirmModalData(modalData) && (
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
      {activeModal === "set-threshold-date" &&
        <SetDateModal type="threshold" />}
      {activeModal === "set-recurrence" && <SetRecurrenceModal />}
      {activeModal === "todo-menu" && <TodoMenu />}
    </Box>
  );
};

const SearchQuerySetter = ({
  query,
}: {
  query: string;
}) => {
  const { setSearchQuery } = useSearch();
  useEffect(() => {
    setSearchQuery(query);
  }, [query, setSearchQuery]);
  return null;
};

// Clipboard Mocks
const originalCommand = Deno.Command;

function setupClipboardMock(text: string) {
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = class {
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
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = originalCommand;
  restoreDenoMocks();
}

// Custom clipboard mock for copy tests
function setupCaptureClipboardMock(onCapture: (text: string) => void) {
  const originalCommand = Deno.Command;
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = class {
    command: string;
    // deno-lint-ignore no-explicit-any
    constructor(command: string, _options: any) {
      this.command = command;
    }
    // deno-lint-ignore no-explicit-any
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
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = originalCommand;
    restoreDenoMocks();
  };
}

// Clipboard mock that makes the copy command fail
function setupFailingClipboardMock(message: string) {
  const originalCommand = Deno.Command;
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = class {
    command: string;
    // deno-lint-ignore no-explicit-any
    constructor(command: string, _options: any) {
      this.command = command;
    }
    // deno-lint-ignore no-explicit-any
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
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = originalCommand;
    restoreDenoMocks();
  };
}

// --- Tests ---

Deno.test({
  name: "TodoList: 'H' should toggle show hidden todos global state",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const todoVisible = new Todo("visible todo");
    const todoHidden = new Todo("h:1 hidden todo");
    const initialTodos = [todoVisible, todoHidden];

    let isFocused = false;

    const { unmount, stdin, lastFrame } = render(
      <TestWrapper
        initialTodos={initialTodos}
      >
        <AppContentMock todos={[...initialTodos]} />
        <FocusObserver onFocused={() => isFocused = true} />
      </TestWrapper>,
    );

    // Initial check: only visible todo should be shown
    await waitFor(() => {
      const frame = lastFrame();
      assertEquals(frame?.includes("visible todo"), true);
      assertEquals(frame?.includes("hidden todo"), false);
      assertEquals(isFocused, true);
    });

    // Press 'H' to toggle showHidden
    stdin.write("H");

    // Check: both todos should be shown
    await waitFor(() => {
      const frame = lastFrame();
      assertEquals(frame?.includes("visible todo"), true);
      assertEquals(frame?.includes("hidden todo"), true);
    });

    // Press 'H' again to toggle back
    stdin.write("H");

    // Check: only visible todo should be shown again
    await waitFor(() => {
      const frame = lastFrame();
      assertEquals(frame?.includes("visible todo"), true);
      assertEquals(frame?.includes("hidden todo"), false);
    });

    unmount();
  },
});

Deno.test({
  name: "TodoList: 'h' should toggle selected todo hidden state",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const todo1 = new Todo("Todo 1");
    const initialTodos = [todo1];

    let capturedTodos: Todo[] = [...initialTodos];
    let isFocused = false;

    const { unmount, stdin, lastFrame } = render(
      <TestWrapper
        initialTodos={initialTodos}
        onTodosChange={(todos) => capturedTodos = todos}
      >
        <AppContentMock todos={[...initialTodos]} />
        <FocusObserver onFocused={() => isFocused = true} />
      </TestWrapper>,
    );

    await waitFor(() => {
      assertEquals(isFocused, true);
      assertEquals(lastFrame()?.includes("Todo 1"), true);
    });

    // Initially not hidden
    assertEquals(capturedTodos[0].isHidden(), false);

    // Press 'h' to hide the selected todo
    stdin.write("h");

    // It should now be hidden in the business logic
    await waitFor(() => {
      assertEquals(capturedTodos[0].isHidden(), true);
    });

    // And it should disappear from the list (since showHidden is false)
    await waitFor(() => {
      const frame = lastFrame();
      assertEquals(frame?.includes("Todo 1"), false);
    });

    // Toggle 'H' to see it again
    stdin.write("H");
    await waitFor(() => {
      assertEquals(lastFrame()?.includes("Todo 1"), true);
    });

    // Press 'h' again to unhide
    stdin.write("h");
    await waitFor(() => {
      assertEquals(capturedTodos[0].isHidden(), false);
    });

    unmount();
  },
});

Deno.test({
  name: "TodoList: should paste todos when 'v' is pressed",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    setupClipboardMock("Pasted Todo 1\n  \n\nPasted Todo 2");

    const initialTodos = [new Todo("Existing Todo")];

    // We need to capture the todos to see if they were updated
    let capturedTodos: Todo[] = [...initialTodos];
    let isFocused = false;

    const { unmount, stdin, lastFrame } = render(
      <TestWrapper
        initialTodos={initialTodos}
        onTodosChange={(todos) => capturedTodos = todos}
      >
        <AppContentMock todos={[...initialTodos]} />
        <FocusObserver onFocused={() => isFocused = true} />
      </TestWrapper>,
    );

    // Initial check
    await waitFor(() => {
      const frame = lastFrame();
      assertEquals(frame?.includes("Existing Todo"), true);
      assertEquals(isFocused, true);
    });

    // Press 'v'
    stdin.write("v");

    // Wait for todos to be updated
    await waitFor(() => {
      assertEquals(capturedTodos.length, 3);
      assertEquals(capturedTodos[1].text, "Pasted Todo 1");
      assertEquals(capturedTodos[2].text, "Pasted Todo 2");
    });

    unmount();
    teardownClipboardMock();
  },
});

Deno.test({
  name: "TodoList: should select the last pasted todo",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    setupClipboardMock("Pasted Todo 1\nPasted Todo 2");

    const initialTodos = [new Todo("Existing Todo")];

    let capturedTodos: Todo[] = [...initialTodos];
    let isFocused = false;
    let currentSelectionId: symbol | undefined = undefined;

    const { unmount, stdin } = render(
      <TestWrapper
        initialTodos={initialTodos}
        onTodosChange={(todos) => capturedTodos = todos}
      >
        <SelectionObserver
          onSelectionIdChange={(id) => (currentSelectionId = id)}
        />
        <AppContentMock todos={[...initialTodos]} />
        <FocusObserver onFocused={() => isFocused = true} />
      </TestWrapper>,
    );

    // Initial check - "Existing Todo" should be selected
    await waitFor(() => {
      assertEquals(isFocused, true);
      assertEquals(currentSelectionId, initialTodos[0].id);
    });

    // Press 'v'
    stdin.write("v");

    // Wait for todos to be updated and last one to be selected
    await waitFor(() => {
      assertEquals(capturedTodos.length, 3);
      assertEquals(capturedTodos[2].text, "Pasted Todo 2");
    });

    await waitFor(() => {
      assertEquals(String(currentSelectionId), String(capturedTodos[2].id));
    });

    unmount();
    teardownClipboardMock();
  },
});

Deno.test({
  name: "TodoList: should show confirmation when pasting more than 10 todos",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const manyTodos = Array.from({ length: 11 }, (_, i) => `Todo ${i + 1}`)
      .join("\n");
    setupClipboardMock(manyTodos);

    const initialTodos: Todo[] = [];
    let capturedTodos: Todo[] = [...initialTodos];
    let focusCount = 0;

    const { unmount, stdin, lastFrame } = render(
      <TestWrapper
        initialTodos={initialTodos}
        onTodosChange={(todos) => capturedTodos = todos}
      >
        <AppContentMock todos={[...initialTodos]} />
        <FocusObserver onFocused={() => focusCount++} />
      </TestWrapper>,
    );

    // Wait for initial focus
    await waitFor(() => {
      assertEquals(focusCount >= 1, true);
    });

    // Press 'v'
    stdin.write("v");

    // Should show confirmation modal
    await waitFor(() => {
      const frame = lastFrame();
      assertEquals(frame?.includes("Paste Multiple Todos"), true);
      assertEquals(
        frame?.includes("Are you sure you want to paste 11 todos?"),
        true,
      );
    });

    // Wait for modal to gain focus (focusCount should increment)
    await waitFor(() => {
      assertEquals(focusCount >= 2, true);
    });

    // Press Enter to confirm

    stdin.write("\r");

    // Modal should disappear
    await waitFor(() => {
      const frame = lastFrame();
      assertEquals(frame?.includes("Paste Multiple Todos"), false);
    });

    // Wait for todos to be updated
    await waitFor(() => {
      assertEquals(capturedTodos.length, 11);
    });

    unmount();
    teardownClipboardMock();
  },
});

Deno.test({
  name: "TodoList: should handle 'n' key",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const initialTodos: Todo[] = [];
    let isFocused = false;

    const { unmount, stdin, lastFrame } = render(
      <TestWrapper initialTodos={initialTodos}>
        <AppContentMock todos={[...initialTodos]} />
        <FocusObserver onFocused={() => isFocused = true} />
      </TestWrapper>,
    );

    await waitFor(() => {
      const frame = lastFrame();
      assertEquals(frame?.includes("Douglas Adams"), true);
      assertEquals(isFocused, true);
    });

    // Press 'x'
    stdin.write("n");

    // Should show Todo Menu
    await waitFor(() => {
      const frame = lastFrame();
      assertEquals(frame?.includes("Create Todo Modal"), true);
    });

    unmount();
  },
});

Deno.test({
  name: "TodoList: should handle 'd' key with multi-selection",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
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
        onTodosChange={(todos) => capturedTodos = todos}
      >
        <AppContentMock todos={[todo1, todo2]} />
        <FocusObserver
          onFocused={() => {
            focused = true;
            focusCount++;
          }}
        />
        <SelectionStateObserver
          onSelectionChange={(s) => selectedCount = s.rangeIds.size}
        />
        <NavController onNav={(n) => nav = n} />
      </TestWrapper>,
    );

    // Wait for focus and initial render
    await waitFor(() => {
      assertEquals(focused, true);
      const frame = lastFrame();
      assertEquals(frame?.includes("Todo 1"), true);
    });

    // Select both (Shift + Down)
    nav.navigateDown(true);
    await waitFor(() => assertEquals(selectedCount, 2));

    // Press 'd'
    stdin.write("d");

    // Should show Set Due Date modal
    await waitFor(() => {
      const frame = lastFrame();
      assertEquals(frame?.includes("Set Due Date"), true);
    });

    // Wait for modal to gain focus
    await waitFor(() => {
      assertEquals(focusCount >= 2, true);
    });

    // Press Enter to set "Today" for both

    stdin.write("\r");

    // Modal should disappear
    await waitFor(() => {
      const frame = lastFrame();
      assertEquals(frame?.includes("Set Due Date"), false);
    });

    // BOTH should have due date
    await waitFor(() => {
      assertEquals(capturedTodos.length >= 2, true);
      assertEquals(capturedTodos[0].tags.due !== undefined, true);
      assertEquals(capturedTodos[1].tags.due !== undefined, true);
    });

    unmount();
  },
});

Deno.test({
  name: "TodoList: should handle 't' key with multi-selection",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
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
        onTodosChange={(todos) => capturedTodos = todos}
      >
        <AppContentMock todos={[todo1, todo2]} />
        <FocusObserver onFocused={() => focused = true} />
        <SelectionStateObserver
          onSelectionChange={(s) => selectedCount = s.rangeIds.size}
        />
        <NavController onNav={(n) => nav = n} />
        <FocusObserver
          onFocused={() => {
            focused = true;
            focusCount++;
          }}
        />
      </TestWrapper>,
    );

    await waitFor(() => assertEquals(focused, true));

    // Select both
    nav.navigateDown(true);
    await waitFor(() => assertEquals(selectedCount, 2));

    // Press 't'
    stdin.write("t");

    // Should show Set Threshold Date modal
    await waitFor(() => {
      const frame = lastFrame();
      assertEquals(frame?.includes("Set Threshold Date"), true);
    });

    // Wait for modal to gain focus
    await waitFor(() => {
      assertEquals(focusCount >= 2, true);
    });

    // Press Enter to set "Today" for both

    stdin.write("\r");

    // BOTH should have threshold date
    await waitFor(() => {
      assertEquals(capturedTodos.length >= 2, true);
      assertEquals(capturedTodos[0].tags.t !== undefined, true);
      assertEquals(capturedTodos[1].tags.t !== undefined, true);
    });

    unmount();
  },
});

Deno.test({
  name: "TodoList: should handle 'r' key with multi-selection",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
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
        onTodosChange={(todos) => capturedTodos = todos}
      >
        <AppContentMock todos={[todo1, todo2]} />
        <FocusObserver onFocused={() => focused = true} />
        <SelectionStateObserver
          onSelectionChange={(s) => selectedCount = s.rangeIds.size}
        />
        <NavController onNav={(n) => nav = n} />
        <FocusObserver
          onFocused={() => {
            focused = true;
            focusCount++;
          }}
        />
      </TestWrapper>,
    );

    await waitFor(() => assertEquals(focused, true));

    // Select both
    nav.navigateDown(true);
    await waitFor(() => assertEquals(selectedCount, 2));

    // Press 'r'
    stdin.write("r");

    // Should show Set Recurrence modal
    await waitFor(() => {
      const frame = lastFrame();
      assertEquals(frame?.includes("Set Recurrence Base"), true);
    });

    // Wait for modal to gain focus
    await waitFor(() => {
      assertEquals(focusCount >= 2, true);
    });

    // Select Daily (first option, just press Enter)
    stdin.write("\r");

    // Now it asks for amount
    await waitFor(() => {
      const frame = lastFrame();
      assertEquals(frame?.includes("Set Recurrence Interval"), true);
    });

    // Confirm amount "1" (default)

    stdin.write("\r");

    // BOTH should have recurrence
    await waitFor(() => {
      assertEquals(capturedTodos.length >= 2, true);
      assertEquals(capturedTodos[0].tags.rec, "1d");
      assertEquals(capturedTodos[1].tags.rec, "1d");
    });

    unmount();
  },
});

Deno.test({
  name: "TodoList: should only update priority for selected items",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
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
        onTodosChange={(todos) => capturedTodos = todos}
      >
        <AppContentMock todos={[todo1, todo2, todo3]} />
        <FocusObserver onFocused={() => focused = true} />
        <SelectionStateObserver
          onSelectionChange={(s) => selectedCount = s.rangeIds.size}
        />
        <NavController onNav={(n) => nav = n} />
      </TestWrapper>,
    );

    await waitFor(() => assertEquals(focused, true));

    // Select 1 and 2
    nav.navigateDown(true);
    await waitFor(() => assertEquals(selectedCount, 2));

    // Press 'A'
    stdin.write("A");

    // 1 and 2 should be A, 3 should be unset
    await waitFor(() => {
      assertEquals(capturedTodos.length >= 3, true);
      assertEquals(capturedTodos[0].priority, "A");
      assertEquals(capturedTodos[1].priority, "A");
      assertEquals(capturedTodos[2].priority, undefined);
    });

    unmount();
  },
});

Deno.test({
  name: "TodoList: should toggle multiple todos via menu",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const todo1 = new Todo("Todo 1");
    const todo2 = new Todo("Todo 2");
    let capturedTodos: Todo[] = [];
    let focusCount = 0;
    let selectedCount = 0;
    let nav: NavigationContextType = null!;

    const { unmount, stdin, lastFrame } = render(
      <TestWrapper
        initialTodos={[todo1, todo2]}
        onTodosChange={(todos) => capturedTodos = todos}
      >
        <AppContentMock todos={[todo1, todo2]} />
        <FocusObserver onFocused={() => focusCount++} />
        <SelectionStateObserver
          onSelectionChange={(s) => selectedCount = s.rangeIds.size}
        />
        <NavController onNav={(n) => nav = n} />
      </TestWrapper>,
    );

    await waitFor(() => assertEquals(focusCount >= 1, true));
    nav.navigateDown(true);
    await waitFor(() => assertEquals(selectedCount, 2));

    stdin.write("x");
    await waitFor(() => assertEquals(lastFrame()?.includes("Todo menu"), true));
    await waitFor(() => assertEquals(focusCount >= 2, true));

    stdin.write(" ");
    await waitFor(() => {
      assertEquals(capturedTodos.length >= 2, true);
      assertEquals(capturedTodos[0].isDone(), true);
      assertEquals(capturedTodos[1].isDone(), true);
    });

    unmount();
  },
});

Deno.test({
  name: "TodoList: should delete multiple todos via menu",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const todo1 = new Todo("Todo 1");
    const todo2 = new Todo("Todo 2");
    let capturedTodos: Todo[] = [];
    let focusCount = 0;
    let selectedCount = 0;
    let nav: NavigationContextType = null!;

    const { unmount, stdin, lastFrame } = render(
      <TestWrapper
        initialTodos={[todo1, todo2]}
        onTodosChange={(todos) => capturedTodos = todos}
      >
        <AppContentMock todos={[todo1, todo2]} />
        <FocusObserver onFocused={() => focusCount++} />
        <SelectionStateObserver
          onSelectionChange={(s) => selectedCount = s.rangeIds.size}
        />
        <NavController onNav={(n) => nav = n} />
      </TestWrapper>,
    );

    await waitFor(() => assertEquals(focusCount >= 1, true));
    nav.navigateDown(true);
    await waitFor(() => assertEquals(selectedCount, 2));

    stdin.write("x");
    await waitFor(() => assertEquals(lastFrame()?.includes("Todo menu"), true));
    await waitFor(() => assertEquals(focusCount >= 2, true));

    stdin.write("\x1b[3~"); // Delete
    await waitFor(() => {
      const frame = lastFrame();
      assertEquals(
        frame?.includes("Are you sure you want to delete 2 todos?"),
        true,
      );
    });
    await waitFor(() => assertEquals(focusCount >= 3, true));

    stdin.write("\r");
    await waitFor(() => assertEquals(capturedTodos.length, 0));

    unmount();
  },
});

Deno.test({
  name: "TodoList: should copy multiple todos via menu",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
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
          onSelectionChange={(s) => selectedCount = s.rangeIds.size}
        />
        <NavController onNav={(n) => nav = n} />
      </TestWrapper>,
    );

    await waitFor(() => assertEquals(focusCount >= 1, true));
    nav.navigateDown(true);
    await waitFor(() => assertEquals(selectedCount, 2));

    stdin.write("x"); // Use 'x' to test both
    await waitFor(() => assertEquals(lastFrame()?.includes("Todo menu"), true));
    await waitFor(() => assertEquals(focusCount >= 2, true));

    stdin.write("c");
    await waitFor(() =>
      assertEquals(lastFrame()?.includes("Todo menu"), false)
    );

    unmount();
  },
});

Deno.test({
  name: "TodoList: minimal should open menu",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    let isFocused = false;
    const { unmount, stdin, lastFrame } = render(
      <TestWrapper initialTodos={[new Todo("Test")]}>
        <AppContentMock todos={[new Todo("Test")]} />
        <FocusObserver onFocused={() => isFocused = true} />
      </TestWrapper>,
    );

    await waitFor(() => assertEquals(isFocused, true));

    stdin.write("x");
    await waitFor(() => {
      assertEquals(lastFrame()?.includes("Todo menu"), true);
    });

    unmount();
  },
});

Deno.test({
  name: "TodoList: 'c' should copy multiple selected todos",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    let capturedText = "";
    const restore = setupCaptureClipboardMock((text) => capturedText = text);

    const todo1 = new Todo("Todo 1");
    const todo2 = new Todo("Todo 2");

    // We expect multiselect behavior.

    let focused = false;
    let selectedCount = 0;

    let nav: NavigationContextType = null!;

    const { unmount, stdin } = render(
      <TestWrapper
        initialTodos={[todo1, todo2]}
      >
        <AppContentMock todos={[todo1, todo2]} />
        <FocusObserver onFocused={() => focused = true} />
        <SelectionStateObserver
          onSelectionChange={(s) => selectedCount = s.rangeIds.size}
        />
        <NavController onNav={(n) => nav = n} />
      </TestWrapper>,
    );

    await waitFor(() => assertEquals(focused, true));

    // Select both (Shift + Down)
    nav.navigateDown(true);
    await waitFor(() => assertEquals(selectedCount, 2));

    // Press 'c'
    stdin.write("c");

    // Check clipboard content
    await waitFor(() => {
      // We expect "Todo 1\nTodo 2" or "Todo 2\nTodo 1" depending on order logic.
      // Assuming implementation preserves list order.
      assertMatch(capturedText, /Todo 1/);
      assertMatch(capturedText, /Todo 2/);
      assertEquals(capturedText.split(/\r?\n/).length, 2);
    });

    unmount();
    restore();
  },
});

Deno.test({
  name: "TodoList: 'c' should copy single todo",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    let capturedText = "";
    const restore = setupCaptureClipboardMock((text) => capturedText = text);

    const todo1 = new Todo("Todo 1");

    let focused = false;

    const { unmount, stdin } = render(
      <TestWrapper
        initialTodos={[todo1]}
      >
        <AppContentMock />
        <FocusObserver onFocused={() => focused = true} />
      </TestWrapper>,
    );

    await waitFor(() => assertEquals(focused, true));

    // Press 'c'
    stdin.write("c");

    // Check clipboard content
    await waitFor(() => {
      assertEquals(capturedText.trim(), "Todo 1");
    });

    unmount();
    restore();
  },
});

Deno.test({
  name: "TodoList: 'c' should show failure toast when clipboard copy fails",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const restore = setupFailingClipboardMock("clipboard unavailable");

    const todo1 = new Todo("Todo 1");
    let focused = false;

    const { unmount, stdin, lastFrame } = render(
      <TestWrapper initialTodos={[todo1]}>
        <AppContentMock />
        <FocusObserver onFocused={() => focused = true} />
      </TestWrapper>,
    );

    await waitFor(() => assertEquals(focused, true));

    stdin.write("c");

    await waitFor(() => {
      assertEquals(
        lastFrame()?.includes("Copy failed: clipboard unavailable"),
        true,
      );
    });
    assertEquals(lastFrame()?.includes("Todo copied"), false);

    unmount();
    restore();
  },
});

Deno.test({
  name: "TodoList: should show WelcomeScreen when no todos and no search",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { unmount, lastFrame } = render(
      <TestWrapper initialTodos={[]}>
        <AppContentMock />
      </TestWrapper>,
    );

    await waitFor(() => {
      const frame = lastFrame();
      assertEquals(frame?.includes("Douglas Adams"), true);
      assertEquals(frame?.includes("Press 'n' to create a new todo"), true);
    });

    unmount();
  },
});

Deno.test({
  name:
    "TodoList: should show SearchEmptyState when search has no results (with todos)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const todos = [new Todo("Task A")];
    const { unmount, lastFrame } = render(
      <TestWrapper initialTodos={todos}>
        <SearchQuerySetter query="xyz123" />
        <AppContentMock />
      </TestWrapper>,
    );

    await waitFor(() => {
      const frame = lastFrame();
      assertEquals(frame?.includes("No results found for"), true);
      assertEquals(frame?.includes("xyz123"), true);
      assertEquals(frame?.includes("Douglas Adams"), false);
    });

    unmount();
  },
});

Deno.test({
  name:
    "TodoList: should show SearchEmptyState when search has no results (empty list)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { unmount, lastFrame } = render(
      <TestWrapper initialTodos={[]}>
        <SearchQuerySetter query="abc" />
        <AppContentMock />
      </TestWrapper>,
    );

    await waitFor(() => {
      const frame = lastFrame();
      assertEquals(frame?.includes("No results found for"), true);
      assertEquals(frame?.includes("abc"), true);
      assertEquals(frame?.includes("Douglas Adams"), false);
    });

    unmount();
  },
});

Deno.test({
  name: "TodoList: should scroll selected todo into view after search cancel",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const todos = Array.from(
      { length: 100 },
      (_, i) => new Todo(`Task ${String(i + 1).padStart(3, "0")}`),
    );
    let nav: NavigationContextType = null!;

    const { unmount, lastFrame, rerender } = render(
      <TestWrapper initialTodos={todos}>
        <SearchQuerySetter query="Task 099" />
        <AppContentMock />
        <NavController onNav={(n) => nav = n} />
      </TestWrapper>,
    );

    await waitFor(() => {
      const selectedTodo = todos.find((t) => t.id === nav.selectedTodoId);
      assertEquals(selectedTodo?.text, "Task 099");
      assertEquals(lastFrame()?.includes("Task 099"), true);
    });

    rerender(
      <TestWrapper initialTodos={todos}>
        <SearchQuerySetter query="" />
        <AppContentMock />
        <NavController onNav={(n) => nav = n} />
      </TestWrapper>,
    );

    await waitFor(() => {
      assertEquals(lastFrame()?.includes("Task 099"), true);
    }, { timeout: 2000 });

    unmount();
  },
});

Deno.test({
  name: "TodoList: double click on checkbox toggles todo",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const todo = new Todo("Toggle by bracket");
    let capturedTodos: Todo[] = [todo];

    const { unmount, stdin } = render(
      <TestWrapper
        initialTodos={[todo]}
        onTodosChange={(todos) => capturedTodos = todos}
      >
        <AppContentMock todos={[todo]} />
      </TestWrapper>,
    );

    // One uncategorized todo renders under the "None" header.
    // maxDigits=1 => checkbox columns are x=4..6, todo row y=2.
    stdin.write("\x1b[<0;4;2M");
    stdin.write("\x1b[<0;4;2M");

    await waitFor(() => {
      assertEquals(capturedTodos[0].isDone(), true);
    });

    unmount();
  },
});

Deno.test({
  name: "TodoList: double click on text opens edit modal",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const todo = new Todo("Edit by text");
    let capturedTodos: Todo[] = [todo];

    const { unmount, stdin, lastFrame } = render(
      <TestWrapper
        initialTodos={[todo]}
        onTodosChange={(todos) => capturedTodos = todos}
      >
        <AppContentMock todos={[todo]} />
      </TestWrapper>,
    );

    // Click outside checkbox zone on the todo row below the "None" header.
    stdin.write("\x1b[<0;10;2M");
    stdin.write("\x1b[<0;10;2M");

    await waitFor(() => {
      assertEquals(lastFrame()?.includes("Edit Todo Modal"), true);
      assertEquals(capturedTodos[0].isDone(), false);
    });

    unmount();
  },
});

Deno.test({
  name:
    "TodoList: should scroll multi-selection range into view after search cancel",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const todos = Array.from(
      { length: 100 },
      (_, i) => new Todo(`Task ${String(i + 1).padStart(3, "0")}`),
    );
    let nav: NavigationContextType = null!;

    let focusedTag: string | undefined;
    const { unmount, lastFrame, stdin } = render(
      <TestWrapper initialTodos={todos}>
        <AppContentMock todos={[...todos]} />
        <NavController onNav={(n) => nav = n} />
        <FocusObserver onFocused={(tag) => focusedTag = tag} />
      </TestWrapper>,
    );

    // Wait for initial focus
    await waitFor(() => {
      assertEquals(focusedTag, "todo-list");
    });

    // 1. Focus search and type "Task 09"
    stdin.write("/");

    // Wait for search to be focused
    await waitFor(() => {
      assertEquals(focusedTag, "search-input");
    });

    stdin.write("Task 09");

    // Filtered list will have Task 090, 091... 099
    // Wait for filter to apply
    await waitFor(() => {
      const frame = lastFrame();

      assertEquals(frame?.includes("Task 090"), true);
      assertEquals(frame?.includes("Task 097"), true);
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
      assertEquals(nav.selectedTodoIds.has(t090.id), true);
      assertEquals(nav.selectedTodoIds.has(t095.id), true);
    });

    // 3. Clear search via Escape (should clear search and focus list)
    stdin.write("\u001B");

    await waitFor(() => {
      const frame = lastFrame();

      // At least the cursor (095) should be in view
      assertEquals(frame?.includes("Task 095"), true);
      // And ideally some other parts of the range
      assertEquals(frame?.includes("Task 090"), true);
    }, { timeout: 10000 });

    unmount();
  },
});
