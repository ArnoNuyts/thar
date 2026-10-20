import { MouseEvent } from "../hooks/useMouseInput.ts";
import { TerminalSize } from "./terminal-size.ts";

export const MODAL_TOP_CHROME_ROWS = 3;
export const MODAL_BOTTOM_CHROME_ROWS = 2;

export const resolveModalWidth = (
  columns: number,
  width: number | string | undefined,
): number => {
  if (typeof width === "number") {
    return Math.max(1, width);
  }
  if (typeof width === "string" && width.endsWith("%")) {
    const parsed = Number(width.slice(0, -1));
    if (Number.isFinite(parsed)) {
      return Math.max(1, Math.floor(columns * (parsed / 100)));
    }
  }
  return Math.max(1, Math.floor(columns * 0.5));
};

export interface ModalBodyCell {
  row: number;
  column: number;
  modalWidth: number;
}

export const getModalBodyCellAtPosition = (
  event: MouseEvent,
  terminal: TerminalSize,
  options: { modalWidth?: number | string; bodyRows: number },
): ModalBodyCell | undefined => {
  if (event.x === undefined || event.y === undefined) {
    return undefined;
  }

  const rows = terminal.rows;
  const columns = terminal.columns;
  if (!rows || !columns) return undefined;

  const modalWidth = resolveModalWidth(columns, options.modalWidth);
  const modalHeight = MODAL_TOP_CHROME_ROWS + options.bodyRows +
    MODAL_BOTTOM_CHROME_ROWS;
  // Ink/Yoga center alignment places the extra row above when free space is odd.
  const modalLeft = Math.floor((columns - modalWidth) / 2) + 1;
  const modalRight = modalLeft + modalWidth - 1;
  if (event.x < modalLeft || event.x > modalRight) return undefined;

  const modalTop = Math.ceil((rows - modalHeight) / 2) + 1;
  const firstBodyRow = modalTop + MODAL_TOP_CHROME_ROWS;
  const rowInBody = event.y - firstBodyRow;
  if (rowInBody < 0 || rowInBody >= options.bodyRows) return undefined;

  return {
    row: rowInBody,
    column: event.x - modalLeft,
    modalWidth,
  };
};

export const getModalBodyCellFromClick = (
  event: MouseEvent,
  terminal: TerminalSize,
  options: { modalWidth?: number | string; bodyRows: number },
): ModalBodyCell | undefined => {
  if (!event.leftClick) return undefined;
  return getModalBodyCellAtPosition(event, terminal, options);
};

export const getModalBodyRowFromEvent = (
  event: MouseEvent,
  terminal: TerminalSize,
  options: { modalWidth?: number | string; bodyRows: number },
): number | undefined => {
  return getModalBodyCellAtPosition(event, terminal, options)?.row;
};

export const getModalBodyRowFromClick = (
  event: MouseEvent,
  terminal: TerminalSize,
  options: { modalWidth?: number | string; bodyRows: number },
): number | undefined => {
  return getModalBodyCellFromClick(event, terminal, options)?.row;
};
