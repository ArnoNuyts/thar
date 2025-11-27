import React, { useState } from "react";
import { Box, Text } from "ink";
import { useFocusedInput } from "../hooks/useFocusedInput.ts";
import { Modal } from "./Modal.tsx";
import { useModal } from "../contexts/modal-context.tsx";

export type MenuAction =
  | "edit"
  | "delete"
  | "toggle"
  | "due"
  | "threshold"
  | "recurrence"
  | "toggle-hidden";

interface TodoMenuProps {
  onSelect: (action: MenuAction) => void;
}

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

export const TodoMenu = ({ onSelect }: TodoMenuProps) => {
  const { closeModal } = useModal();
  const [selectedIndex, setSelectedIndex] = useState(0);

  const { isFocused } = useFocusedInput(
    (input, key) => {
      if (key.escape) {
        closeModal();
        return;
      }

      if (key.return) {
        onSelect(MENU_ITEMS[selectedIndex].action);
        closeModal();
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
        onSelect("edit");
      }

      if (input === "d") {
        onSelect("due");
      }

      if (key.delete) {
        onSelect("delete");
        closeModal();
      }

      if (input === " ") {
        onSelect("toggle");
        closeModal();
      }

      if (input === "t") {
        onSelect("threshold");
        closeModal();
      }

      if (input === "r") {
        onSelect("recurrence");
        closeModal();
      }

      if (input === "h") {
        onSelect("toggle-hidden");
        closeModal();
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
