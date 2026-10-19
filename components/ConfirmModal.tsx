import { Box, Text, useWindowSize } from "ink";
import { useMemo, useState } from "react";
import { useModal } from "../contexts/modal-context.tsx";
import { useFocusedInput } from "../hooks/useFocusedInput.ts";
import { useMouseInput } from "../hooks/useMouseInput.ts";
import {
  getModalBodyCellFromClick,
  resolveModalWidth,
} from "../utils/modal-mouse.ts";
import {
  countWrappedLines,
  getHoveredButtonIndex,
} from "../utils/modal-layout.ts";
import { getTerminalSize } from "../utils/terminal-size.ts";
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
  const windowSize = useWindowSize();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [layoutSize, setLayoutSize] = useState<
    { rows?: number; columns?: number }
  >({});

  const handleCancel = () => {
    onCancel?.();
    closeModal();
  };

  const handleConfirm = () => {
    onConfirm();
    closeModal();
  };

  const terminalSize = getTerminalSize(windowSize, layoutSize);

  const messageLineCount = useMemo(() => {
    const columns = terminalSize.columns;
    const modalWidth = resolveModalWidth(columns, "50%");
    // Modal body has a single left border plus horizontal padding on both sides.
    const contentWidth = Math.max(1, modalWidth - 3);
    return countWrappedLines(message, contentWidth);
  }, [message, terminalSize.columns]);

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
    const currentTerminalSize = getTerminalSize(windowSize, layoutSize);

    if (event.move) {
      const hovered = getHoveredButtonIndex(event.x, event.y, {
        rows: currentTerminalSize.rows,
        columns: currentTerminalSize.columns,
        modalWidth: resolveModalWidth(currentTerminalSize.columns, "50%"),
        bodyRows,
        buttonRowIndex,
        labels: ["Confirm", "Cancel"],
      });
      setHoveredIndex(hovered);
      return;
    }

    const bodyCell = getModalBodyCellFromClick(event, currentTerminalSize, {
      modalWidth: "50%",
      bodyRows,
    });
    if (!bodyCell) {
      if (event.move) setHoveredIndex(null);
      return;
    }

    const hoveredByColumn =
      bodyCell.column < Math.floor(bodyCell.modalWidth / 2) ? 0 : 1;

    if (bodyCell.row !== buttonRowIndex) {
      return;
    }

    const clickedIndex = hoveredByColumn;
    if (event.leftClick) {
      setHoveredIndex(clickedIndex);
      setSelectedIndex(clickedIndex);
      if (clickedIndex === 0) {
        handleConfirm();
        return;
      }
      handleCancel();
    }
  }, { isActive: isFocused });

  return (
    <Modal
      title={title}
      onLayoutSizeChange={setLayoutSize}
    >
      <Box flexDirection="column">
        <Text>{message}</Text>
        <Box marginTop={1}>
          <Button.Group
            isFocused={isFocused}
            selectedIndex={selectedIndex}
            onSelectedIndexChange={setSelectedIndex}
            hoveredIndex={hoveredIndex}
            equalWidth
          >
            <Button label="Confirm" onPress={handleConfirm} />
            <Button label="Cancel" onPress={handleCancel} />
          </Button.Group>
        </Box>
      </Box>
    </Modal>
  );
};
