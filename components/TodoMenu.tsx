import { useState } from "react";
import { Box, Text } from "ink";
import { useFocusedInput } from "../hooks/useFocusedInput.ts";
import { Modal } from "./Modal.tsx";
import { useModal } from "../contexts/modal-context.tsx";
import { useTodo } from "../contexts/todo-context.tsx";
import { useToaster } from "../contexts/toaster-context.tsx";
import { useNavigation } from "../contexts/navigation-context.tsx";
import { copyToClipboard, readFromClipboard } from "../logic/clipboard.ts";
import { PRIMARY_COLOR, SECONDARY_COLOR } from "../constants.ts";
import { Todo } from "../logic/todo.ts";

export type MenuAction =
  | "edit"
  | "delete"
  | "toggle"
  | "due"
  | "threshold"
  | "recurrence"
  | "toggle-hidden"
  | "priority"
  | "archive"
  | "copy"
  | "undo"
  | "redo"
  | "paste"
  | "toggle-view-hidden";

interface MenuItem {
  label: string;
  shortcut: string;
  action: MenuAction;
}

const MENU_ITEMS: MenuItem[] = [
  { label: "Edit", shortcut: "e", action: "edit" },
  { label: "Delete", shortcut: "del", action: "delete" },
  { label: "Toggle Complete", shortcut: "space", action: "toggle" },
  { label: "Set Due Date", shortcut: "d", action: "due" },
  { label: "Set Threshold Date", shortcut: "t", action: "threshold" },
  { label: "Set Recurrence", shortcut: "r", action: "recurrence" },
  { label: "Set Priority", shortcut: "p", action: "priority" },
  { label: "Toggle Hidden", shortcut: "h", action: "toggle-hidden" },
  { label: "Show/Hide Hidden", shortcut: "H", action: "toggle-view-hidden" },
  { label: "Archive Completed", shortcut: "a", action: "archive" },
  { label: "Copy", shortcut: "c", action: "copy" },
  { label: "Undo", shortcut: "z", action: "undo" },
  { label: "Redo", shortcut: "Z", action: "redo" },
  { label: "Paste", shortcut: "v", action: "paste" },
];

export const TodoMenu = () => {
  const { closeModal, openModal } = useModal();
  const {
    deleteTodos,
    toggleTodos,
    toggleHidden,
    archiveCompletedTodos,
    undo,
    redo,
    addTodos,
  } = useTodo();
  const {
    useSelectedTodo,
    useSelectedTodos,
    setSelectedTodoId,
    toggleShowHidden,
  } = useNavigation();
  const { showToaster } = useToaster();
  const todo = useSelectedTodo();
  const selectedTodos = useSelectedTodos();
  const [selectedIndex, setSelectedIndex] = useState(0);

  const handleAction = async (action: MenuAction) => {
    switch (action) {
      case "edit":
        if (todo) openModal("edit-todo", todo);
        break;
      case "delete":
        if (selectedTodos.length > 0) {
          openModal("confirm-modal", {
            title: selectedTodos.length > 1 ? "Delete Todos" : "Delete Todo",
            message: selectedTodos.length > 1
              ? `Are you sure you want to delete ${selectedTodos.length} todos?`
              : "Are you sure you want to delete this todo?",
            onConfirm: () => {
              deleteTodos(selectedTodos);
            },
          });
        }
        break;
      case "toggle":
        if (selectedTodos.length > 0) {
          toggleTodos(selectedTodos);
          closeModal();
        }
        break;
      case "due":
        openModal("set-due-date");
        break;
      case "threshold":
        openModal("set-threshold-date");
        break;
      case "recurrence":
        openModal("set-recurrence");
        break;
      case "priority":
        openModal("set-priority");
        break;
      case "toggle-hidden":
        if (selectedTodos.length > 0) {
          toggleHidden(selectedTodos);
          closeModal();
        }
        break;
      case "toggle-view-hidden":
        toggleShowHidden();
        closeModal();
        break;
      case "archive":
        openModal("confirm-modal", {
          title: "Archive Completed",
          message: "Archive all completed todos to done.txt?",
          onConfirm: async () => {
            await archiveCompletedTodos();
          },
        });
        break;
      case "copy":
        if (selectedTodos.length > 0) {
          try {
            await copyToClipboard(
              selectedTodos.map((t: Todo) => t.toString()).join("\n"),
            );
            showToaster(
              selectedTodos.length > 1
                ? `${selectedTodos.length} todos copied`
                : "Todo copied",
            );
          } catch (e) {
            showToaster(
              `Copy failed: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
          closeModal();
        }
        break;
      case "undo":
        undo();
        closeModal();
        break;
      case "redo":
        redo();
        closeModal();
        break;
      case "paste": {
        try {
          const text = await readFromClipboard();
          const lines = text
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.length > 0);
          if (lines.length === 0) {
            closeModal();
            return;
          }

          const doPaste = () => {
            const added = addTodos(...lines);
            if (added.length > 0) {
              setSelectedTodoId(added[added.length - 1].id);
            }
            showToaster(`Pasted ${lines.length} todo(s)`);
            closeModal();
          };

          if (lines.length > 10) {
            openModal("confirm-modal", {
              title: "Paste Multiple Todos",
              message: `Are you sure you want to paste ${lines.length} todos?`,
              onConfirm: doPaste,
            });
          } else {
            doPaste();
          }
        } catch (e) {
          showToaster(
            `Paste failed: ${e instanceof Error ? e.message : String(e)}`,
          );
          closeModal();
        }
        break;
      }
    }
  };

  const { isFocused } = useFocusedInput(
    (input, key) => {
      if (key.escape) {
        closeModal();
        return;
      }

      if (key.return) {
        handleAction(MENU_ITEMS[selectedIndex].action);
        return;
      }

      if (key.upArrow) {
        setSelectedIndex((prev: number) =>
          prev > 0 ? prev - 1 : MENU_ITEMS.length - 1
        );
        return;
      }

      if (key.downArrow) {
        setSelectedIndex((prev: number) =>
          prev < MENU_ITEMS.length - 1 ? prev + 1 : 0
        );
        return;
      }

      // Shortcut handling
      if (input === "e") {
        handleAction("edit");
      }

      if (input === "d") {
        handleAction("due");
      }

      if (key.delete) {
        handleAction("delete");
      }

      if (input === " ") {
        handleAction("toggle");
      }

      if (input === "t") {
        handleAction("threshold");
      }

      if (input === "r") {
        handleAction("recurrence");
      }

      if (input === "p") {
        handleAction("priority");
      }

      if (input === "h") {
        handleAction("toggle-hidden");
      }

      if (input === "H") {
        handleAction("toggle-view-hidden");
      }

      if (input === "a") {
        handleAction("archive");
      }

      if (input === "c") {
        handleAction("copy");
      }

      if (input === "z") {
        handleAction("undo");
      }

      if (input === "Z") {
        handleAction("redo");
      }

      if (input === "v") {
        handleAction("paste");
      }
    },
    { autoFocus: true },
  );

  return (
    // @ts-ignore: children prop issue
    <Modal isFocused={isFocused} title="Todo menu">
      <Box flexDirection="column">
        {MENU_ITEMS.map((item, index) => {
          const isSelected = index === selectedIndex;
          return (
            <Box
              key={item.action}
              justifyContent="space-between"
              paddingRight={1}
            >
              <Box>
                <Text color={SECONDARY_COLOR}>{isSelected ? "» " : "  "}</Text>
                <Text>{item.label}</Text>
              </Box>
              <Box>
                <Text color={PRIMARY_COLOR}>{item.shortcut}</Text>
              </Box>
            </Box>
          );
        })}
      </Box>
    </Modal>
  );
};
