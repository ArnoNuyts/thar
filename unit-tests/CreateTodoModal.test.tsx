import { render } from "ink-testing-library";
import { assertEquals, assertMatch, assertNotMatch } from "@std/assert";
import { useEffect } from "react";
import { Box } from "ink";

import { CreateTodoModal } from "../components/CreateTodoModal.tsx";
import { useModal } from "../contexts/modal-context.tsx";
import { Todo } from "../logic/todo.ts";
import { waitFor } from "./test-utils.ts";
import { FocusObserver, TestWrapper } from "./test-components.tsx";
import { SearchProvider, useSearch } from "../contexts/search-context.tsx";

const activeButtonLabel = (label: string) => `\u00ab ${label} \u00bb`;
const inactiveButtonLabel = (label: string) => `\u2039 ${label} \u203a`;

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
        <FocusObserver onFocused={(tag) => (focusedTag = tag)} />
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

  await waitFor(() => {
    assertMatch(lastFrame() || "", /Create new todo/);
    assertEquals(focusedTag, "create-todo-input");
  });

  stdin.write("New Todo Item");

  await waitFor(() => {
    assertMatch(lastFrame() || "", /New Todo Item/);
  });

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

  await waitFor(() => {
    assertMatch(lastFrame() || "", /Create new todo/);
    assertMatch(lastFrame() || "", /\+work/);
    assertMatch(lastFrame() || "", /@home/);
  });

  unmount();
});

Deno.test("CreateTodoModal: mouse hover and click should use the visible button row", async () => {
  let activeModalName: string | null = null;

  const TestComponent = () => {
    const { openModal, activeModal } = useModal();
    useEffect(() => {
      openModal("create-todo");
    }, [openModal]);

    useEffect(() => {
      activeModalName = activeModal;
    }, [activeModal]);

    return (
      <Box flexDirection="column" height={25} width={101}>
        {activeModal === "create-todo" && <CreateTodoModal />}
      </Box>
    );
  };

  const { unmount, lastFrame, stdin } = render(
    <SearchProvider>
      <TestWrapper>
        <TestComponent />
      </TestWrapper>
    </SearchProvider>,
  );

  await waitFor(() => {
    assertMatch(lastFrame() || "", /Create new todo/);
    assertNotMatch(lastFrame() || "", new RegExp(activeButtonLabel("Cancel")));
  });

  stdin.write("\x1b[<35;60;13M");

  await waitFor(() => {
    assertMatch(lastFrame() || "", new RegExp(activeButtonLabel("Cancel")));
  });

  stdin.write("\x1b[<0;60;13M");

  await waitFor(() => {
    assertEquals(activeModalName, null);
  });

  unmount();
});

Deno.test("CreateTodoModal: mouse hover should stay aligned when help text wraps", async () => {
  const TestComponent = () => {
    const { openModal, activeModal } = useModal();
    useEffect(() => {
      openModal("create-todo");
    }, [openModal]);

    return (
      <Box flexDirection="column" height={25} width={61}>
        {activeModal === "create-todo" && <CreateTodoModal />}
      </Box>
    );
  };

  const { unmount, lastFrame, stdin } = render(
    <SearchProvider>
      <TestWrapper>
        <TestComponent />
      </TestWrapper>
    </SearchProvider>,
  );

  await waitFor(() => {
    assertMatch(lastFrame() || "", /Create new todo/);
    assertNotMatch(lastFrame() || "", new RegExp(activeButtonLabel("Cancel")));
  });

  stdin.write("\x1b[<35;36;13M");

  await waitFor(() => {
    assertMatch(lastFrame() || "", new RegExp(activeButtonLabel("Cancel")));
  });

  unmount();
});

Deno.test("CreateTodoModal: Tab should toggle buttons without blurring the input", async () => {
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
        <FocusObserver onFocused={(tag) => (focusedTag = tag)} />
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

  await waitFor(() => {
    assertMatch(lastFrame() || "", /Create new todo/);
    assertEquals(focusedTag, "create-todo-input");
    assertMatch(lastFrame() || "", new RegExp(activeButtonLabel("Save")));
    assertMatch(lastFrame() || "", new RegExp(inactiveButtonLabel("Cancel")));
  });

  stdin.write("Alpha");

  await waitFor(() => {
    assertMatch(lastFrame() || "", /Alpha/);
  });

  stdin.write("\t");

  await waitFor(() => {
    assertEquals(focusedTag, "create-todo-input");
    assertMatch(lastFrame() || "", new RegExp(activeButtonLabel("Cancel")));
    assertMatch(lastFrame() || "", new RegExp(inactiveButtonLabel("Save")));
  });

  stdin.write(" ");
  stdin.write("beta");

  await waitFor(() => {
    assertEquals(focusedTag, "create-todo-input");
    assertMatch(lastFrame() || "", /Alpha beta/);
  });

  stdin.write("\t");

  await waitFor(() => {
    assertEquals(focusedTag, "create-todo-input");
    assertMatch(lastFrame() || "", new RegExp(activeButtonLabel("Save")));
    assertMatch(lastFrame() || "", new RegExp(inactiveButtonLabel("Cancel")));
  });

  stdin.write("\r");

  await waitFor(() => {
    assertEquals(addedText, "Alpha beta");
  });

  unmount();
});
