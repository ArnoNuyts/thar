import { useStdout } from "ink";
import { getModalBodyRowFromClick } from "../utils/modal-mouse.ts";
import { useMouseInput } from "./useMouseInput.ts";

interface UseModalMouseListOptions {
  isActive: boolean;
  bodyRows: number;
  modalWidth?: number | string;
  onRowClick: (row: number) => void | Promise<void>;
}

export const useModalMouseList = (options: UseModalMouseListOptions) => {
  const { stdout } = useStdout();

  useMouseInput((event) => {
    if (!options.isActive) return;

    const row = getModalBodyRowFromClick(event, stdout, {
      modalWidth: options.modalWidth ?? "50%",
      bodyRows: options.bodyRows,
    });
    if (row === undefined) return;

    options.onRowClick(row);
  }, { isActive: options.isActive });
};
