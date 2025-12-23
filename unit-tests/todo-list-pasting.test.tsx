import { render } from "ink-testing-library";
import { assertEquals } from "@std/assert";
import { delay } from "@std/async";
import { TodoList } from "../components/TodoList.tsx";
import { FocusProvider } from "../contexts/focus-context.tsx";
import { SuggestionProvider } from "../contexts/suggestion-context.tsx";
import { SearchProvider } from "../contexts/search-context.tsx";
import { ToasterProvider } from "../contexts/toaster-context.tsx";
import { MockTodoProvider } from "./mock-todo-provider.tsx";
import { Todo } from "../logic/todo.ts";
import { Todos } from "../logic/Todos.ts";
import { restoreDenoMocks, waitFor } from "./test-utils.ts";
import { useEffect } from "react";
import { Text } from "ink";
import { useFocusManager } from "../contexts/focus-context.tsx";
import {
  isConfirmModalData,
  ModalProvider,
  useModal,
} from "../contexts/modal-context.tsx";
import { ConfirmModal } from "../components/ConfirmModal.tsx";
import { NavigationProvider } from "../contexts/navigation-context.tsx";
import { useTodo } from "../contexts/todo-context.tsx";

// Wrapper to inject todos into NavigationProvider
const NavigationWrapper = ({ children }: { children: React.ReactNode }) => {
  const { todos } = useTodo();
  return (
    <NavigationProvider todos={todos} listHeightForTest={10}>
      {children}
    </NavigationProvider>
  );
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

const AppContentMock = () => {
  const { activeModal, modalData } = useModal();
  return (
    <Box flexDirection="column">
      <TodoList />
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

import { Box } from "ink";

// deno-lint-ignore no-explicit-any
const originalCommand = Deno.Command;

function setupClipboardMock(text: string) {
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = class {
    // deno-lint-ignore no-explicit-any
    command: string;
    constructor(command: string, _options: any) {
      this.command = command;
    }
    output() {
      if (
        this.command === "powershell.exe" || this.command === "pbpaste" ||
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
      <ToasterProvider>
        <MockTodoProvider
          initialTodos={initialTodos}
          onTodosChange={(todos) => capturedTodos = todos}
        >
          <FocusProvider>
            <SuggestionProvider>
              <SearchProvider>
                <NavigationWrapper>
                  <ModalProvider>
                    <AppContentMock />
                    <FocusObserver onFocused={() => isFocused = true} />
                  </ModalProvider>
                </NavigationWrapper>
              </SearchProvider>
            </SuggestionProvider>
          </FocusProvider>
        </MockTodoProvider>
      </ToasterProvider>,
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
      <ToasterProvider>
        <MockTodoProvider
          initialTodos={initialTodos}
          onTodosChange={(todos) => capturedTodos = todos}
        >
          <FocusProvider>
            <SuggestionProvider>
              <SearchProvider>
                <NavigationWrapper>
                  <ModalProvider>
                    <AppContentMock />
                    <FocusObserver onFocused={() => focusCount++} />
                  </ModalProvider>
                </NavigationWrapper>
              </SearchProvider>
            </SuggestionProvider>
          </FocusProvider>
        </MockTodoProvider>
      </ToasterProvider>,
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
      <ToasterProvider>
        <MockTodoProvider
          initialTodos={initialTodos}
        >
          <FocusProvider>
            <SuggestionProvider>
              <SearchProvider>
                <NavigationWrapper>
                  <ModalProvider>
                    <AppContentMock />
                    <FocusObserver onFocused={() => isFocused = true} />
                  </ModalProvider>
                </NavigationWrapper>
              </SearchProvider>
            </SuggestionProvider>
          </FocusProvider>
        </MockTodoProvider>
      </ToasterProvider>,
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
