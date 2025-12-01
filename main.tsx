import { Box, render } from "ink";
import { ActionBar } from "./components/ActionBar.tsx";
import { ConfirmModal } from "./components/ConfirmModal.tsx";
import { CreateTodoModal } from "./components/CreateTodoModal.tsx";
import { EditTodoModal } from "./components/EditTodoModal.tsx";
import { SetDateModal } from "./components/SetDateModal.tsx";
import { SetRecurrenceModal } from "./components/SetRecurrenceModal.tsx";
import { TodoList } from "./components/TodoList.tsx";
import { TodoMenu } from "./components/TodoMenu.tsx";
import { FocusProvider } from "./contexts/focus-context.tsx";
import { ModalProvider, useModal } from "./contexts/modal-context.tsx";
import { TodoProvider } from "./contexts/todo-context.tsx";

const AppContent = () => {
  const { activeModal, modalData } = useModal();

  return (
    <>
      <Box
        flexDirection="column"
        height="100%"
        width="100%"
        justifyContent="space-between"
      >
        <TodoList />
        <ActionBar />
      </Box>
      {activeModal === "create-todo" && <CreateTodoModal />}
      {activeModal === "edit-todo" && <EditTodoModal />}
      {activeModal === "todo-menu" && <TodoMenu />}
      {activeModal === "set-due-date" && <SetDateModal type="due" />}
      {activeModal === "set-threshold-date" &&
        <SetDateModal type="threshold" />}
      {activeModal === "set-recurrence" && <SetRecurrenceModal />}
      {activeModal === "confirm-modal" && (
        <ConfirmModal
          title={modalData?.title}
          message={modalData?.message}
          onConfirm={modalData?.onConfirm}
          onCancel={modalData?.onCancel}
        />
      )}
    </>
  );
};

const App = ({ filename }: { filename: string }) => {
  return (
    <ModalProvider>
      <TodoProvider filename={filename}>
        <FocusProvider>
          <AppContent />
        </FocusProvider>
      </TodoProvider>
    </ModalProvider>
  );
};

const filename = Deno.args[0] || "todo.txt";

render(<App filename={filename} />, {
  incrementalRendering: true,
  patchConsole: true,
  exitOnCtrlC: true,
});
