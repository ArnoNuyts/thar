import { useMemo, useState } from "react";
import { Box, Text } from "ink";
import { useFocusedInput } from "../hooks/useFocusedInput.ts";
import { useModalMouseList } from "../hooks/useModalMouseList.ts";
import { Modal } from "./Modal.tsx";
import { useModal } from "../contexts/modal-context.tsx";
import { useTodo } from "../contexts/todo-context.tsx";
import { useNavigation } from "../contexts/navigation-context.tsx";
import { COLORS } from "../theme/colors.ts";

interface AddTagContextModalProps {
  type: "project" | "context";
}

type ItemState = "all" | "some" | "none";

interface TagItem {
  name: string;
  state: ItemState;
  pendingState: ItemState; // Track pending changes
}

export const AddTagContextModal = ({ type }: AddTagContextModalProps) => {
  const { closeModal } = useModal();
  const { updateTodos, todos } = useTodo();
  const { getSelectedTodos } = useNavigation();
  const selectedTodos = getSelectedTodos();

  const [selectedIndex, setSelectedIndex] = useState(0);
  const [customInput, setCustomInput] = useState("");
  const [pendingChanges, setPendingChanges] = useState<
    Map<string, "add" | "remove">
  >(new Map());
  const [layoutSize, setLayoutSize] = useState<{
    rows?: number;
    columns?: number;
  }>({});

  const prefix = type === "project" ? "+" : "@";
  const title = type === "project" ? "Modify Projects" : "Modify Contexts";

  // Collect all unique tags from all todos
  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    for (const todo of todos) {
      const tags = type === "project" ? todo.projects : todo.contexts;
      for (const tag of tags) {
        tagSet.add(tag);
      }
    }
    return Array.from(tagSet).sort();
  }, [todos, type]);

  // Calculate state for each tag based on selected todos
  const tagItems: TagItem[] = useMemo(() => {
    return allTags.map((name) => {
      const selectedHaving = selectedTodos.filter((todo) => {
        const tags = type === "project" ? todo.projects : todo.contexts;
        return tags.has(name);
      });

      let state: ItemState;
      if (selectedHaving.length === selectedTodos.length) {
        state = "all";
      } else if (selectedHaving.length > 0) {
        state = "some";
      } else {
        state = "none";
      }

      // Apply pending changes to determine visual state
      const pendingAction = pendingChanges.get(name);
      let pendingState = state;
      if (pendingAction === "add") {
        pendingState = "all";
      } else if (pendingAction === "remove") {
        pendingState = "none";
      }

      return { name, state, pendingState };
    });
  }, [allTags, selectedTodos, type, pendingChanges]);

  const isCustomSelected = selectedIndex === 0;
  const options = ["custom", ...allTags];

  const getCheckbox = (item: TagItem): string => {
    switch (item.pendingState) {
      case "all":
        return "[x]";
      case "some":
        return "[?]";
      case "none":
        return "[ ]";
    }
  };

  const getColor = (item: TagItem): string | undefined => {
    switch (item.pendingState) {
      case "all":
        return "green";
      case "some":
        return "yellow";
      case "none":
        return "gray";
    }
  };

  const toggleItem = (name: string) => {
    const item = tagItems.find((i) => i.name === name);
    if (!item) return;

    setPendingChanges((prev) => {
      const newChanges = new Map(prev);
      const currentPending = newChanges.get(name);

      if (item.state === "some") {
        // Cycle: some -> all (add) -> none (remove) -> some (delete pending)
        if (!currentPending) {
          newChanges.set(name, "add");
        } else if (currentPending === "add") {
          newChanges.set(name, "remove");
        } else {
          newChanges.delete(name);
        }
      } else if (item.state === "all") {
        // Toggle: all -> none (remove) -> all (delete pending)
        if (!currentPending) {
          newChanges.set(name, "remove");
        } else {
          newChanges.delete(name);
        }
      } else {
        // Toggle: none -> all (add) -> none (delete pending)
        if (!currentPending) {
          newChanges.set(name, "add");
        } else {
          newChanges.delete(name);
        }
      }

      return newChanges;
    });
  };

  const applyChanges = () => {
    if (selectedTodos.length === 0) {
      closeModal();
      return;
    }

    // Apply custom input if it has content and is selected
    if (customInput.trim()) {
      const cleanName = customInput.trim();
      if (type === "project") {
        updateTodos(selectedTodos, (t) => t.addProject(cleanName));
      } else {
        updateTodos(selectedTodos, (t) => t.addContext(cleanName));
      }
    }

    // Apply pending changes
    for (const [name, action] of pendingChanges) {
      if (action === "add") {
        if (type === "project") {
          updateTodos(selectedTodos, (t) => t.addProject(name));
        } else {
          updateTodos(selectedTodos, (t) => t.addContext(name));
        }
      } else if (action === "remove") {
        if (type === "project") {
          updateTodos(selectedTodos, (t) => t.removeProject(name));
        } else {
          updateTodos(selectedTodos, (t) => t.removeContext(name));
        }
      }
    }

    closeModal();
  };

  const { isFocused } = useFocusedInput(
    (input, key) => {
      if (key.escape) {
        closeModal();
        return;
      }

      if (key.return) {
        applyChanges();
        return;
      }

      if (key.upArrow) {
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : options.length - 1));
        return;
      }

      if (key.downArrow) {
        setSelectedIndex((prev) => (prev < options.length - 1 ? prev + 1 : 0));
        return;
      }

      if (input === " " && !isCustomSelected) {
        const tagName = options[selectedIndex];
        toggleItem(tagName);
        return;
      }

      // Handle typing for custom input when custom is selected
      if (isCustomSelected && input && !key.ctrl && !key.meta) {
        if (key.backspace || key.delete) {
          setCustomInput((prev) => prev.slice(0, -1));
        } else if (input.length === 1 && /[\w.\-_]/.test(input)) {
          setCustomInput((prev) => prev + input);
        }
        return;
      }

      // Handle backspace for custom input
      if (isCustomSelected && (key.backspace || key.delete)) {
        setCustomInput((prev) => prev.slice(0, -1));
        return;
      }
    },
    { autoFocus: true, tag: `add-${type}-modal` },
  );

  const bodyRows = tagItems.length > 0 ? tagItems.length + 2 : 2;
  useModalMouseList({
    isActive: isFocused,
    modalWidth: 40,
    bodyRows,
    terminalSize: layoutSize,
    onRowClick: (rowInBody) => {
      if (rowInBody === 0) {
        setSelectedIndex(0);
        return;
      }

      if (tagItems.length === 0) return;
      if (rowInBody === 1) return;

      const optionIndex = rowInBody - 1;
      if (optionIndex < 1 || optionIndex >= options.length) return;

      setSelectedIndex(optionIndex);
      const tagName = options[optionIndex];
      toggleItem(tagName);
    },
  });

  return (
    <Modal title={title} width={40} onLayoutSizeChange={setLayoutSize}>
      <Box flexDirection="column" paddingX={1}>
        {/* Custom input option */}
        <Box>
          <Text color={COLORS.secondary}>{isCustomSelected ? "» " : "  "}</Text>
          <Text>New:</Text>
          <Text color="cyan">{prefix}</Text>
          <Text inverse={isCustomSelected}>{customInput || " "}</Text>
        </Box>

        {/* Separator */}
        {tagItems.length > 0 && (
          <Box marginY={0}>
            <Text dimColor>───────────────────────</Text>
          </Box>
        )}

        {/* Existing tags */}
        {tagItems.map((item, index) => {
          const isSelected = selectedIndex === index + 1;
          return (
            <Box key={item.name}>
              <Text color={COLORS.secondary}>{isSelected ? "» " : "  "}</Text>
              <Text color={getColor(item)} wrap="truncate">
                {getCheckbox(item)} {item.name}
              </Text>
            </Box>
          );
        })}

        {tagItems.length === 0 && <Text dimColor>No existing {type}s</Text>}
      </Box>
    </Modal>
  );
};
