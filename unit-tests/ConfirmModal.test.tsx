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

Deno.test("ConfirmModal: Tab then Enter should cancel", async () => {
  let cancelled = false;

  const TestComponent = () => {
    const { openModal, activeModal, modalData } = useModal();
    useEffect(() => {
      openModal("confirm-modal", {
        title: "Tab Cancel",
        message: "Use tab to cancel",
        onConfirm: () => {},
        onCancel: () => {
          cancelled = true;
        },
      });
    }, [openModal]);

    return (
      <Box flexDirection="column" height={12} width={80}>
        {activeModal === "confirm-modal" && (
          <ConfirmModal
            title={(modalData as { title: string }).title}
            message={(modalData as { message: string }).message}
            onConfirm={(modalData as { onConfirm: () => void }).onConfirm}
            onCancel={(modalData as { onCancel: () => void }).onCancel}
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

  await waitFor(() => assertMatch(lastFrame() || "", /Tab Cancel/));

  stdin.write("\t");
  stdin.write("\r");

  await waitFor(() => assertEquals(cancelled, true));
  unmount();
});

Deno.test("ConfirmModal: Space should activate selected button", async () => {
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

  stdin.write(" ");
  await waitFor(() => assertEquals(confirmed, true));

  unmount();
});

Deno.test("ConfirmModal: mouse click left half should confirm", async () => {
  let confirmed = false;

  const TestComponent = () => {
    const { openModal, activeModal, modalData } = useModal();
    useEffect(() => {
      openModal("confirm-modal", {
        title: "Mouse Cancel",
        message: "Click cancel",
        onConfirm: () => {
          confirmed = true;
        },
      });
    }, [openModal]);

    return (
      <Box flexDirection="column" height={25} width={101}>
        {activeModal === "confirm-modal" && (
          <ConfirmModal
            title={(modalData as { title: string }).title}
            message={(modalData as { message: string }).message}
            onConfirm={(modalData as { onConfirm: () => void }).onConfirm}
            onCancel={(modalData as { onCancel: () => void }).onCancel}
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

  await waitFor(() => assertMatch(lastFrame() || "", /Mouse Cancel/));

  // rows=25, columns=101, width=50%, message lines=1 => button row y=15.
  // Left half of modal body activates Confirm.
  stdin.write("\x1b[<0;40;15M");

  await waitFor(() => assertEquals(confirmed, true));
  unmount();
});

Deno.test("ConfirmModal: mouse click right half should cancel", async () => {
  let cancelled = false;

  const TestComponent = () => {
    const { openModal, activeModal, modalData } = useModal();
    useEffect(() => {
      openModal("confirm-modal", {
        title: "Mouse Confirm",
        message: "Click confirm",
        onConfirm: () => {},
        onCancel: () => {
          cancelled = true;
        },
      });
    }, [openModal]);

    return (
      <Box flexDirection="column" height={25} width={101}>
        {activeModal === "confirm-modal" && (
          <ConfirmModal
            title={(modalData as { title: string }).title}
            message={(modalData as { message: string }).message}
            onConfirm={(modalData as { onConfirm: () => void }).onConfirm}
            onCancel={(modalData as { onCancel: () => void }).onCancel}
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

  // rows=25, columns=101, width=50%, message lines=1 => button row y=15.
  // Right half of modal body activates Cancel.
  stdin.write("\x1b[<0;60;15M");

  await waitFor(() => assertEquals(cancelled, true));
  unmount();
});
