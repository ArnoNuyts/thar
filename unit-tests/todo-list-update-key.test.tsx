import { Box } from "ink";
import { render } from "ink-testing-library";
import { useEffect } from "react";
import { expect, test } from "vitest";

import { TodoList } from "../components/TodoList.tsx";
import { FocusProvider } from "../contexts/focus-context.tsx";
import { ModalProvider, useModal } from "../contexts/modal-context.tsx";
import { NavigationProvider } from "../contexts/navigation-context.tsx";
import { SearchProvider } from "../contexts/search-context.tsx";
import { SuggestionProvider } from "../contexts/suggestion-context.tsx";
import { ToasterProvider } from "../contexts/toaster-context.tsx";
import { UpdateProvider } from "../contexts/update-context.tsx";
import { useTodo } from "../contexts/todo-context.tsx";
import { Todo } from "../logic/todo.ts";
import { MockTodoProvider } from "./mock-todo-provider.tsx";
import { waitFor, waitPast } from "./test-utils.ts";

const npmDescriptor = {
  scriptPath: "/usr/local/lib/node_modules/todotui/dist/main.js",
  env: {},
  platform: "linux" as const,
};

const NavigationWrapper = ({ children }: { children: React.ReactNode }) => {
  const { todos } = useTodo();
  return (
    <NavigationProvider todos={todos} listHeightForTest={10}>
      {children}
    </NavigationProvider>
  );
};

const Wrapper = ({
  children,
  initialTodos,
}: {
  children: React.ReactNode;
  initialTodos: Todo[];
}) => (
  <ToasterProvider>
    <MockTodoProvider initialTodos={initialTodos}>
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

const ModalObserver = ({
  onChange,
}: {
  onChange: (id: string | null) => void;
}) => {
  const { activeModal } = useModal();

  useEffect(() => {
    onChange(activeModal);
  }, [activeModal, onChange]);

  return null;
};

const renderTodoList = (
  status: "available" | "up-to-date",
  skippedVersion?: string,
) => {
  const todo = new Todo("Test todo");
  let activeModal: string | null = null;

  const result = render(
    <Wrapper initialTodos={[todo]}>
      <UpdateProvider
        options={{
          enabled: false,
          currentVersion: "0.4.0",
          initialState: {
            status,
            latestVersion: "0.5.0",
            skippedVersion,
          },
          installDescriptor: npmDescriptor,
        }}
      >
        <Box flexDirection="column" height={24}>
          <TodoList />
          <ModalObserver onChange={(id) => (activeModal = id)} />
        </Box>
      </UpdateProvider>
    </Wrapper>,
  );

  return { ...result, getActiveModal: () => activeModal };
};

test("TodoList: 'u' opens the update modal when an update is available", async () => {
  const { unmount, stdin, lastFrame, getActiveModal } =
    renderTodoList("available");

  await waitFor(() => {
    expect(lastFrame() || "").toMatch(/Test todo/);
  });

  stdin.write("u");

  await waitFor(() => {
    expect(getActiveModal()).toEqual("update-modal");
  });

  unmount();
});

test("TodoList: 'u' does nothing when the app is up to date", async () => {
  const { unmount, stdin, lastFrame, getActiveModal } =
    renderTodoList("up-to-date");

  await waitFor(() => {
    expect(lastFrame() || "").toMatch(/Test todo/);
  });

  stdin.write("u");
  await waitPast(50);

  expect(getActiveModal()).toBeNull();
  unmount();
});

test("TodoList: 'u' does nothing for a skipped version", async () => {
  const { unmount, stdin, lastFrame, getActiveModal } = renderTodoList(
    "available",
    "0.5.0",
  );

  await waitFor(() => {
    expect(lastFrame() || "").toMatch(/Test todo/);
  });

  stdin.write("u");
  await waitPast(50);

  expect(getActiveModal()).toBeNull();
  unmount();
});
