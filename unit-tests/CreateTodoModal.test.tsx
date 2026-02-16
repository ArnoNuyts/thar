import { render } from "ink-testing-library";
import { assertEquals, assertMatch } from "@std/assert";
import { useEffect } from "react";
import { Box } from "ink";

import { CreateTodoModal } from "../components/CreateTodoModal.tsx";
import { useModal } from "../contexts/modal-context.tsx";
import { Todo } from "../logic/todo.ts";
import { waitFor } from "./test-utils.ts";
import { FocusObserver, TestWrapper } from "./test-components.tsx";
import { SearchProvider, useSearch } from "../contexts/search-context.tsx";

Deno.test("CreateTodoModal: should render and handle input", async () => {
  let focusedTag: string | undefined;
  let addedText = "";

  const TestComponent = () => {
    const { openModal, activeModal } = useModal();
    useEffect(() => {
      openModal("create-todo");
    }, [openModal]);

    return (
      <Box flexDirection="column" height={20} width={80}>
        {activeModal === "create-todo" && <CreateTodoModal />}
        <FocusObserver onFocused={(tag) => focusedTag = tag} />
      </Box>
    );
  };

  const { unmount, lastFrame, stdin } = render(
    <SearchProvider>
      <TestWrapper
        todoValue={{
          addTodos: (text: string) => {
            addedText = text;
            return [new Todo(text)];
          },
        }}
      >
        <TestComponent />
      </TestWrapper>
    </SearchProvider>,
  );

  // Wait for title and focus
  await waitFor(() => {
    assertMatch(lastFrame() || "", /Create new todo/);
    assertEquals(focusedTag, "create-todo-input");
  });

  // Type text
  stdin.write("New Todo Item");

  await waitFor(() => {
    assertMatch(lastFrame() || "", /New Todo Item/);
  });

  // Press Enter to submit
  stdin.write("\r");

  await waitFor(() => {
    assertEquals(addedText, "New Todo Item");
  });

  unmount();
});

Deno.test("CreateTodoModal: should prefill context from search query", async () => {
  const TestComponent = () => {
    const { openModal, activeModal } = useModal();
    const { setSearchQuery } = useSearch();

    useEffect(() => {
      setSearchQuery("@home");
      openModal("create-todo");
    }, [openModal, setSearchQuery]);

    return (
      <Box flexDirection="column" height={20} width={80}>
        {activeModal === "create-todo" && <CreateTodoModal />}
      </Box>
    );
  };

  const { unmount, lastFrame } = render(
    <SearchProvider>
      <TestWrapper>
        <TestComponent />
      </TestWrapper>
    </SearchProvider>,
  );

  // Wait for modal to render with prefilled context
  await waitFor(() => {
    assertMatch(lastFrame() || "", /Create new todo/);
    assertMatch(lastFrame() || "", /@home/);
  });

  unmount();
});

Deno.test("CreateTodoModal: should prefill project from search query", async () => {
  const TestComponent = () => {
    const { openModal, activeModal } = useModal();
    const { setSearchQuery } = useSearch();

    useEffect(() => {
      setSearchQuery("+work");
      openModal("create-todo");
    }, [openModal, setSearchQuery]);

    return (
      <Box flexDirection="column" height={20} width={80}>
        {activeModal === "create-todo" && <CreateTodoModal />}
      </Box>
    );
  };

  const { unmount, lastFrame } = render(
    <SearchProvider>
      <TestWrapper>
        <TestComponent />
      </TestWrapper>
    </SearchProvider>,
  );

  // Wait for modal to render with prefilled project
  await waitFor(() => {
    assertMatch(lastFrame() || "", /Create new todo/);
    assertMatch(lastFrame() || "", /\+work/);
  });

  unmount();
});

Deno.test("CreateTodoModal: should prefill multiple tags and contexts from search query", async () => {
  const TestComponent = () => {
    const { openModal, activeModal } = useModal();
    const { setSearchQuery } = useSearch();

    useEffect(() => {
      setSearchQuery("+work @home");
      openModal("create-todo");
    }, [openModal, setSearchQuery]);

    return (
      <Box flexDirection="column" height={20} width={80}>
        {activeModal === "create-todo" && <CreateTodoModal />}
      </Box>
    );
  };

  const { unmount, lastFrame } = render(
    <SearchProvider>
      <TestWrapper>
        <TestComponent />
      </TestWrapper>
    </SearchProvider>,
  );

  // Wait for modal to render with both tags prefilled
  await waitFor(() => {
    assertMatch(lastFrame() || "", /Create new todo/);
    assertMatch(lastFrame() || "", /\+work/);
    assertMatch(lastFrame() || "", /@home/);
  });

  unmount();
});
