import { assertEquals } from "@std/assert";
import { render } from "ink-testing-library";

import { TodoList } from "../components/TodoList.tsx";
import { FocusProvider } from "../contexts/focus-context.tsx";
import { ModalProvider } from "../contexts/modal-context.tsx";
import { NavigationProvider } from "../contexts/navigation-context.tsx";
import { SearchProvider } from "../contexts/search-context.tsx";
import { SuggestionProvider } from "../contexts/suggestion-context.tsx";
import { ToasterProvider } from "../contexts/toaster-context.tsx";
import type { Todos } from "../logic/Todos.ts";
import { Todo } from "../logic/todo.ts";
import { MockTodoProvider } from "./mock-todo-provider.tsx";
import { waitFor } from "./test-utils.ts";

const Wrapper = (
  { todos, listHeight = 10 }: { todos: Todos; listHeight?: number },
) => (
  <ToasterProvider>
    <MockTodoProvider initialTodos={todos}>
      <FocusProvider>
        <SuggestionProvider>
          <SearchProvider>
            <NavigationProvider todos={todos} listHeightForTest={listHeight}>
              <ModalProvider>
                <TodoList />
              </ModalProvider>
            </NavigationProvider>
          </SearchProvider>
        </SuggestionProvider>
      </FocusProvider>
    </MockTodoProvider>
  </ToasterProvider>
);

Deno.test({
  name: "TodoItem: renders priority, tags, and checkbox segments",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const todo = new Todo(
      "(A) Ship it @home +work due:2020-01-01 t:2020-01-01 rec:1d",
    );

    const { lastFrame, unmount } = render(<Wrapper todos={[todo]} />);

    try {
      await waitFor(() => {
        const frame = lastFrame() ?? "";
        const segments = [
          "[ ]",
          "(A)",
          "Ship it",
          "@home",
          "+work",
          "due:2020-01-01",
          "t:2020-01-01",
          "rec:1d",
        ];
        for (const segment of segments) {
          assertEquals(
            frame.includes(segment),
            true,
            `Expected frame to include ${segment}`,
          );
        }

        // Segments are rendered in the same order as before the refactor.
        const positions = segments.map((segment) => frame.indexOf(segment));
        assertEquals(
          positions,
          [...positions].sort((a, b) => a - b),
        );
      });

      assertEquals(lastFrame()?.includes("[x]"), false);
      assertEquals(lastFrame()?.includes("(B)"), false);
    } finally {
      unmount();
    }
  },
});

Deno.test({
  name: "TodoItem: pads numbers to the width of the largest todo number",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const todos = Array.from(
      { length: 12 },
      (_, index) => new Todo(`Task ${index + 1}`),
    );

    const { lastFrame, unmount } = render(
      <Wrapper todos={todos} listHeight={20} />,
    );

    try {
      await waitFor(() => {
        const frame = lastFrame() ?? "";
        assertEquals(frame.includes("  1 [ ] Task 1"), true);
        assertEquals(frame.includes(" 10 [ ] Task 10"), true);
        assertEquals(frame.includes(" 12 [ ] Task 12"), true);
      });
    } finally {
      unmount();
    }
  },
});

Deno.test({
  name: "TodoItem: renders completed todos with a checked box",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const todo = new Todo("x Finished task");

    const { lastFrame, unmount } = render(<Wrapper todos={[todo]} />);

    try {
      await waitFor(() => {
        const frame = lastFrame() ?? "";
        assertEquals(frame.includes("[x] Finished task"), true);
      });
    } finally {
      unmount();
    }
  },
});
