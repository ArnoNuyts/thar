import { expect, test } from "vitest";

import { render } from "ink-testing-library";
import { Box } from "ink";
import { modalRegistry } from "../components/modal-registry.tsx";
import { TestWrapper } from "./test-components.tsx";
import { waitFor } from "./test-utils.ts";

const EXPECTED_GENERIC_MODAL_IDS = [
  "create-todo",
  "edit-todo",
  "todo-menu",
  "multi-select-menu",
  "set-due-date",
  "set-threshold-date",
  "set-recurrence",
  "set-priority",
  "add-project",
  "add-context",
  "update-modal",
] as const;

test("modal-registry: keys exactly match the non-confirm modal ids", () => {
  expect(Object.keys(modalRegistry).sort()).toEqual(
    [...EXPECTED_GENERIC_MODAL_IDS].sort(),
  );
});

test("modal-registry: every entry maps to a component", () => {
  for (const id of EXPECTED_GENERIC_MODAL_IDS) {
    expect(typeof modalRegistry[id], `${id} should map to a component`).toEqual(
      "function",
    );
  }
});

test("modal-registry: confirm-modal is not in the generic registry", () => {
  expect("confirm-modal" in modalRegistry).toEqual(false);
});

test("modal-registry: a simple entry renders from the registry", async () => {
  const SetPriorityModal = modalRegistry["set-priority"];
  const { lastFrame, unmount } = render(
    <TestWrapper>
      <Box flexDirection="column" height={20}>
        <SetPriorityModal />
      </Box>
    </TestWrapper>,
  );

  await waitFor(() => {
    expect(lastFrame() || "").toMatch(/Set Priority/);
  });

  unmount();
});
