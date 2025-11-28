import { Box, render } from "ink";
import React from "react";
import { ActionBar } from "./components/ActionBar.tsx";
import { CreateTodoModal } from "./components/CreateTodoModal.tsx";
import { EditTodoModal } from "./components/EditTodoModal.tsx";
import { SetDueDateModal } from "./components/SetDueDateModal.tsx";
import { TodoMenu } from "./components/TodoMenu.tsx";
import { TodoList } from "./components/TodoList.tsx";
import { FocusProvider } from "./contexts/focus-context.tsx";
import { ModalProvider, useModal } from "./contexts/modal-context.tsx";
import { TodoProvider } from "./contexts/todo-context.tsx";

const AppContent = () => {
  const { activeModal } = useModal();

  return (
    <Box flexDirection="column" height="100%" width="100%" flexGrow={1}>
      <TodoList />
      <ActionBar />
      {activeModal === "create-todo" && <CreateTodoModal />}
      {activeModal === "edit-todo" && <EditTodoModal />}
      {activeModal === "todo-menu" && <TodoMenu />}
      {activeModal === "set-due-date" && (
        <SetDueDateModal />
      )}
    </Box>
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

const filename = Deno.args[0] || "test.txt";
render(<App filename={filename} />);
