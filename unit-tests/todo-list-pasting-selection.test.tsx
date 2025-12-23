import { render } from "ink-testing-library";
import { assertEquals } from "@std/assert";
import { TodoList } from "../components/TodoList.tsx";
import { FocusProvider } from "../contexts/focus-context.tsx";
import { SuggestionProvider } from "../contexts/suggestion-context.tsx";
import { SearchProvider } from "../contexts/search-context.tsx";
import { ToasterProvider } from "../contexts/toaster-context.tsx";
import { MockTodoProvider } from "./mock-todo-provider.tsx";
import { Todo } from "../logic/todo.ts";
import { restoreDenoMocks, waitFor } from "./test-utils.ts";
import { useEffect } from "react";
import { Box } from "ink";
import { useFocusManager } from "../contexts/focus-context.tsx";
import {
  isConfirmModalData,
  ModalProvider,
  useModal,
} from "../contexts/modal-context.tsx";
import { ConfirmModal } from "../components/ConfirmModal.tsx";
import {
  NavigationProvider,
  useNavigation,
} from "../contexts/navigation-context.tsx";
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

// Component to observe selection
const SelectionObserver = (
  { onSelectionChanged }: {
    onSelectionChanged: (id: symbol | undefined) => void;
  },
) => {
  const { selectedTodoId } = useNavigation();
  useEffect(() => {
    onSelectionChanged(selectedTodoId);
  }, [selectedTodoId, onSelectionChanged]);
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
    </Box>
  );
};

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
      <ToasterProvider>
        <MockTodoProvider
          initialTodos={initialTodos}
          onTodosChange={(todos) => capturedTodos = todos}
        >
          <FocusProvider>
            <SuggestionProvider>
              <SearchProvider>
                <NavigationWrapper>
                  <SelectionObserver
                    onSelectionChanged={(id) => currentSelectionId = id}
                  />
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
