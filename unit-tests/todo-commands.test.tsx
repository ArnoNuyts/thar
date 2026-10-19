import { assertEquals } from "@std/assert";
import { render } from "ink-testing-library";

import { useTodoCommands } from "../hooks/useTodoCommands.ts";
import { waitFor } from "./test-utils.ts";
import { TestWrapper } from "./test-components.tsx";

type Commands = ReturnType<typeof useTodoCommands>;

Deno.test("useTodoCommands: archiveCompleted waits for the write to finish", async () => {
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

  await waitFor(() => assertEquals(commands !== undefined, true));

  let settled = false;
  const archive = commands!.archiveCompleted();
  archive.then(() => settled = true);

  await waitFor(() => assertEquals(started, true));
  await new Promise((resolve) => setTimeout(resolve, 10));

  assertEquals(finished, false);
  assertEquals(settled, false);

  finishWrite();
  await archive;

  assertEquals(finished, true);
  assertEquals(settled, true);

  unmount();
});
