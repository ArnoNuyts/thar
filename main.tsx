import { render } from "ink";
import { ActionBar } from "./components/ActionBar.tsx";
import { ConfirmModal } from "./components/ConfirmModal.tsx";
import { HiddenIndicator } from "./components/HiddenIndicator.tsx";
import { modalRegistry } from "./components/modal-registry.tsx";
import { TodoList } from "./components/TodoList.tsx";
import { FocusProvider } from "./contexts/focus-context.tsx";
import { ModalProvider, useModal } from "./contexts/modal-context.tsx";
import { TodoProvider, useTodo } from "./contexts/todo-context.tsx";
import { ToasterProvider } from "./contexts/toaster-context.tsx";
import { UpdateProvider } from "./contexts/update-context.tsx";

import { SuggestionOverlay } from "./components/SuggestionOverlay.tsx";
import { SuggestionProvider } from "./contexts/suggestion-context.tsx";
import { SearchProvider } from "./contexts/search-context.tsx";
import { NavigationProvider } from "./contexts/navigation-context.tsx";
import { SearchInput } from "./components/SearchInput.tsx";
import {
  CliError,
  formatUsage,
  parseCliArgs,
  type CliOptions,
} from "./logic/cli.ts";
import { getDefaultInstallDescriptor } from "./logic/install-method.ts";
import { takePendingUpdate } from "./logic/pending-update.ts";
import { runPendingUpdate } from "./logic/self-update.ts";
import { runUpdateCli } from "./logic/update-cli.ts";
import { Runtime } from "./utils/runtime.ts";
import packageJson from "./package.json" with { type: "json" };

const AppContent = () => {
  const { activeModal, modalData } = useModal();
  const { todos } = useTodo();

  const renderActiveModal = () => {
    if (activeModal === null) return null;

    if (activeModal === "confirm-modal") {
      // `openConfirmModal` sets both fields atomically, so this only guards
      // the nullable context type (and a defensive render before state lands).
      if (!modalData) return null;

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

const App = ({
  filename,
  noUpdateCheck,
}: {
  filename: string;
  noUpdateCheck: boolean;
}) => {
  return (
    <ModalProvider>
      <ToasterProvider>
        <UpdateProvider
          options={{ enabled: !noUpdateCheck, argv: Runtime.args }}
        >
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
        </UpdateProvider>
      </ToasterProvider>
    </ModalProvider>
  );
};

const version = packageJson.version;

let cli: CliOptions;
try {
  cli = parseCliArgs(Runtime.args);
} catch (error) {
  if (error instanceof CliError) {
    console.error(`thar: ${error.message}\n`);
    console.error(formatUsage(version));
    Runtime.exit(2);
  }
  throw error;
}

if (cli.help) {
  console.log(formatUsage(version));
  Runtime.exit(0);
}

if (cli.version) {
  console.log(version);
  Runtime.exit(0);
}

if (cli.update) {
  process.exitCode = await runUpdateCli({
    argv: Runtime.args,
    currentVersion: version,
    installDescriptor: getDefaultInstallDescriptor(),
  });
} else {
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

  const instance = render(
    <App filename={cli.file} noUpdateCheck={cli.noUpdateCheck} />,
    {
      incrementalRendering: true,
      patchConsole: true,
      exitOnCtrlC: true,
    },
  );

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

  const pendingUpdate = takePendingUpdate();
  if (pendingUpdate) {
    process.stdout.write(`Updating thar to v${pendingUpdate.version}...\n`);
    const result = await runPendingUpdate(pendingUpdate);

    if (result.ok) {
      process.stdout.write(
        `Updated thar to v${pendingUpdate.version}. Restart thar to use the new version.\n`,
      );
    } else {
      process.stdout.write(
        `Update failed. Nothing was changed. Run manually: ${pendingUpdate.command.display}\n`,
      );
      process.exitCode = 1;
    }
  }
}
