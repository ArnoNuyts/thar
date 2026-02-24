import { render } from "ink-testing-library";
import { assertEquals, assertMatch } from "@std/assert";
import { useEffect } from "react";
import { Box } from "ink";

import { ConfirmModal } from "../components/ConfirmModal.tsx";
import { useModal } from "../contexts/modal-context.tsx";
import { waitFor } from "./test-utils.ts";
import { FocusObserver, TestWrapper } from "./test-components.tsx";

Deno.test("ConfirmModal: should render and set focus", async () => {
  let focusedTag: string | undefined;
  let confirmed = false;

  const TestComponent = () => {
    const { openModal, activeModal, modalData } = useModal();
    useEffect(() => {
      openModal("confirm-modal", {
        title: "Test Title",
        message: "Test Message",
        onConfirm: () => {
          confirmed = true;
        },
      });
    }, [openModal]);

    return (
      <Box flexDirection="column" height={10}>
        {activeModal === "confirm-modal" && (
          <ConfirmModal
            title={(modalData as { title: string }).title}
            message={(modalData as { message: string }).message}
            onConfirm={(modalData as { onConfirm: () => void }).onConfirm}
          />
        )}
        <FocusObserver onFocused={(tag) => focusedTag = tag} />
      </Box>
    );
  };

  const { unmount, lastFrame, stdin } = render(
    <TestWrapper>
      <TestComponent />
    </TestWrapper>,
  );

  await waitFor(() => {
    assertMatch(lastFrame() || "", /Test Title/);
    assertMatch(lastFrame() || "", /Test Message/);
    assertEquals(focusedTag, "confirm-modal");
  });

  stdin.write("\r"); // Confirm

  await waitFor(() => assertEquals(confirmed, true));

  unmount();
});

Deno.test("ConfirmModal: mouse click should confirm", async () => {
  let confirmed = false;

  const TestComponent = () => {
    const { openModal, activeModal, modalData } = useModal();
    useEffect(() => {
      openModal("confirm-modal", {
        title: "Mouse Confirm",
        message: "Click to confirm",
        onConfirm: () => {
          confirmed = true;
        },
      });
    }, [openModal]);

    return (
      <Box flexDirection="column" height={10} width={80}>
        {activeModal === "confirm-modal" && (
          <ConfirmModal
            title={(modalData as { title: string }).title}
            message={(modalData as { message: string }).message}
            onConfirm={(modalData as { onConfirm: () => void }).onConfirm}
          />
        )}
      </Box>
    );
  };

  const { unmount, lastFrame, stdin } = render(
    <TestWrapper>
      <TestComponent />
    </TestWrapper>,
  );

  await waitFor(() => assertMatch(lastFrame() || "", /Mouse Confirm/));

  let clicked = false;
  for (let x = 1; x <= 120 && !clicked; x++) {
    for (let y = 1; y <= 40; y++) {
      stdin.write(`\x1b[<0;${x};${y}M`);
      await new Promise((resolve) => setTimeout(resolve, 4));
      if (confirmed) {
        clicked = true;
        break;
      }
    }
  }

  assertEquals(clicked, true);
  unmount();
});
