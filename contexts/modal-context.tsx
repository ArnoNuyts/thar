import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useState,
} from "react";

export type ModalId =
  | "create-todo"
  | "edit-todo"
  | "todo-menu"
  | "set-due-date"
  | "set-threshold-date"
  | "set-recurrence"
  | "set-priority"
  | "confirm-modal";

interface ModalContextType {
  activeModal: ModalId | null;
  // deno-lint-ignore no-explicit-any
  modalData: any | null;
  // deno-lint-ignore no-explicit-any
  openModal: (id: ModalId, data?: any) => void;
  closeModal: () => void;
}

const ModalContext = createContext<ModalContextType | null>(null);

export const ModalProvider = ({ children }: { children?: ReactNode }) => {
  const [activeModal, setActiveModal] = useState<ModalId | null>(null);
  // deno-lint-ignore no-explicit-any
  const [modalData, setModalData] = useState<any | null>(null);

  const openModal = useCallback((id: ModalId, data?: any) => {
    setActiveModal(id);
    setModalData(data || null);
  }, []);

  const closeModal = useCallback(() => {
    setActiveModal(null);
    setModalData(null);
  }, []);

  return (
    <ModalContext.Provider
      value={{ activeModal, modalData, openModal, closeModal }}
    >
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
