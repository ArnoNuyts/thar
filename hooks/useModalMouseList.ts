import { useWindowSize } from "ink";
import { getModalBodyRowFromEvent } from "../utils/modal-mouse.ts";
import { getTerminalSize } from "../utils/terminal-size.ts";
import { useMouseInput } from "./useMouseInput.ts";

interface UseModalMouseListOptions {
  isActive: boolean;
  bodyRows: number;
  modalWidth?: number | string;
  terminalSize?: { rows?: number; columns?: number };
  onRowClick: (row: number) => void | Promise<void>;
  /** Optional hover highlight; click behavior is unchanged when omitted. */
  onRowHover?: (row: number) => void;
}

export const useModalMouseList = (options: UseModalMouseListOptions) => {
  const windowSize = useWindowSize();

  useMouseInput((event) => {
    if (!options.isActive) return;
    if (!event.leftClick && !event.move) return;
    const terminalSize = getTerminalSize(windowSize, options.terminalSize);

    const row = getModalBodyRowFromEvent(event, terminalSize, {
      modalWidth: options.modalWidth ?? "50%",
      bodyRows: options.bodyRows,
    });
    if (row === undefined) return;

    if (event.leftClick) {
      options.onRowClick(row);
    } else {
      options.onRowHover?.(row);
    }
  }, { isActive: options.isActive });
};
