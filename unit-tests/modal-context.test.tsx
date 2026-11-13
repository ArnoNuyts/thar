import { expect, test } from "vitest";
import { render } from "ink-testing-library";
import { useEffect } from "react";
import { Text } from "ink";

import { ModalProvider, useModal } from "../contexts/modal-context.tsx";
import { waitFor } from "./test-utils.ts";

type ModalApi = ReturnType<typeof useModal>;

test("ModalProvider - keeps confirm data and generic modal state in sync", async () => {
  let api: ModalApi | undefined;

  const Probe = () => {
    const value = useModal();
    useEffect(() => {
      api = value;
    });
    return (
      <Text>
        {`${value.activeModal ?? "none"}|${value.modalData?.title ?? "none"}`}
      </Text>
    );
  };

  const { lastFrame, unmount } = render(
    <ModalProvider>
      <Probe />
    </ModalProvider>,
  );

  await waitFor(() => expect(lastFrame() || "").toContain("none|none"));
  if (!api) throw new Error("Modal context was not captured");

  api.openConfirmModal({
    title: "Confirm",
    message: "Message",
    onConfirm: () => {},
  });
  await waitFor(() =>
    expect(lastFrame() || "").toContain("confirm-modal|Confirm"),
  );

  api.openModal("edit-todo");
  await waitFor(() => expect(lastFrame() || "").toContain("edit-todo|none"));

  api.openConfirmModal({
    title: "Again",
    message: "Message",
    onConfirm: () => {},
  });
  await waitFor(() =>
    expect(lastFrame() || "").toContain("confirm-modal|Again"),
  );

  api.closeModal();
  await waitFor(() => expect(lastFrame() || "").toContain("none|none"));

  unmount();
});
