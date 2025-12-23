import { render } from "ink-testing-library";
import { assertEquals } from "@std/assert";
import { delay } from "@std/async";
import { useEffect } from "react";
import { Box, Text } from "ink";

import { Todo } from "../logic/todo.ts";
import { restoreDenoMocks, waitFor } from "./test-utils.ts";
import { MockTodoProvider } from "./mock-todo-provider.tsx";

import { TodoList } from "../components/TodoList.tsx";
import { ActionBar } from "../components/ActionBar.tsx";
import { ConfirmModal } from "../components/ConfirmModal.tsx";

import { useTodo } from "../contexts/todo-context.tsx";
import { FocusProvider, useFocusManager } from "../contexts/focus-context.tsx";
import { SuggestionProvider } from "../contexts/suggestion-context.tsx";
import { SearchProvider } from "../contexts/search-context.tsx";
import { ToasterProvider } from "../contexts/toaster-context.tsx";
import {
  NavigationProvider,
  useNavigation,
} from "../contexts/navigation-context.tsx";
import {
  isConfirmModalData,
  ModalProvider,
  useModal,
} from "../contexts/modal-context.tsx";

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

// Helper component to observe selection state (by ID)
const SelectionObserver = ({
  onSelectionIdChange,
}: {
  onSelectionIdChange?: (id: symbol | undefined) => void;
}) => {
  const { selectedTodoId } = useNavigation();

  useEffect(() => {
    if (onSelectionIdChange) {
      onSelectionIdChange(selectedTodoId);
    }
  }, [selectedTodoId, onSelectionIdChange]);

  return null;
};

// Helper to observe focus
const FocusObserver = ({ onFocused }: { onFocused: () => void }) => {
  const { activeId } = useFocusManager();
  useEffect(() => {
    if (activeId) {
      // Give it time for useInput effect to run
      const timer = setTimeout(onFocused, 100);
      return () => clearTimeout(timer);
    }
  }, [activeId, onFocused]);
  return null;
};

// Mock App Content for TodoList tests
const AppContentMock = () => {
  const { activeModal, modalData } = useModal();
  return (
    <Box flexDirection="column">
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

    // Initial check: only visible todo should be shown, and [HIDDEN SHOWN] should NOT be present
    await waitFor(() => {
      const frame = lastFrame();
      assertEquals(frame?.includes("visible todo"), true);
      assertEquals(frame?.includes("hidden todo"), false);
      assertEquals(frame?.includes("[HIDDEN SHOWN]"), false);
      assertEquals(isFocused, true);
    });

    // Press 'H' to toggle showHidden
    stdin.write("H");

    // Check: both todos should be shown, and [HIDDEN SHOWN] should be present in ActionBar
    await waitFor(() => {
      const frame = lastFrame();
      assertEquals(frame?.includes("visible todo"), true);
      assertEquals(frame?.includes("hidden todo"), true);
      assertEquals(frame?.includes("[HIDDEN SHOWN]"), true);
    });

    // Press 'H' again to toggle back
    stdin.write("H");

    // Check: only visible todo should be shown again
    await waitFor(() => {
      const frame = lastFrame();
      assertEquals(frame?.includes("visible todo"), true);
      assertEquals(frame?.includes("hidden todo"), false);
      assertEquals(frame?.includes("[HIDDEN SHOWN]"), false);
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
      assertEquals(currentSelectionId, capturedTodos[2].id);
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
    await delay(100);
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

    // Press 'n'
    stdin.write("n");

    // Should show Create Todo modal
    await waitFor(() => {
      const frame = lastFrame();
      assertEquals(frame?.includes("Create Todo Modal"), true);
    });

    unmount();
  },
});
