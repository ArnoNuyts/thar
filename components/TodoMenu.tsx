import React, { useState } from "react";
import { Box, Text } from "ink";
import { useFocusedInput } from "../hooks/useFocusedInput.ts";
import { Modal } from "./Modal.tsx";
import { useModal } from "../contexts/modal-context.tsx";
import { useTodo } from "../contexts/todo-context.tsx";

export type MenuAction =
  | "edit"
  | "delete"
  | "toggle"
  | "due"
  | "threshold"
  | "recurrence"
  | "toggle-hidden";

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
  { label: "Toggle Hidden", shortcut: "h", action: "toggle-hidden" },
];

export const TodoMenu = () => {
  const { closeModal, openModal } = useModal();
  const { useSelectedTodo, deleteTodo, toggleTodo, toggleHidden } = useTodo();
  const todo = useSelectedTodo();
  const [selectedIndex, setSelectedIndex] = useState(0);

  const handleAction = (action: MenuAction) => {
    if (!todo) return;
    switch (action) {
      case "edit":
        openModal("edit-todo", todo);
        break;
      case "delete":
        deleteTodo(todo);
        closeModal();
        break;
      case "toggle":
        toggleTodo(todo);
        closeModal();
        break;
      case "due":
        openModal("set-due-date");
        break;
      case "threshold":
        openModal("set-threshold-date");
        break;
      case "recurrence":
        closeModal();
        break;
      case "toggle-hidden":
        toggleHidden(todo);
        closeModal();
        break;
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

      if (input === "h") {
        handleAction("toggle-hidden");
      }
    },
    { autoFocus: true }
  );

  return (
    // @ts-ignore: children prop issue
    <Modal isFocused={isFocused} title="Todo menu">
      <Box flexDirection="column">
        {MENU_ITEMS.map((item, index) => {
          const isSelected = index === selectedIndex;
          return (
            <Box key={item.action} justifyContent="space-between">
              <Box>
                <Text color="green">{isSelected ? "» " : "  "}</Text>
                <Text>{item.label}</Text>
              </Box>
              <Box>
                <Text color="yellow">{item.shortcut}</Text>
              </Box>
            </Box>
          );
        })}
      </Box>
    </Modal>
  );
};
