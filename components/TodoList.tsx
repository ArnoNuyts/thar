import { Box, Newline, Text, useApp } from "ink";
import { memo, useMemo, useRef } from "react";
import { PRIMARY_COLOR } from "../constants.ts";
import { useModal } from "../contexts/modal-context.tsx";
import { useNavigation } from "../contexts/navigation-context.tsx";
import { useSearch } from "../contexts/search-context.tsx";
import { useToaster } from "../contexts/toaster-context.tsx";
import { useTodo } from "../contexts/todo-context.tsx";
import { ExtendedKey, useFocusedInput } from "../hooks/useFocusedInput.ts";
import { useMouseInput } from "../hooks/useMouseInput.ts";
import { copyToClipboard, readFromClipboard } from "../logic/clipboard.ts";
import { IndexEntry } from "../logic/indexes.ts";
import { Todo } from "../logic/todo.ts";
import { IndexType } from "../types/enums.ts";
import { UpperCaseLetter } from "../types/types.ts";
import { TodoListScrollbar } from "./TodoListScrollbar.tsx";
import { COLORS } from "../theme/colors.ts";

const renderTodoText = (
  text: string,
  isHighlighted: boolean,
  isOverdue: boolean,
) => {
  const parts = text.split(/(@[^ ]+|\+[^ ]+)/g);
  return parts.map((part, i) => {
    if (part.startsWith("@")) {
      return (
        <Text
          key={i}
          color={isHighlighted ? COLORS.textOnHighlight : COLORS.tagContext}
        >
          {part}
        </Text>
      );
    } else if (part.startsWith("+")) {
      return (
        <Text
          key={i}
          color={isHighlighted ? COLORS.textOnHighlight : COLORS.tagProject}
        >
          {part}
        </Text>
      );
    }
    return (
      <Text
        key={i}
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
        <Text backgroundColor={PRIMARY_COLOR} color={COLORS.inverseForeground}>
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
    useSelectedTodo,
    useSelectedTodos,
    toggleShowHidden,
    showHidden,
    selectedTodoIds,
    clearMultiSelect,
  } = useNavigation();

  const { openModal, activeModal } = useModal();
  const { showToaster } = useToaster();
  const { focusRef, searchQuery, isSearchFocused } = useSearch();
  const {
    toggleTodos,
    toggleHidden,
    deleteTodos,
    archiveCompletedTodos,
    updateTodos,
    addTodos,
    undo,
    redo,
  } = useTodo();

  const todo = useSelectedTodo();
  const selectedTodos = useSelectedTodos();
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
      if (selectedTodos.length > 0) {
        const isMultiple = selectedTodos.length > 1;
        openModal("confirm-modal", {
          title: isMultiple ? "Delete Todos" : "Delete Todo",
          message: isMultiple
            ? `Are you sure you want to delete ${selectedTodos.length} todos?`
            : "Are you sure you want to delete this todo?",
          onConfirm: () => deleteTodos(selectedTodos),
        });
      }
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
        if (selectedTodos.length > 0) {
          toggleTodos(selectedTodos);
        }
        break;
      case "x":
        openModal("todo-menu");
        break;
      case "n":
        openModal("create-todo");
        break;
      case "z":
        undo();
        break;
      case "Z":
        redo();
        break;
      case "v": {
        const paste = async () => {
          try {
            const text = await readFromClipboard();
            const lines = text
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter((line) => line.length > 0);
            if (lines.length === 0) return;

            const doPaste = () => {
              const added = addTodos(...lines);
              if (added.length > 0) {
                setSelectedTodoId(added[added.length - 1].id);
              }
              showToaster(`Pasted ${lines.length} todo(s)`);
            };

            if (lines.length > 10) {
              openModal("confirm-modal", {
                title: "Paste Multiple Todos",
                message:
                  `Are you sure you want to paste ${lines.length} todos?`,
                onConfirm: doPaste,
              });
            } else {
              doPaste();
            }
          } catch (e) {
            showToaster(
              `Paste failed: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        };
        paste();
        break;
      }
      case "e":
        if (todo) openModal("edit-todo", todo);
        break;
      case "a":
        openModal("confirm-modal", {
          title: "Archive Completed",
          message: "Archive all completed todos to done.txt?",
          onConfirm: () => {
            archiveCompletedTodos();
          },
        });
        break;
      case "d":
        openModal("set-due-date");
        break;
      case "t":
        openModal("set-threshold-date");
        break;
      case "r":
        openModal("set-recurrence");
        break;
      case "c":
        if (selectedTodos.length > 0) {
          copyToClipboard(selectedTodos.map((t) => t.toString()).join("\n"));
          showToaster(
            selectedTodos.length === 1
              ? "Todo copied"
              : `${selectedTodos.length} todos copied`,
          );
        }
        break;
      case "h":
        if (selectedTodos.length > 0) toggleHidden(selectedTodos);
        break;
      case "H":
        toggleShowHidden();
        showToaster(showHidden ? "Hidden todos hidden" : "Hidden todos shown");
        break;
      case "+":
        openModal("add-project");
        break;
      case "@":
        openModal("add-context");
        break;
      default:
        if (["A", "B", "C", "D", "E", "F"].includes(input)) {
          const newPriority = input.toUpperCase() as UpperCaseLetter;
          if (selectedTodos.length > 0) {
            // Toggle off if all items have the same priority
            const allHaveSamePriority = selectedTodos.every((t) =>
              t.priority === newPriority
            );
            updateTodos(
              selectedTodos,
              (t) =>
                t.setPriority(allHaveSamePriority ? undefined : newPriority),
            );
          }
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
        toggleTodos([entry.todo]);
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
                  key={originalIndex}
                  title={entry.contextName}
                  count={entry.todoCount}
                />
              );
            }
            // Calculate the todo number by counting all todo entries before this one
            const todoNumber = indexes.slice(0, originalIndex + 1).filter(
              (e) => e.type === IndexType.todo,
            ).length;

            const isFocused = entry.todo === todo;
            const isSelectedInRange = selectedTodoIds.has(entry.todo.id);

            return (
              <TodoItem
                key={index + entry.todo.getHash()}
                todo={entry.todo}
                isFocused={isFocused}
                isSelectedInRange={isSelectedInRange}
                number={todoNumber}
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
