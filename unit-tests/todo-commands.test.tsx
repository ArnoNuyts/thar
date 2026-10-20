import { expect, test } from "vitest";

import { render } from "ink-testing-library";

import { useTodoCommands } from "../hooks/useTodoCommands.ts";
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
