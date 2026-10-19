import { assertEquals, assertMatch } from "@std/assert";
import { render } from "ink-testing-library";
import { Box } from "ink";
import { modalRegistry } from "../components/modal-registry.tsx";
import { TestWrapper } from "./test-components.tsx";
import { waitFor } from "./test-utils.ts";

const EXPECTED_GENERIC_MODAL_IDS = [
  "create-todo",
  "edit-todo",
  "todo-menu",
  "set-due-date",
  "set-threshold-date",
  "set-recurrence",
  "set-priority",
  "add-project",
  "add-context",
] as const;

Deno.test("modal-registry: keys exactly match the non-confirm modal ids", () => {
  assertEquals(
    Object.keys(modalRegistry).sort(),
    [...EXPECTED_GENERIC_MODAL_IDS].sort(),
  );
});

Deno.test("modal-registry: every entry maps to a component", () => {
  for (const id of EXPECTED_GENERIC_MODAL_IDS) {
    assertEquals(
      typeof modalRegistry[id],
      "function",
      `${id} should map to a component`,
    );
  }
});

Deno.test("modal-registry: confirm-modal is not in the generic registry", () => {
  assertEquals("confirm-modal" in modalRegistry, false);
});

Deno.test("modal-registry: a simple entry renders from the registry", async () => {
  const SetPriorityModal = modalRegistry["set-priority"];
  const { lastFrame, unmount } = render(
    <TestWrapper>
      <Box flexDirection="column" height={20}>
        <SetPriorityModal />
      </Box>
    </TestWrapper>,
  );

  await waitFor(() => {
    assertMatch(lastFrame() || "", /Set Priority/);
  });

  unmount();
});
