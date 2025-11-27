import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import { Todo } from '../logic/todo.ts';

export type ModalId = 'create-todo' | 'edit-todo' | 'todo-menu' | 'set-due-date';

interface ModalContextType {
    activeModal: ModalId | null;
    modalData: Todo | null;
    openModal: (id: ModalId, data?: Todo) => void;
    closeModal: () => void;
}

const ModalContext = createContext<ModalContextType | null>(null);

export const ModalProvider = ({ children }: { children?: ReactNode }) => {
    const [activeModal, setActiveModal] = useState<ModalId | null>(null);
    const [modalData, setModalData] = useState<Todo | null>(null);

    const openModal = useCallback((id: ModalId, data?: Todo) => {
        setActiveModal(id);
        setModalData(data || null);
    }, []);

    const closeModal = useCallback(() => {
        setActiveModal(null);
        setModalData(null);
    }, []);

    return (
        <ModalContext.Provider value={{ activeModal, modalData, openModal, closeModal }}>
            {children}
        </ModalContext.Provider>
    );
};

export const useModal = () => {
    const context = useContext(ModalContext);
    if (!context) {
        throw new Error('useModal must be used within ModalProvider');
    }
    return context;
};
