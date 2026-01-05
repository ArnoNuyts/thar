import { render } from "ink-testing-library";
import { assertEquals } from "@std/assert";
import { useEffect } from "react";
import { Box } from "ink";

import { ConfirmModal } from "../components/ConfirmModal.tsx";
import { ModalProvider, useModal } from "../contexts/modal-context.tsx";
import { FocusProvider, useFocusManager } from "../contexts/focus-context.tsx";
import { waitFor } from "./test-utils.ts";

const FocusObserver = ({ onFocused }: { onFocused: () => void }) => {
  const { activeId } = useFocusManager();
  useEffect(() => {
    let timeoutId: number | undefined;
    if (activeId) {
      timeoutId = setTimeout(onFocused, 150);
    }
    return () => {
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [activeId, onFocused]);
  return null;
};

const TestWrapper = ({ children }: { children: React.ReactNode }) => {
  return (
    <FocusProvider>
      <ModalProvider>
        {children}
      </ModalProvider>
    </FocusProvider>
  );
};

Deno.test("ConfirmModal: should render and set focus", async () => {
  let focused = false;
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
        <FocusObserver onFocused={() => (focused = true)} />
      </Box>
    );
  };

  const { unmount, lastFrame, stdin } = render(
    <TestWrapper>
      <TestComponent />
    </TestWrapper>,
  );

  await waitFor(() => assertEquals(lastFrame()?.includes("Test Title"), true));
  await waitFor(() =>
    assertEquals(lastFrame()?.includes("Test Message"), true)
  );
  await waitFor(() => assertEquals(focused, true));

  stdin.write("\r"); // Confirm

  await waitFor(() => assertEquals(confirmed, true));

  unmount();
});
