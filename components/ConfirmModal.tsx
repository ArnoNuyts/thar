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
  const MODAL_TOP_CHROME_ROWS = 3;
  const MODAL_BOTTOM_CHROME_ROWS = 2;
  const { closeModal } = useModal();
  const { stdout } = useStdout();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

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

    if (event.move) {
      const hovered = getHoveredButtonIndex(event.x, event.y, {
        rows: stdout?.rows ?? 24,
        columns: stdout?.columns ?? 80,
        modalWidth: resolveModalWidth(stdout?.columns ?? 80, "50%"),
        bodyRows,
        buttonRowIndex,
        labels: ["Confirm", "Cancel"],
        modalTopChromeRows: MODAL_TOP_CHROME_ROWS,
        modalBottomChromeRows: MODAL_BOTTOM_CHROME_ROWS,
      });
      setHoveredIndex(hovered);
      return;
    }

    const bodyCell = getModalBodyCellFromClick(event, stdout, {
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
    <Modal isFocused={isFocused} title={title}>
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

interface HoverHitOptions {
  rows: number;
  columns: number;
  modalWidth: number;
  bodyRows: number;
  buttonRowIndex: number;
  labels: [string, string];
  modalTopChromeRows: number;
  modalBottomChromeRows: number;
}

const getHoveredButtonIndex = (
  x: number | undefined,
  y: number | undefined,
  opts: HoverHitOptions,
): number | null => {
  if (x === undefined || y === undefined) return null;

  const modalHeight = opts.modalTopChromeRows + opts.bodyRows +
    opts.modalBottomChromeRows;
  const modalLeft = Math.floor((opts.columns - opts.modalWidth) / 2) + 1;
  const modalTop = Math.ceil((opts.rows - modalHeight) / 2) + 1;
  const buttonY = modalTop + opts.modalTopChromeRows + opts.buttonRowIndex;
  if (y !== buttonY) return null;

  const leftHalfWidth = Math.floor(opts.modalWidth / 2);
  const rightHalfWidth = opts.modalWidth - leftHalfWidth;
  const confirmText = `« ${opts.labels[0]} »`;
  const cancelText = `« ${opts.labels[1]} »`;
  const confirmWidth = Array.from(confirmText).length;
  const cancelWidth = Array.from(cancelText).length;

  const confirmStart = modalLeft +
    Math.floor((leftHalfWidth - confirmWidth) / 2);
  const confirmEnd = confirmStart + confirmWidth - 1;
  if (x >= confirmStart && x <= confirmEnd) return 0;

  const cancelHalfLeft = modalLeft + leftHalfWidth;
  const cancelStart = cancelHalfLeft +
    Math.floor((rightHalfWidth - cancelWidth) / 2);
  const cancelEnd = cancelStart + cancelWidth - 1;
  if (x >= cancelStart && x <= cancelEnd) return 1;

  return null;
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
