import { render } from "ink";
import { ActionBar } from "./components/ActionBar.tsx";
import { ConfirmModal } from "./components/ConfirmModal.tsx";
import { HiddenIndicator } from "./components/HiddenIndicator.tsx";
import { modalRegistry } from "./components/modal-registry.tsx";
import { TodoList } from "./components/TodoList.tsx";
import { FocusProvider } from "./contexts/focus-context.tsx";
import {
  isConfirmModalData,
  ModalProvider,
  useModal,
} from "./contexts/modal-context.tsx";
import { TodoProvider, useTodo } from "./contexts/todo-context.tsx";
import { ToasterProvider } from "./contexts/toaster-context.tsx";

import { SuggestionOverlay } from "./components/SuggestionOverlay.tsx";
import { SuggestionProvider } from "./contexts/suggestion-context.tsx";
import { SearchProvider } from "./contexts/search-context.tsx";
import { NavigationProvider } from "./contexts/navigation-context.tsx";
import { SearchInput } from "./components/SearchInput.tsx";
import { Runtime } from "./utils/runtime.ts";

const AppContent = () => {
  const { activeModal, modalData } = useModal();
  const { todos } = useTodo();

  const renderActiveModal = () => {
    if (activeModal === null) return null;

    if (activeModal === "confirm-modal") {
      if (!isConfirmModalData(modalData)) return null;

      return (
        <ConfirmModal
          title={modalData.title}
          message={modalData.message}
          onConfirm={modalData.onConfirm}
          onCancel={modalData.onCancel}
        />
      );
    }

    const ActiveModal = modalRegistry[activeModal];
    return <ActiveModal />;
  };

  return (
    <>
      <SearchInput todos={todos} />
      <TodoList />
      <ActionBar />
      <HiddenIndicator />
      {renderActiveModal()}
      <SuggestionOverlay />
    </>
  );
};

const NavigationWrapper = ({ children }: { children: React.ReactNode }) => {
  const { todos } = useTodo();
  return <NavigationProvider todos={todos}>{children}</NavigationProvider>;
};

const App = ({ filename }: { filename: string }) => {
  return (
    <ModalProvider>
      <ToasterProvider>
        <TodoProvider filename={filename}>
          <FocusProvider>
            <SuggestionProvider>
              <SearchProvider>
                <NavigationWrapper>
                  <AppContent />
                </NavigationWrapper>
              </SearchProvider>
            </SuggestionProvider>
          </FocusProvider>
        </TodoProvider>
      </ToasterProvider>
    </ModalProvider>
  );
};

const filename = Runtime.args[0] || "todo.txt";

const isWindows = Runtime.platform === "windows";
let originalChcp: string | null = null;

if (isWindows) {
  try {
    const command = new Runtime.Command("cmd", {
      args: ["/c", "chcp"],
    });
    const { stdout } = await command.output();
    const output = new TextDecoder().decode(stdout);
    const match = output.match(/\d+/);
    if (match) {
      originalChcp = match[0];
    }

    const setUtf8 = new Runtime.Command("cmd", {
      args: ["/c", "chcp", "65001"],
    });
    await setUtf8.output();
  } catch (_e) {
    // Ignore errors
  }
}

const instance = render(<App filename={filename} />, {
  incrementalRendering: true,
  patchConsole: true,
  exitOnCtrlC: true,
});

await instance.waitUntilExit();

if (isWindows && originalChcp) {
  try {
    const restore = new Runtime.Command("cmd", {
      args: ["/c", "chcp", originalChcp],
    });
    await restore.output();
  } catch (_e) {
    // Ignore
  }
}
