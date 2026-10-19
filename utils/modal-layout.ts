import {
  MODAL_BOTTOM_CHROME_ROWS,
  MODAL_TOP_CHROME_ROWS,
} from "./modal-mouse.ts";

export interface HoverHitOptions {
  rows: number;
  columns: number;
  modalWidth: number;
  bodyRows: number;
  buttonRowIndex: number;
  labels: [string, string];
}

export const getHoveredButtonIndex = (
  x: number | undefined,
  y: number | undefined,
  opts: HoverHitOptions,
): number | null => {
  if (x === undefined || y === undefined) return null;

  const modalHeight = MODAL_TOP_CHROME_ROWS + opts.bodyRows +
    MODAL_BOTTOM_CHROME_ROWS;
  const modalLeft = Math.floor((opts.columns - opts.modalWidth) / 2) + 1;
  const modalTop = Math.ceil((opts.rows - modalHeight) / 2) + 1;
  const buttonY = modalTop + MODAL_TOP_CHROME_ROWS + opts.buttonRowIndex;
  if (y !== buttonY) return null;

  const leftHalfWidth = Math.floor(opts.modalWidth / 2);
  const rightHalfWidth = opts.modalWidth - leftHalfWidth;
  const leftLabel = `« ${opts.labels[0]} »`;
  const rightLabel = `« ${opts.labels[1]} »`;
  const leftWidth = Array.from(leftLabel).length;
  const rightWidth = Array.from(rightLabel).length;

  const leftStart = modalLeft + Math.floor((leftHalfWidth - leftWidth) / 2);
  const leftEnd = leftStart + leftWidth - 1;
  if (x >= leftStart && x <= leftEnd) return 0;

  const rightHalfLeft = modalLeft + leftHalfWidth;
  const rightStart = rightHalfLeft +
    Math.floor((rightHalfWidth - rightWidth) / 2);
  const rightEnd = rightStart + rightWidth - 1;
  if (x >= rightStart && x <= rightEnd) return 1;

  return null;
};

export const countWrappedLines = (text: string, width: number): number => {
  if (width <= 0) return 1;
  if (text.length === 0) return 1;

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
