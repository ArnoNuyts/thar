import { Box, Text } from "ink";
import { useModal } from "../contexts/modal-context.tsx";
import { useFocusedInput } from "../hooks/useFocusedInput.ts";
import { useModalMouseList } from "../hooks/useModalMouseList.ts";
import { COLORS } from "../theme/colors.ts";
import { Modal } from "./Modal.tsx";

export interface ConfirmModalProps {
  title: string;
  message: string;
  onConfirm: () => void;
  onCancel?: () => void;
}

export const ConfirmModal = (
  { title, message, onConfirm, onCancel }: ConfirmModalProps,
) => {
  const { closeModal } = useModal();

  const { isFocused } = useFocusedInput(
    (_input, key) => {
      if (key.escape) {
        if (onCancel) onCancel();
        closeModal();
        return;
      }

      if (key.return) {
        onConfirm();
        closeModal();
        return;
      }
    },
    { autoFocus: true, tag: "confirm-modal" },
  );

  useModalMouseList({
    isActive: isFocused,
    modalWidth: "50%",
    bodyRows: 4,
    onRowClick: () => {
      onConfirm();
      closeModal();
    },
  });

  return (
    <Modal isFocused={isFocused} title={title}>
      <Box flexDirection="column" padding={1}>
        <Text>{message}</Text>
        <Box marginTop={1}>
          <Text color={COLORS.muted}>Enter to continue, Esc to cancel</Text>
        </Box>
      </Box>
    </Modal>
  );
};
