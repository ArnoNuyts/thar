import { expect, test } from "vitest";

import { useEffect } from "react";
import { render } from "ink-testing-library";

import { useTodoCommands } from "../hooks/useTodoCommands.ts";
import { useToaster } from "../contexts/toaster-context.tsx";
import { MAX_PASTE_TODOS } from "../logic/limits.ts";
import { Runtime } from "../utils/runtime.ts";
import { waitFor } from "./test-utils.ts";
import { TestWrapper } from "./test-components.tsx";

type Commands = ReturnType<typeof useTodoCommands>;

test("useTodoCommands: archiveCompleted waits for the write to finish", async () => {
  let commands: Commands | undefined;
  let started = false;
  let finished = false;
  let finishWrite: () => void = () => {};

  const write = new Promise<void>((resolve) => {
    finishWrite = () => {
      finished = true;
      resolve();
    };
  });

  const Harness = () => {
    commands = useTodoCommands();
    return null;
  };

  const { unmount } = render(
    <TestWrapper
      todoValue={{
        archiveCompletedTodos: () => {
          started = true;
          return write;
        },
      }}
    >
      <Harness />
    </TestWrapper>,
  );

  await waitFor(() => expect(commands !== undefined).toEqual(true));

  let settled = false;
  const archive = commands!.archiveCompleted();
  archive.then(() => (settled = true));

  await waitFor(() => expect(started).toEqual(true));
  await Promise.resolve();

  expect(finished).toEqual(false);
  expect(settled).toEqual(false);

  finishWrite();
  await archive;

  expect(finished).toEqual(true);
  expect(settled).toEqual(true);

  unmount();
});

test("useTodoCommands: paste over the cap is rejected by the batch validator", async () => {
  const originalCommand = Runtime.Command;
  let commands: Commands | undefined;
  let addTodosCalls = 0;
  let toast: string | undefined;

  try {
    (Runtime as any).Command = class {
      command: string;
      constructor(command: string) {
        this.command = command;
      }
      output() {
        const lines = Array.from(
          { length: MAX_PASTE_TODOS + 1 },
          (_, index) => `Todo ${index}`,
        ).join("\n");
        return Promise.resolve({
          stdout: new TextEncoder().encode(lines),
          stderr: new Uint8Array(),
          success: true,
          code: 0,
        });
      }
    };

    const Harness = () => {
      commands = useTodoCommands();
      const { toasterMessage } = useToaster();
      useEffect(() => {
        toast = toasterMessage;
      }, [toasterMessage]);
      return null;
    };

    const { unmount } = render(
      <TestWrapper
        todoValue={{
          addTodos: () => {
            addTodosCalls++;
            return [];
          },
        }}
      >
        <Harness />
      </TestWrapper>,
    );

    await waitFor(() => expect(commands !== undefined).toEqual(true));
    await commands!.pasteTodos();

    await waitFor(() => {
      expect(toast || "").toMatch(/limit is 100/i);
    });
    expect(addTodosCalls).toEqual(0);

    unmount();
  } finally {
    (Runtime as any).Command = originalCommand;
  }
});
