import { assertEquals } from "@std/assert";
import { Box, Text } from "ink";
import { render } from "ink-testing-library";

import { Todo } from "../logic/todo.ts";
import type { Todos } from "../logic/Todos.ts";
import { MockTodoProvider } from "./mock-todo-provider.tsx";
import { waitFor } from "./test-utils.ts";
import {
  FocusObserver,
  NavController,
  SelectionStateObserver,
} from "./test-components.tsx";

import { ActionBar } from "../components/ActionBar.tsx";
import { ConfirmModal } from "../components/ConfirmModal.tsx";
import { SetPriorityModal } from "../components/SetPriorityModal.tsx";
import { TodoList } from "../components/TodoList.tsx";
import { MultiSelectMenu, TodoMenu } from "../components/TodoMenu.tsx";

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
import { useTodo } from "../contexts/todo-context.tsx";

const NavigationWrapper = ({ children }: { children: React.ReactNode }) => {
  const { todos } = useTodo();
  return (
    <NavigationProvider todos={todos} listHeightForTest={10}>
      {children}
    </NavigationProvider>
  );
};

const ModalHost = () => {
  const { activeModal, modalData } = useModal();
  return (
    <>
      {activeModal === "confirm-modal" && isConfirmModalData(modalData) && (
        <ConfirmModal
          title={modalData.title}
          message={modalData.message}
          onConfirm={modalData.onConfirm}
          onCancel={modalData.onCancel}
        />
      )}
      {activeModal === "todo-menu" && <TodoMenu />}
      {activeModal === "multi-select-menu" && <MultiSelectMenu />}
      {activeModal === "set-priority" && <SetPriorityModal />}
      {activeModal === "set-due-date" && <Text>Set Due Date Modal</Text>}
      {activeModal === "set-threshold-date" && (
        <Text>Set Threshold Date Modal</Text>
      )}
      {activeModal === "set-recurrence" && <Text>Set Recurrence Modal</Text>}
    </>
  );
};

const renderHarness = (
  initialTodos: Todo[],
  onTodosChange: (todos: Todos) => void,
) => {
  let nav: NavigationContextType = null!;
  let selectedCount = 0;
  let focusedTag: string | undefined;
  const result = render(
    <ToasterProvider>
      <MockTodoProvider
        initialTodos={initialTodos}
        onTodosChange={onTodosChange}
      >
        <FocusProvider>
          <SuggestionProvider>
            <SearchProvider>
              <NavigationWrapper>
                <ModalProvider>
                  <Box flexDirection="column" height={25} position="relative">
                    <TodoList />
                    <ActionBar />
                    <ModalHost />
                    <NavController onNav={(value) => (nav = value)} />
                    <SelectionStateObserver
                      onSelectionChange={(state) =>
                        (selectedCount = state.rangeIds.size)
                      }
                    />
                    <FocusObserver onFocused={(tag) => (focusedTag = tag)} />
                  </Box>
                </ModalProvider>
              </NavigationWrapper>
            </SearchProvider>
          </SuggestionProvider>
        </FocusProvider>
      </MockTodoProvider>
    </ToasterProvider>,
  );

  return {
    ...result,
    getNav: () => nav,
    getSelectedCount: () => selectedCount,
    getFocusedTag: () => focusedTag,
  };
};

const waitForVisibleList = async (lastFrame: () => string | undefined) => {
  await waitFor(() => {
    assertEquals(lastFrame()?.includes("Todo 1"), true);
  });
};

const todoSignature = (todos: Todos) =>
  todos
    .map((todo) => `${todo.text}:${todo.priority ?? "-"}:${todo.isDone()}`)
    .join("|");

Deno.test({
  name: "Todo commands: list and menu toggle the same selection",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const listResult: string[] = [];
    {
      const initial = [new Todo("Todo 1"), new Todo("Todo 2")];
      let captured = [...initial];
      const harness = renderHarness(initial, (todos) => (captured = todos));
      await waitForVisibleList(harness.lastFrame);
      harness.getNav().navigateDown(true);
      await waitFor(() => assertEquals(harness.getSelectedCount(), 2));

      harness.stdin.write(" ");
      await waitFor(() => {
        assertEquals(
          captured.every((todo) => todo.isDone()),
          true,
        );
      });
      listResult.push(todoSignature(captured));
      harness.unmount();
    }

    {
      const initial = [new Todo("Todo 1"), new Todo("Todo 2")];
      let captured = [...initial];
      const harness = renderHarness(initial, (todos) => (captured = todos));
      await waitForVisibleList(harness.lastFrame);
      harness.getNav().navigateDown(true);
      await waitFor(() => assertEquals(harness.getSelectedCount(), 2));

      harness.stdin.write("x");
      await waitFor(() =>
        assertEquals(harness.lastFrame()?.includes("Multi-select menu"), true),
      );
      harness.stdin.write(" ");
      await waitFor(() => {
        assertEquals(
          captured.every((todo) => todo.isDone()),
          true,
        );
      });
      listResult.push(todoSignature(captured));
      harness.unmount();
    }

    assertEquals(listResult.length, 2);
    assertEquals(listResult[0], listResult[1]);
  },
});

Deno.test({
  name: "Todo commands: list and menu delete the same selection",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const listResult: string[] = [];
    {
      const initial = [new Todo("Todo 1"), new Todo("Todo 2")];
      let captured = [...initial];
      const harness = renderHarness(initial, (todos) => (captured = todos));
      await waitForVisibleList(harness.lastFrame);
      harness.getNav().navigateDown(true);
      await waitFor(() => assertEquals(harness.getSelectedCount(), 2));

      harness.stdin.write("\x1b[3~");
      await waitFor(() =>
        assertEquals(harness.lastFrame()?.includes("Delete Todos"), true),
      );
      harness.stdin.write("\r");
      await waitFor(() => assertEquals(captured.length, 0));
      listResult.push(todoSignature(captured));
      harness.unmount();
    }

    {
      const initial = [new Todo("Todo 1"), new Todo("Todo 2")];
      let captured = [...initial];
      const harness = renderHarness(initial, (todos) => (captured = todos));
      await waitForVisibleList(harness.lastFrame);
      harness.getNav().navigateDown(true);
      await waitFor(() => assertEquals(harness.getSelectedCount(), 2));

      harness.stdin.write("x");
      await waitFor(() =>
        assertEquals(harness.lastFrame()?.includes("Multi-select menu"), true),
      );
      harness.stdin.write("\x1b[3~");
      await waitFor(() =>
        assertEquals(harness.lastFrame()?.includes("Delete Todos"), true),
      );
      harness.stdin.write("\r");
      await waitFor(() => assertEquals(captured.length, 0));
      listResult.push(todoSignature(captured));
      harness.unmount();
    }

    assertEquals(listResult.length, 2);
    assertEquals(listResult[0], listResult[1]);
  },
});

Deno.test({
  name: "Todo commands: list and menu archive through the same confirmation",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const confirmations: string[] = [];

    {
      const initial = [new Todo("Todo 1")];
      const harness = renderHarness(initial, () => {});
      await waitForVisibleList(harness.lastFrame);

      harness.stdin.write("a");
      await waitFor(() =>
        assertEquals(
          harness
            .lastFrame()
            ?.includes("Archive all completed todos to done.txt?"),
          true,
        ),
      );
      confirmations.push(harness.lastFrame() ?? "");
      harness.unmount();
    }

    {
      const initial = [new Todo("Todo 1")];
      const harness = renderHarness(initial, () => {});
      await waitForVisibleList(harness.lastFrame);

      harness.stdin.write("x");
      await waitFor(() =>
        assertEquals(harness.lastFrame()?.includes("Todo menu"), true),
      );
      harness.stdin.write("a");
      await waitFor(() =>
        assertEquals(
          harness
            .lastFrame()
            ?.includes("Archive all completed todos to done.txt?"),
          true,
        ),
      );
      confirmations.push(harness.lastFrame() ?? "");
      harness.unmount();
    }

    assertEquals(confirmations.length, 2);
    assertEquals(
      confirmations[0].includes("Archive all completed todos to done.txt?"),
      true,
    );
    assertEquals(
      confirmations[1].includes("Archive all completed todos to done.txt?"),
      true,
    );
  },
});

Deno.test({
  name: "Todo commands: list and menu set the same priority on a selection",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const listResult: string[] = [];
    {
      const initial = [new Todo("Todo 1"), new Todo("Todo 2")];
      let captured = [...initial];
      const harness = renderHarness(initial, (todos) => (captured = todos));
      await waitForVisibleList(harness.lastFrame);
      harness.getNav().navigateDown(true);
      await waitFor(() => assertEquals(harness.getSelectedCount(), 2));

      harness.stdin.write("A");
      await waitFor(() => {
        assertEquals(
          captured.every((todo) => todo.priority === "A"),
          true,
        );
      });
      listResult.push(todoSignature(captured));
      harness.unmount();
    }

    {
      const initial = [new Todo("Todo 1"), new Todo("Todo 2")];
      let captured = [...initial];
      const harness = renderHarness(initial, (todos) => (captured = todos));
      await waitForVisibleList(harness.lastFrame);
      harness.getNav().navigateDown(true);
      await waitFor(() => assertEquals(harness.getSelectedCount(), 2));

      harness.stdin.write("x");
      await waitFor(() =>
        assertEquals(harness.lastFrame()?.includes("Multi-select menu"), true),
      );
      harness.stdin.write("p");
      await waitFor(() =>
        assertEquals(harness.lastFrame()?.includes("Set Priority"), true),
      );
      await waitFor(() =>
        assertEquals(harness.getFocusedTag(), "set-priority-modal"),
      );
      harness.stdin.write("\r");
      await waitFor(() => {
        assertEquals(
          captured.every((todo) => todo.priority === "A"),
          true,
        );
      });
      listResult.push(todoSignature(captured));
      harness.unmount();
    }

    assertEquals(listResult.length, 2);
    assertEquals(listResult[0], listResult[1]);
  },
});
