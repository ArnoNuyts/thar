import { useState } from "react";
import { Box, Text } from "ink";
import { useFocusedInput } from "../hooks/useFocusedInput.ts";
import { useListSelection } from "../hooks/useListSelection.ts";
import { useModalMouseList } from "../hooks/useModalMouseList.ts";
import { useTodoCommands } from "../hooks/useTodoCommands.ts";
import { Key } from "../hooks/useInput.ts";
import { Modal } from "./Modal.tsx";
import { SELECTED_MARKER, UNSELECTED_MARKER } from "./SelectList.tsx";
import { useModal } from "../contexts/modal-context.tsx";
import { COLORS } from "../theme/colors.ts";

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
  | "toggle-view-hidden"
  | "add-project"
  | "add-context";

export interface MenuItem {
  label: string;
  shortcut: string;
  action: MenuAction;
}

export const MENU_ITEMS: MenuItem[] = [
  { label: "Edit", shortcut: "e", action: "edit" },
  { label: "Delete", shortcut: "del", action: "delete" },
  { label: "Toggle Complete", shortcut: "space", action: "toggle" },
  { label: "Set Due Date", shortcut: "d", action: "due" },
  { label: "Set Threshold Date", shortcut: "t", action: "threshold" },
  { label: "Set Recurrence", shortcut: "r", action: "recurrence" },
  { label: "Set Priority", shortcut: "p", action: "priority" },
  { label: "Modify Projects", shortcut: "+", action: "add-project" },
  { label: "Modify Contexts", shortcut: "@", action: "add-context" },
  { label: "Toggle Hidden", shortcut: "h", action: "toggle-hidden" },
  { label: "Show/Hide Hidden", shortcut: "H", action: "toggle-view-hidden" },
  { label: "Archive Completed", shortcut: "a", action: "archive" },
  { label: "Copy", shortcut: "c", action: "copy" },
  { label: "Undo", shortcut: "z", action: "undo" },
  { label: "Redo", shortcut: "Z", action: "redo" },
  { label: "Paste", shortcut: "v", action: "paste" },
];

/**
 * Actions that operate on every todo in the current selection.
 *
 * Edit only accepts one todo, while archive, show/hide hidden, undo, redo and
 * paste are global commands. Those stay in the single-todo menu.
 */
export const MULTI_SELECT_MENU_ITEMS: MenuItem[] = [
  { label: "Delete", shortcut: "del", action: "delete" },
  { label: "Toggle Complete", shortcut: "space", action: "toggle" },
  { label: "Set Due Date", shortcut: "d", action: "due" },
  { label: "Set Threshold Date", shortcut: "t", action: "threshold" },
  { label: "Set Recurrence", shortcut: "r", action: "recurrence" },
  { label: "Set Priority", shortcut: "p", action: "priority" },
  { label: "Modify Projects", shortcut: "+", action: "add-project" },
  { label: "Modify Contexts", shortcut: "@", action: "add-context" },
  { label: "Toggle Hidden", shortcut: "h", action: "toggle-hidden" },
  { label: "Copy", shortcut: "c", action: "copy" },
];

// Display shortcuts that describe a named key rather than a typed character.
// Keeping the canonical names here means dispatch reads the same item data
// that the menu renders.
const NAMED_SHORTCUTS: Record<string, string> = {
  del: "delete",
  delete: "delete",
  space: "space",
  return: "return",
  escape: "escape",
};

const buildShortcutActions = (items: MenuItem[]) =>
  new Map<string, MenuAction>(
    items.map((item) => [
      NAMED_SHORTCUTS[item.shortcut] ?? item.shortcut,
      item.action,
    ]),
  );

const MENU_SHORTCUT_ACTIONS = buildShortcutActions(MENU_ITEMS);

const normalizeInput = (input: string, key: Key): string => {
  if (key.delete) return "delete";
  if (key.return) return "return";
  if (key.escape) return "escape";
  if (input === " ") return "space";
  return input;
};

export const resolveMenuShortcut = (
  input: string,
  key: Key,
  items: MenuItem[] = MENU_ITEMS,
): MenuAction | undefined => {
  const actions = items === MENU_ITEMS
    ? MENU_SHORTCUT_ACTIONS
    : buildShortcutActions(items);
  return actions.get(normalizeInput(input, key));
};

const TodoMenuView = (
  { items, title }: { items: MenuItem[]; title: string },
) => {
  const { closeModal } = useModal();
  const commands = useTodoCommands();
  const [layoutSize, setLayoutSize] = useState<
    { rows?: number; columns?: number }
  >({});

  const handleAction = async (action: MenuAction) => {
    switch (action) {
      case "edit":
        commands.editSelected();
        break;
      case "delete":
        commands.deleteSelected();
        break;
      case "toggle":
        commands.toggleSelected({ onComplete: closeModal });
        break;
      case "due":
        commands.setDueDate();
        break;
      case "threshold":
        commands.setThresholdDate();
        break;
      case "recurrence":
        commands.setRecurrence();
        break;
      case "priority":
        commands.openPriorityModal();
        break;
      case "add-project":
        commands.addProject();
        break;
      case "add-context":
        commands.addContext();
        break;
      case "toggle-hidden":
        commands.toggleSelectedHidden({ onComplete: closeModal });
        break;
      case "toggle-view-hidden":
        commands.toggleHiddenView({ onComplete: closeModal });
        break;
      case "archive":
        commands.archiveSelected();
        break;
      case "copy":
        await commands.copySelected({ onComplete: closeModal });
        break;
      case "undo":
        commands.undo({ onComplete: closeModal });
        break;
      case "redo":
        commands.redo({ onComplete: closeModal });
        break;
      case "paste":
        await commands.pasteTodos({ onComplete: closeModal });
        break;
    }
  };

  const selection = useListSelection({
    itemCount: items.length,
    onSelect: (index) => handleAction(items[index].action),
    onCancel: closeModal,
  });

  const { isFocused } = useFocusedInput(
    (input, key) => {
      if (selection.handleKey(key)) return;

      const action = resolveMenuShortcut(input, key, items);
      if (action) {
        handleAction(action);
      }
    },
    { autoFocus: true },
  );

  useModalMouseList({
    isActive: isFocused,
    modalWidth: "50%",
    bodyRows: items.length,
    terminalSize: layoutSize,
    onRowClick: selection.selectAt,
    onRowHover: selection.setSelectedIndex,
  });

  return (
    // @ts-ignore: children prop issue
    <Modal
      title={title}
      onLayoutSizeChange={setLayoutSize}
    >
      <Box flexDirection="column">
        {items.map((item, index) => {
          const isSelected = index === selection.selectedIndex;
          return (
            <Box
              key={item.action}
              justifyContent="space-between"
              paddingRight={1}
            >
              <Box>
                <Text color={COLORS.secondary}>
                  {isSelected ? SELECTED_MARKER : UNSELECTED_MARKER}
                </Text>
                <Text wrap="truncate">{item.label}</Text>
              </Box>
              <Box>
                <Text color={COLORS.primary}>{item.shortcut}</Text>
              </Box>
            </Box>
          );
        })}
      </Box>
    </Modal>
  );
};

export const TodoMenu = () => (
  <TodoMenuView items={MENU_ITEMS} title="Todo menu" />
);

export const MultiSelectMenu = () => (
  <TodoMenuView items={MULTI_SELECT_MENU_ITEMS} title="Multi-select menu" />
);
