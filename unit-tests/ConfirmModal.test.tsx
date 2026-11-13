import { expect, test } from "vitest";
import { render } from "ink-testing-library";

import { useEffect } from "react";
import { Box } from "ink";

import { ConfirmModal } from "../components/ConfirmModal.tsx";
import { useModal } from "../contexts/modal-context.tsx";
import { waitFor } from "./test-utils.ts";
import { FocusObserver, TestWrapper } from "./test-components.tsx";

test("ConfirmModal: should render and set focus", async () => {
  let focusedTag: string | undefined;
  let confirmed = false;

  const TestComponent = () => {
    const { openConfirmModal, activeModal, modalData } = useModal();
    useEffect(() => {
      openConfirmModal({
        title: "Test Title",
        message: "Test Message",
        onConfirm: () => {
          confirmed = true;
        },
      });
    }, [openConfirmModal]);

    return (
      <Box flexDirection="column" height={10}>
        {activeModal === "confirm-modal" && modalData && (
          <ConfirmModal
            title={modalData.title}
            message={modalData.message}
            onConfirm={modalData.onConfirm}
          />
        )}
        <FocusObserver onFocused={(tag) => (focusedTag = tag)} />
      </Box>
    );
  };

  const { unmount, lastFrame, stdin } = render(
    <TestWrapper>
      <TestComponent />
    </TestWrapper>,
  );

  await waitFor(() => {
    expect(lastFrame() || "").toMatch(/Test Title/);
    expect(lastFrame() || "").toMatch(/Test Message/);
    expect(focusedTag).toEqual("confirm-modal");
  });

  stdin.write("\r"); // Confirm

  await waitFor(() => expect(confirmed).toEqual(true));

  unmount();
});

test("ConfirmModal: Tab then Enter should cancel", async () => {
  let cancelled = false;

  const TestComponent = () => {
    const { openConfirmModal, activeModal, modalData } = useModal();
    useEffect(() => {
      openConfirmModal({
        title: "Tab Cancel",
        message: "Use tab to cancel",
        onConfirm: () => {},
        onCancel: () => {
          cancelled = true;
        },
      });
    }, [openConfirmModal]);

    return (
      <Box flexDirection="column" height={12} width={80}>
        {activeModal === "confirm-modal" && modalData && (
          <ConfirmModal
            title={modalData.title}
            message={modalData.message}
            onConfirm={modalData.onConfirm}
            onCancel={modalData.onCancel}
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

  await waitFor(() => expect(lastFrame() || "").toMatch(/Tab Cancel/));

  stdin.write("\t");
  stdin.write("\r");

  await waitFor(() => expect(cancelled).toEqual(true));
  unmount();
});

test("ConfirmModal: Space should activate selected button", async () => {
  let confirmed = false;

  const TestComponent = () => {
    const { openConfirmModal, activeModal, modalData } = useModal();
    useEffect(() => {
      openConfirmModal({
        title: "Mouse Confirm",
        message: "Click to confirm",
        onConfirm: () => {
          confirmed = true;
        },
      });
    }, [openConfirmModal]);

    return (
      <Box flexDirection="column" height={10} width={80}>
        {activeModal === "confirm-modal" && modalData && (
          <ConfirmModal
            title={modalData.title}
            message={modalData.message}
            onConfirm={modalData.onConfirm}
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

  await waitFor(() => expect(lastFrame() || "").toMatch(/Mouse Confirm/));

  stdin.write(" ");
  await waitFor(() => expect(confirmed).toEqual(true));

  unmount();
});

test("ConfirmModal: mouse click left half should confirm", async () => {
  let confirmed = false;

  const TestComponent = () => {
    const { openConfirmModal, activeModal, modalData } = useModal();
    useEffect(() => {
      openConfirmModal({
        title: "Mouse Cancel",
        message: "Click cancel",
        onConfirm: () => {
          confirmed = true;
        },
      });
    }, [openConfirmModal]);

    return (
      <Box flexDirection="column" height={25} width={101}>
        {activeModal === "confirm-modal" && modalData && (
          <ConfirmModal
            title={modalData.title}
            message={modalData.message}
            onConfirm={modalData.onConfirm}
            onCancel={modalData.onCancel}
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

  await waitFor(() => expect(lastFrame() || "").toMatch(/Mouse Cancel/));

  // rows=25, columns=101, width=50%, message lines=1 => button row y=15.
  // Left half of modal body activates Confirm.
  stdin.write("\x1b[<0;40;15M");

  await waitFor(() => expect(confirmed).toEqual(true));
  unmount();
});

test("ConfirmModal: mouse click right half should cancel", async () => {
  let cancelled = false;

  const TestComponent = () => {
    const { openConfirmModal, activeModal, modalData } = useModal();
    useEffect(() => {
      openConfirmModal({
        title: "Mouse Confirm",
        message: "Click confirm",
        onConfirm: () => {},
        onCancel: () => {
          cancelled = true;
        },
      });
    }, [openConfirmModal]);

    return (
      <Box flexDirection="column" height={25} width={101}>
        {activeModal === "confirm-modal" && modalData && (
          <ConfirmModal
            title={modalData.title}
            message={modalData.message}
            onConfirm={modalData.onConfirm}
            onCancel={modalData.onCancel}
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

  await waitFor(() => expect(lastFrame() || "").toMatch(/Mouse Confirm/));

  // rows=25, columns=101, width=50%, message lines=1 => button row y=15.
  // Right half of modal body activates Cancel.
  stdin.write("\x1b[<0;60;15M");

  await waitFor(() => expect(cancelled).toEqual(true));
  unmount();
});
