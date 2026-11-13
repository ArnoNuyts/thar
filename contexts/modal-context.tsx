import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

/**
 * Modal ids that render without extra data. This is an explicit union rather
 * than `Exclude<ModalId, "confirm-modal">`, so adding a data-carrying modal
 * forces a new opener instead of silently accepting `openModal(id)`.
 */
export type GenericModalId =
  | "create-todo"
  | "edit-todo"
  | "todo-menu"
  | "multi-select-menu"
  | "set-due-date"
  | "set-threshold-date"
  | "set-recurrence"
  | "set-priority"
  | "add-project"
  | "add-context"
  | "update-modal";

/** `confirm-modal` renders from `ConfirmModalData` via `openConfirmModal`. */
export type ModalId = GenericModalId | "confirm-modal";

export interface ConfirmModalData {
  title: string;
  message: string;
  onConfirm: () => void;
  onCancel?: () => void;
}

interface ModalContextType {
  activeModal: ModalId | null;
  modalData: ConfirmModalData | null;
  openModal: (id: GenericModalId) => void;
  openConfirmModal: (data: ConfirmModalData) => void;
  closeModal: () => void;
}

const ModalContext = createContext<ModalContextType | null>(null);

export const ModalProvider = ({ children }: { children?: ReactNode }) => {
  const [activeModal, setActiveModal] = useState<ModalId | null>(null);
  const [modalData, setModalData] = useState<ConfirmModalData | null>(null);

  const openModal = useCallback((id: GenericModalId) => {
    setActiveModal(id);
    setModalData(null);
  }, []);

  const openConfirmModal = useCallback((data: ConfirmModalData) => {
    setActiveModal("confirm-modal");
    setModalData(data);
  }, []);

  const closeModal = useCallback(() => {
    setActiveModal(null);
    setModalData(null);
  }, []);

  const value = useMemo(
    () => ({ activeModal, modalData, openModal, openConfirmModal, closeModal }),
    [activeModal, modalData, openModal, openConfirmModal, closeModal],
  );

  return (
    <ModalContext.Provider value={value}>{children}</ModalContext.Provider>
  );
};

export const useModal = () => {
  const context = useContext(ModalContext);
  if (!context) {
    throw new Error("useModal must be used within ModalProvider");
  }
  return context;
};
