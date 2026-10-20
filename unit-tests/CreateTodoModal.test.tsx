import { expect, test } from "vitest";
import { render } from "ink-testing-library";

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

test("CreateTodoModal: should render and handle input", async () => {
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
    expect(lastFrame() || "").toMatch(/Create new todo/);
    expect(focusedTag).toEqual("create-todo-input");
  });

  stdin.write("New Todo Item");

  await waitFor(() => {
    expect(lastFrame() || "").toMatch(/New Todo Item/);
  });

  stdin.write("\r");

  await waitFor(() => {
    expect(addedText).toEqual("New Todo Item");
  });

  unmount();
});

test("CreateTodoModal: should prefill context from search query", async () => {
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
    expect(lastFrame() || "").toMatch(/Create new todo/);
    expect(lastFrame() || "").toMatch(/@home/);
  });

  unmount();
});

test("CreateTodoModal: should prefill project from search query", async () => {
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
    expect(lastFrame() || "").toMatch(/Create new todo/);
    expect(lastFrame() || "").toMatch(/\+work/);
  });

  unmount();
});

test("CreateTodoModal: should prefill multiple tags and contexts from search query", async () => {
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
    expect(lastFrame() || "").toMatch(/Create new todo/);
    expect(lastFrame() || "").toMatch(/\+work/);
    expect(lastFrame() || "").toMatch(/@home/);
  });

  unmount();
});

test("CreateTodoModal: mouse hover and click should use the visible button row", async () => {
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
    expect(lastFrame() || "").toMatch(/Create new todo/);
    expect(lastFrame() || "").not.toMatch(
      new RegExp(activeButtonLabel("Cancel")),
    );
  });

  stdin.write("\x1b[<35;60;13M");

  await waitFor(() => {
    expect(lastFrame() || "").toMatch(new RegExp(activeButtonLabel("Cancel")));
  });

  stdin.write("\x1b[<0;60;13M");

  await waitFor(() => {
    expect(activeModalName).toEqual(null);
  });

  unmount();
});

test("CreateTodoModal: mouse hover should stay aligned when help text wraps", async () => {
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
    expect(lastFrame() || "").toMatch(/Create new todo/);
    expect(lastFrame() || "").not.toMatch(
      new RegExp(activeButtonLabel("Cancel")),
    );
  });

  stdin.write("\x1b[<35;36;13M");

  await waitFor(() => {
    expect(lastFrame() || "").toMatch(new RegExp(activeButtonLabel("Cancel")));
  });

  unmount();
});

test("CreateTodoModal: Tab should toggle buttons without blurring the input", async () => {
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
    expect(lastFrame() || "").toMatch(/Create new todo/);
    expect(focusedTag).toEqual("create-todo-input");
    expect(lastFrame() || "").toMatch(new RegExp(activeButtonLabel("Save")));
    expect(lastFrame() || "").toMatch(
      new RegExp(inactiveButtonLabel("Cancel")),
    );
  });

  stdin.write("Alpha");

  await waitFor(() => {
    expect(lastFrame() || "").toMatch(/Alpha/);
  });

  stdin.write("\t");

  await waitFor(() => {
    expect(focusedTag).toEqual("create-todo-input");
    expect(lastFrame() || "").toMatch(new RegExp(activeButtonLabel("Cancel")));
    expect(lastFrame() || "").toMatch(new RegExp(inactiveButtonLabel("Save")));
  });

  stdin.write(" ");
  stdin.write("beta");

  await waitFor(() => {
    expect(focusedTag).toEqual("create-todo-input");
    expect(lastFrame() || "").toMatch(/Alpha beta/);
  });

  stdin.write("\t");

  await waitFor(() => {
    expect(focusedTag).toEqual("create-todo-input");
    expect(lastFrame() || "").toMatch(new RegExp(activeButtonLabel("Save")));
    expect(lastFrame() || "").toMatch(
      new RegExp(inactiveButtonLabel("Cancel")),
    );
  });

  stdin.write("\r");

  await waitFor(() => {
    expect(addedText).toEqual("Alpha beta");
  });

  unmount();
});
