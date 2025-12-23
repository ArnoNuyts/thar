import { render } from "ink-testing-library";
import { assertEquals } from "@std/assert";
import { TodoList } from "../components/TodoList.tsx";
import { FocusProvider } from "../contexts/focus-context.tsx";
import { SuggestionProvider } from "../contexts/suggestion-context.tsx";
import { SearchProvider } from "../contexts/search-context.tsx";
import { ToasterProvider } from "../contexts/toaster-context.tsx";
import { MockTodoProvider } from "./mock-todo-provider.tsx";
import { Todo } from "../logic/todo.ts";
import { waitFor } from "./test-utils.ts";
import { useEffect } from "react";
import { Box } from "ink";
import { useFocusManager } from "../contexts/focus-context.tsx";
import {
  ModalProvider,
} from "../contexts/modal-context.tsx";
import { NavigationProvider } from "../contexts/navigation-context.tsx";
import { useTodo } from "../contexts/todo-context.tsx";
import { ActionBar } from "../components/ActionBar.tsx";

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
  return (
    <Box flexDirection="column">
      <TodoList />
      <ActionBar />
    </Box>
  );
};

Deno.test({
  name: "TodoList: 'H' should toggle show hidden todos global state",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const todoVisible = new Todo("visible todo");
    const todoHidden = new Todo("h:1 hidden todo");
    const initialTodos = [todoVisible, todoHidden];

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
