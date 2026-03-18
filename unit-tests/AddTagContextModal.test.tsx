import { render } from "ink-testing-library";
import { assertEquals, assertMatch } from "@std/assert";
import { useEffect } from "react";
import { Box } from "ink";

import { AddTagContextModal } from "../components/AddTagContextModal.tsx";
import { useModal } from "../contexts/modal-context.tsx";
import { Todo } from "../logic/todo.ts";
import { waitFor } from "./test-utils.ts";
import { FocusObserver, TestWrapper } from "./test-components.tsx";
import { Todos } from "../logic/Todos.ts";

Deno.test("AddTagContextModal: should render projects correctly", async () => {
  const t1 = new Todo("Todo 1 +work");
  const t2 = new Todo("Todo 2 +work +personal");
  const t3 = new Todo("Todo 3");
  const todos = new Todos(t1, t2, t3);

  const TestComponent = () => {
    const { openModal, activeModal } = useModal();
    useEffect(() => {
      openModal("add-project");
    }, [openModal]);

    return (
      <Box flexDirection="column" height={20} width={80}>
        {activeModal === "add-project" && <AddTagContextModal type="project" />}
      </Box>
    );
  };

  const { unmount, lastFrame } = render(
    <TestWrapper
      todoValue={{ todos }}
      navValue={{
        useSelectedTodos: () => [t1, t2],
      }}
    >
      <TestComponent />
    </TestWrapper>,
  );

  await waitFor(() => {
    const frame = lastFrame() || "";
    assertMatch(frame, /Modify Projects/);
    assertMatch(frame, /New:/);
    // +work is in both t1 and t2 (all)
    assertMatch(frame, /\[x\].*work/);
    // +personal is in t2 but not t1 (some)
    assertMatch(frame, /\[\?\].*personal/);
  });

  unmount();
});

Deno.test("AddTagContextModal: should toggle existing project", async () => {
  const t1 = new Todo("Todo 1 +work");
  const t2 = new Todo("Todo 2 +work");
  const todos = new Todos(t1, t2);
  let updatedTodos: Todo[] = [];
  let transformFn: ((t: Todo) => Todo) | undefined;

  let focusedTag: string | undefined;

  const TestComponent = () => {
    const { openModal, activeModal } = useModal();
    useEffect(() => {
      openModal("add-project");
    }, [openModal]);

    return (
      <Box flexDirection="column" height={20} width={80}>
        {activeModal === "add-project" && <AddTagContextModal type="project" />}
        <FocusObserver onFocused={(tag) => focusedTag = tag} />
      </Box>
    );
  };

  const { unmount, stdin, lastFrame } = render(
    <TestWrapper
      todoValue={{
        todos,
        updateTodos: (t, fn) => {
          updatedTodos = t;
          transformFn = fn;
        },
      }}
      navValue={{
        useSelectedTodos: () => [t1, t2],
      }}
    >
      <TestComponent />
    </TestWrapper>,
  );

  // Wait for title and focus
  await waitFor(() => {
    assertMatch(lastFrame() || "", /Modify Projects/);
    assertEquals(focusedTag, "add-project-modal");
  });

  // Navigate to 'work' (Custom is 0, 'work' is 1)
  stdin.write("\u001B[B"); // Down arrow

  // Wait for selection to move
  await waitFor(() => {
    assertMatch(lastFrame() || "", /\u00BB.*work/);
  });

  // Toggle 'work'
  stdin.write(" ");

  await waitFor(() => {
    const frame = lastFrame() || "";
    assertMatch(frame, /\[ \].*work/);
  });

  // Press Enter to apply
  stdin.write("\r");

  await waitFor(() => {
    assertEquals(updatedTodos.length, 2);
    if (transformFn) {
      const result = transformFn(t1);
      assertEquals(result.projects.has("work"), false);
    }
  });

  unmount();
});

Deno.test("AddTagContextModal: should add custom project", async () => {
  const t1 = new Todo("Todo 1");
  const todos = new Todos(t1);
  let updatedTodos: Todo[] = [];
  let transformFn: ((t: Todo) => Todo) | undefined;

  let focusedTag: string | undefined;

  const TestComponent = () => {
    const { openModal, activeModal } = useModal();
    useEffect(() => {
      openModal("add-project");
    }, [openModal]);

    return (
      <Box flexDirection="column" height={20} width={80}>
        {activeModal === "add-project" && <AddTagContextModal type="project" />}
        <FocusObserver onFocused={(tag) => focusedTag = tag} />
      </Box>
    );
  };

  const { unmount, stdin, lastFrame } = render(
    <TestWrapper
      todoValue={{
        todos,
        updateTodos: (t, fn) => {
          updatedTodos = t;
          transformFn = fn;
        },
      }}
      navValue={{
        useSelectedTodos: () => [t1],
      }}
    >
      <TestComponent />
    </TestWrapper>,
  );

  await waitFor(() => {
    assertMatch(lastFrame() || "", /New:/);
    assertEquals(focusedTag, "add-project-modal");
  });

  // Type custom project name
  for (const char of "newproj") {
    stdin.write(char);
  }

  await waitFor(() => {
    assertMatch(lastFrame() || "", /newproj/);
  });

  // Press Enter to apply
  stdin.write("\r");

  await waitFor(() => {
    assertEquals(updatedTodos.length, 1);
    if (transformFn) {
      const result = transformFn(t1);
      assertEquals(result.projects.has("newproj"), true);
    }
  });

  unmount();
});

Deno.test("AddTagContextModal: should cycle through 3 states for 'some' state", async () => {
  const t1 = new Todo("Todo 1 +work");
  const t2 = new Todo("Todo 2");
  const todos = new Todos(t1, t2);

  let focusedTag: string | undefined;

  const TestComponent = () => {
    const { openModal, activeModal } = useModal();
    useEffect(() => {
      openModal("add-project");
    }, [openModal]);

    return (
      <Box flexDirection="column" height={20} width={80}>
        {activeModal === "add-project" && <AddTagContextModal type="project" />}
        <FocusObserver onFocused={(tag) => focusedTag = tag} />
      </Box>
    );
  };

  const { unmount, stdin, lastFrame } = render(
    <TestWrapper
      todoValue={{ todos }}
      navValue={{
        useSelectedTodos: () => [t1, t2],
      }}
    >
      <TestComponent />
    </TestWrapper>,
  );

  await waitFor(() => {
    assertMatch(lastFrame() || "", /\[\?\].*work/);
    assertEquals(focusedTag, "add-project-modal");
  });

  // Navigate to 'work' (Custom is 0, 'work' is 1)
  stdin.write("\u001B[B"); // Down arrow

  // Wait for selection to move
  await waitFor(() => {
    assertMatch(lastFrame() || "", /\u00BB.*work/);
  });

  // Toggle 1: some (?) -> all (x)
  stdin.write(" ");
  await waitFor(() => {
    assertMatch(lastFrame() || "", /\[x\].*work/);
  });

  // Toggle 2: all (x) -> none ( )
  stdin.write(" ");
  await waitFor(() => {
    assertMatch(lastFrame() || "", /\[ \].*work/);
  });

  // Toggle 3: none ( ) -> some (?)
  stdin.write(" ");
  await waitFor(() => {
    assertMatch(lastFrame() || "", /\[\?\].*work/);
  });

  unmount();
});

Deno.test("AddTagContextModal: mouse click should toggle existing project", async () => {
  const t1 = new Todo("Todo 1 +work");
  const t2 = new Todo("Todo 2 +work");
  const todos = new Todos(t1, t2);

  const TestComponent = () => {
    const { openModal, activeModal } = useModal();
    useEffect(() => {
      openModal("add-project");
    }, [openModal]);

    return (
      <Box flexDirection="column" height={20} width={80}>
        {activeModal === "add-project" && <AddTagContextModal type="project" />}
      </Box>
    );
  };

  const { unmount, lastFrame, stdin } = render(
    <TestWrapper
      todoValue={{ todos }}
      navValue={{ useSelectedTodos: () => [t1, t2] }}
    >
      <TestComponent />
    </TestWrapper>,
  );

  await waitFor(() => assertMatch(lastFrame() || "", /\[x\].*work/));

  // rows=20, columns=80, width=40, bodyRows=3 => first tag row is y=12, x in [21..60]
  stdin.write("\x1b[<0;40;12M");
  await waitFor(() => assertMatch(lastFrame() || "", /\[ \].*work/));

  unmount();
});
