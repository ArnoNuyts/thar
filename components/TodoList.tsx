import { Box, Newline, Text, useApp } from "ink";
import { memo, useMemo, useRef } from "react";
import { useModal } from "../contexts/modal-context.tsx";
import { useNavigation } from "../contexts/navigation-context.tsx";
import { useSearch } from "../contexts/search-context.tsx";
import { ExtendedKey, useFocusedInput } from "../hooks/useFocusedInput.ts";
import { useMouseInput } from "../hooks/useMouseInput.ts";
import { useTodoCommands } from "../hooks/useTodoCommands.ts";
import { IndexEntry } from "../logic/indexes.ts";
import { Todo } from "../logic/todo.ts";
import { IndexType } from "../types/enums.ts";
import { isPriorityInput } from "../logic/priority.ts";
import { TodoListScrollbar } from "./TodoListScrollbar.tsx";
import { COLORS } from "../theme/colors.ts";

export const renderTodoText = (
  text: string,
  isHighlighted: boolean,
  isOverdue: boolean,
) => {
  const parts = text.split(/(@[^ ]+|\+[^ ]+)/g);
  let offset = 0;
  return parts.map((part) => {
    // Offset + content stays unique even when the same tag repeats, unlike
    // the array index which changes when segments are inserted or reordered.
    const key = `${offset}:${part}`;
    offset += part.length;

    if (part.startsWith("@")) {
      return (
        <Text
          key={key}
          color={isHighlighted ? COLORS.textOnHighlight : COLORS.tagContext}
        >
          {part}
        </Text>
      );
    } else if (part.startsWith("+")) {
      return (
        <Text
          key={key}
          color={isHighlighted ? COLORS.textOnHighlight : COLORS.tagProject}
        >
          {part}
        </Text>
      );
    }
    return (
      <Text
        key={key}
        color={isHighlighted
          ? COLORS.textOnHighlight
          : (isOverdue ? COLORS.danger : undefined)}
      >
        {part}
      </Text>
    );
  });
};

const TodoItem = (
  { todo, isFocused, isSelectedInRange, number, maxDigits }: {
    todo: Todo;
    isFocused: boolean;
    isSelectedInRange: boolean;
    number: number;
    maxDigits: number;
    key?: React.Key;
  },
) => {
  const checkbox = todo.isDone() ? "[x]" : "[ ]";
  const priority = todo.priority ? `(${todo.priority})` : "";
  const dueDate = todo.tags.due ? `due:${todo.tags.due}` : "";
  const threshold = todo.tags.t ? `t:${todo.tags.t}` : "";
  const recurrence = todo.tags.rec ? `rec:${todo.tags.rec}` : "";
  const isOverdue = todo.isOverdue();

  // Pad the number with spaces to align with the maximum number of digits
  const paddedNumber = number.toString().padStart(maxDigits, " ");

  const isHighlighted = isFocused || isSelectedInRange;
  const backgroundColor = isFocused
    ? (isOverdue ? COLORS.focusBackgroundOverdue : COLORS.focusBackground)
    : (isSelectedInRange ? COLORS.selectionBackground : undefined);

  return (
    <Box
      backgroundColor={backgroundColor}
    >
      <Text wrap="truncate">
        <Text
          dimColor
          color={isHighlighted
            ? COLORS.textOnHighlight
            : (isOverdue ? COLORS.danger : undefined)}
        >
          {` ${paddedNumber} `}
        </Text>
        <Text
          color={isHighlighted
            ? COLORS.textOnHighlight
            : (isOverdue ? COLORS.danger : undefined)}
        >
          {`${checkbox} `}
        </Text>
        {priority && (
          <Text
            color={isHighlighted
              ? COLORS.textOnHighlight
              : todo.priority === "A"
              ? COLORS.priorityA
              : todo.priority === "B"
              ? COLORS.priorityB
              : todo.priority === "C"
              ? COLORS.priorityC
              : todo.priority === "D"
              ? COLORS.priorityD
              : todo.priority === "E"
              ? COLORS.priorityE
              : todo.priority === "F"
              ? COLORS.priorityF
              : undefined}
          >
            {`${priority} `}
          </Text>
        )}
        {renderTodoText(todo.text, isHighlighted, isOverdue)}
        {dueDate && (
          <Text color={isHighlighted ? COLORS.textOnHighlight : COLORS.danger}>
            {` ${dueDate}`}
          </Text>
        )}
        {threshold && (
          <Text color={isHighlighted ? COLORS.textOnHighlight : COLORS.success}>
            {` ${threshold}`}
          </Text>
        )}
        {recurrence && (
          <Text color={isHighlighted ? COLORS.textOnHighlight : COLORS.info}>
            {` ${recurrence}`}
          </Text>
        )}
      </Text>
    </Box>
  );
};

const ContextTitle = memo(
  ({ title, count }: { title: string; count: number; key?: React.Key }) => {
    return (
      <Box>
        <Text backgroundColor={COLORS.primary} color={COLORS.inverseForeground}>
          {`  ${title} (${count})  `}
        </Text>
      </Box>
    );
  },
);

const WelcomeScreen = () => (
  <Box
    width="100%"
    height="100%"
    justifyContent="center"
    alignItems="center"
    flexDirection="column"
  >
    <Text>
      I love deadlines. I love the whooshing noise they make as they go by.
    </Text>
    <Text color={COLORS.muted}>
      - Douglas Adams
    </Text>
    <Newline />
    <Text color={COLORS.muted} dimColor>
      Press &apos;n&apos; to create a new todo.
    </Text>
  </Box>
);

const SearchEmptyState = ({ query }: { query: string }) => (
  <Box
    width="100%"
    height="100%"
    justifyContent="center"
    alignItems="center"
    flexDirection="column"
  >
    <Text>
      No results found for {` '`}
      <Text color={COLORS.warning}>{query}</Text>
      {`' `}
    </Text>
    <Newline />
    <Text color={COLORS.muted} dimColor>
      Try a different search or press Esc to clear.
    </Text>
  </Box>
);

export const TodoList = () => {
  const { exit } = useApp();
  const {
    indexes,
    offsetRow,
    listHeight,
    scrollViewportUp,
    scrollViewportDown,
    navigateUp,
    navigateDown,
    navigateContextUp,
    navigateContextDown,
    navigatePageUp,
    navigatePageDown,
    navigateHome,
    navigateEnd,
    setSelectedTodoId,
    getSelectedTodo,
    selectedTodoIds,
    clearMultiSelect,
  } = useNavigation();

  const { openModal, activeModal } = useModal();
  const { focusRef, searchQuery, isSearchFocused } = useSearch();
  const commands = useTodoCommands();

  const todo = getSelectedTodo();
  const lastClickRef = useRef<
    {
      id?: symbol;
      x?: number;
      y?: number;
      time: number;
    } | null
  >(null);

  // Derived state for rendering and mouse hit-testing
  const visibleIndexes: IndexEntry[] = useMemo(
    () => indexes.slice(offsetRow, offsetRow + listHeight),
    [listHeight, offsetRow, indexes],
  );

  const { isFocused, focus } = useFocusedInput((input, key: ExtendedKey) => {
    if (key.upArrow && key.ctrl) return navigateContextUp(key.shift);
    if (key.downArrow && key.ctrl) return navigateContextDown(key.shift);
    if (key.upArrow) return navigateUp(key.shift);
    if (key.downArrow) return navigateDown(key.shift);
    if (key.pageUp) return navigatePageUp(key.shift);
    if (key.pageDown) return navigatePageDown(key.shift);
    if (key.home) return navigateHome();
    if (key.end) return navigateEnd();
    if (key.return) return openModal("todo-menu");
    if (key.escape) return clearMultiSelect();
    if (key.delete) {
      commands.deleteSelected();
      return;
    }

    switch (input) {
      case "/":
        focusRef.current?.();
        break;
      case "q":
        exit();
        break;
      case " ":
        commands.toggleSelected();
        break;
      case "x":
        openModal("todo-menu");
        break;
      case "n":
        openModal("create-todo");
        break;
      case "z":
        commands.undo();
        break;
      case "Z":
        commands.redo();
        break;
      case "v":
        commands.pasteTodos();
        break;
      case "e":
        commands.editSelected();
        break;
      case "a":
        commands.archiveSelected();
        break;
      case "d":
        commands.setDueDate();
        break;
      case "t":
        commands.setThresholdDate();
        break;
      case "r":
        commands.setRecurrence();
        break;
      case "c":
        commands.copySelected();
        break;
      case "h":
        commands.toggleSelectedHidden();
        break;
      case "H":
        commands.toggleHiddenView({ notify: true });
        break;
      case "+":
        commands.addProject();
        break;
      case "@":
        commands.addContext();
        break;
      default:
        if (isPriorityInput(input)) {
          commands.setPriority(input);
        }
        break;
    }
  }, { autoFocus: true, tag: "todo-list" });

  useMouseInput((event) => {
    if (activeModal) return;
    if (event.wheelUp) {
      if (!isFocused) return;
      return scrollViewportUp();
    }
    if (event.wheelDown) {
      if (!isFocused) return;
      return scrollViewportDown();
    }
    if (!event.leftClick || event.y === undefined) return;
    const now = Date.now();
    const previousClick = lastClickRef.current;

    const searchRows = (isSearchFocused || searchQuery.length > 0) ? 2 : 0;
    const rowInList = event.y - 1 - searchRows;
    if (rowInList < 0 || rowInList >= visibleIndexes.length) {
      lastClickRef.current = { x: event.x, y: event.y, time: now };
      return;
    }

    const entry = visibleIndexes[rowInList];
    if (!entry || entry.type !== IndexType.todo) {
      lastClickRef.current = { x: event.x, y: event.y, time: now };
      return;
    }

    const isDoubleClick = (
      previousClick?.id === entry.todo.id ||
      (previousClick?.x === event.x && previousClick?.y === event.y)
    ) &&
      now - previousClick.time <= 350;

    focus();
    setSelectedTodoId(entry.todo.id, event.raw.shift);
    if (isDoubleClick && !event.raw.shift) {
      const checkboxStartColumn = 1 + (maxDigits + 2);
      const checkboxEndColumn = checkboxStartColumn + 2;
      const clickX = event.x ?? -1;
      const clickedCheckbox = clickX >= checkboxStartColumn &&
        clickX <= checkboxEndColumn;

      if (clickedCheckbox) {
        commands.toggle([entry.todo]);
      } else {
        openModal("edit-todo", entry.todo);
      }
    }

    lastClickRef.current = {
      id: entry.todo.id,
      x: event.x,
      y: event.y,
      time: now,
    };
  }, { isActive: true });

  // Calculate the maximum number of digits needed for numbering
  const totalTodoCount =
    indexes.filter((e) => e.type === IndexType.todo).length;
  const maxDigits = totalTodoCount.toString().length;

  return (
    <Box
      flexGrow={0}
      height={listHeight}
      backgroundColor={COLORS.background}
    >
      <Box flexDirection="column" flexGrow={1}>
        {visibleIndexes.length === 0
          ? (searchQuery.trim()
            ? <SearchEmptyState query={searchQuery.trim()} />
            : <WelcomeScreen />)
          : visibleIndexes.map((entry, index) => {
            const originalIndex = index + offsetRow;
            if (entry.type === IndexType.context) {
              return (
                <ContextTitle
                  key={`context-${entry.contextName}-${originalIndex}`}
                  title={entry.contextName}
                  count={entry.todoCount}
                />
              );
            }

            const isFocused = entry.todo === todo;
            const isSelectedInRange = selectedTodoIds.has(entry.todo.id);

            return (
              <TodoItem
                key={String(entry.todo.id)}
                todo={entry.todo}
                isFocused={isFocused}
                isSelectedInRange={isSelectedInRange}
                number={entry.number}
                maxDigits={maxDigits}
              />
            );
          })}
      </Box>
      <TodoListScrollbar
        totalRows={indexes.length}
        listHeight={listHeight}
        offsetRow={offsetRow}
      />
    </Box>
  );
};
