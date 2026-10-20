import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { Todo } from "../logic/todo.ts";

export type ModalId =
  | "create-todo"
  | "edit-todo"
  | "todo-menu"
  | "multi-select-menu"
  | "set-due-date"
  | "set-threshold-date"
  | "set-recurrence"
  | "set-priority"
  | "confirm-modal"
  | "add-project"
  | "add-context";

export interface ConfirmModalData {
  title: string;
  message: string;
  onConfirm: () => void;
  onCancel?: () => void;
}

export function isConfirmModalData(
  data: ModalData | null,
): data is ConfirmModalData {
  return (
    data !== null &&
    typeof data === "object" &&
    "title" in data &&
    "message" in data &&
    "onConfirm" in data
  );
}

export type ModalData = Todo | ConfirmModalData;

interface ModalContextType {
  activeModal: ModalId | null;
  modalData: ModalData | null;
  openModal: (id: ModalId, data?: ModalData) => void;
  closeModal: () => void;
}

const ModalContext = createContext<ModalContextType | null>(null);

export const ModalProvider = ({ children }: { children?: ReactNode }) => {
  const [activeModal, setActiveModal] = useState<ModalId | null>(null);
  const [modalData, setModalData] = useState<ModalData | null>(null);

  const openModal = useCallback((id: ModalId, data?: ModalData) => {
    setActiveModal(id);
    setModalData(data || null);
  }, []);

  const closeModal = useCallback(() => {
    setActiveModal(null);
    setModalData(null);
  }, []);

  const value = useMemo(
    () => ({ activeModal, modalData, openModal, closeModal }),
    [activeModal, modalData, openModal, closeModal],
  );

  return (
    <ModalContext.Provider value={value}>
      {children}
    </ModalContext.Provider>
  );
};

export const useModal = () => {
  const context = useContext(ModalContext);
  if (!context) {
    throw new Error("useModal must be used within ModalProvider");
  }
  return context;
};
