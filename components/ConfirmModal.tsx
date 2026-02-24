import { Box, Text, useStdout } from "ink";
import { useMemo, useState } from "react";
import { useModal } from "../contexts/modal-context.tsx";
import { useFocusedInput } from "../hooks/useFocusedInput.ts";
import { useMouseInput } from "../hooks/useMouseInput.ts";
import {
  getModalBodyCellFromClick,
  resolveModalWidth,
} from "../utils/modal-mouse.ts";
import { Modal } from "./Modal.tsx";
import { Button } from "./Button.tsx";

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
  const { stdout } = useStdout();
  const [selectedIndex, setSelectedIndex] = useState(1);

  const handleCancel = () => {
    onCancel?.();
    closeModal();
  };

  const handleConfirm = () => {
    onConfirm();
    closeModal();
  };

  const messageLineCount = useMemo(() => {
    const columns = stdout?.columns ?? 80;
    const modalWidth = resolveModalWidth(columns, "50%");
    // Modal body has a single left border plus horizontal padding on both sides.
    const contentWidth = Math.max(1, modalWidth - 3);
    return countWrappedLines(message, contentWidth);
  }, [message, stdout?.columns]);

  const buttonRowIndex = messageLineCount + 1;
  const bodyRows = messageLineCount + 2;

  const { isFocused } = useFocusedInput(
    (_input, key) => {
      if (key.escape) {
        handleCancel();
        return;
      }
    },
    { autoFocus: true, tag: "confirm-modal" },
  );

  useMouseInput((event) => {
    if (!isFocused) return;
    const bodyCell = getModalBodyCellFromClick(event, stdout, {
      modalWidth: "50%",
      bodyRows,
    });
    if (!bodyCell || bodyCell.row !== buttonRowIndex) return;

    const clickedIndex = bodyCell.column < Math.floor(bodyCell.modalWidth / 2)
      ? 0
      : 1;
    setSelectedIndex(clickedIndex);
    if (clickedIndex === 0) {
      handleCancel();
      return;
    }
    handleConfirm();
  }, { isActive: isFocused });

  return (
    <Modal isFocused={isFocused} title={title}>
      <Box flexDirection="column">
        <Text>{message}</Text>
        <Box marginTop={1}>
          <Button.Group
            isFocused={isFocused}
            selectedIndex={selectedIndex}
            onSelectedIndexChange={setSelectedIndex}
            equalWidth
          >
            <Button label="Cancel" onPress={handleCancel} />
            <Button label="Confirm" onPress={handleConfirm} />
          </Button.Group>
        </Box>
      </Box>
    </Modal>
  );
};

const countWrappedLines = (text: string, width: number): number => {
  if (width <= 0) return 1;
  const paragraphs = text.split("\n");
  let lineCount = 0;

  for (const paragraph of paragraphs) {
    if (paragraph.length === 0) {
      lineCount += 1;
      continue;
    }

    let remaining = paragraph;
    while (remaining.length > width) {
      const candidate = remaining.slice(0, width + 1);
      const breakAt = candidate.lastIndexOf(" ");
      if (breakAt > 0) {
        remaining = remaining.slice(breakAt + 1);
      } else {
        remaining = remaining.slice(width);
      }
      lineCount += 1;
    }
    lineCount += 1;
  }

  return lineCount;
};
