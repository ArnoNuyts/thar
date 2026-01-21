import { assertEquals, assertMatch } from "@std/assert";
import { Box, Text } from "ink";
import { render } from "ink-testing-library";

import { Todo } from "../logic/todo.ts";
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
import { SearchProvider } from "../contexts/search-context.tsx";
import { SuggestionProvider } from "../contexts/suggestion-context.tsx";
import { ToasterProvider } from "../contexts/toaster-context.tsx";
import { TodoMenu } from "../components/TodoMenu.tsx";

import { useTodo } from "../contexts/todo-context.tsx";

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
const AppContentMock = () => {
  const { activeModal, modalData } = useModal();
  return (
    <Box flexDirection="column" position="relative" height={25}>
      <HiddenIndicator />
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
      {activeModal === "set-due-date" && <SetDateModal type="due" />}
      {activeModal === "set-threshold-date" &&
        <SetDateModal type="threshold" />}
      {activeModal === "set-recurrence" && <SetRecurrenceModal />}
      {activeModal === "todo-menu" && <TodoMenu />}
    </Box>
  );
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
        <AppContentMock />
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
        <AppContentMock />
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
        <AppContentMock />
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
        <AppContentMock />
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
        <AppContentMock />
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
        <AppContentMock />
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
        <AppContentMock />
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
        <AppContentMock />
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
        <AppContentMock />
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
        <AppContentMock />
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
        <AppContentMock />
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
        <AppContentMock />
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
        <AppContentMock />
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
        <AppContentMock />
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
        <AppContentMock />
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
