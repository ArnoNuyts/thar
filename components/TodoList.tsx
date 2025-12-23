import { Box, Newline, Text, useApp } from "ink";
import { memo, useMemo } from "react";
import { useFocusedInput } from "../hooks/useFocusedInput.ts";
import { Todo } from "../logic/todo.ts";
import { useModal } from "../contexts/modal-context.tsx";
import { copyToClipboard, readFromClipboard } from "../logic/clipboard.ts";
import { useToaster } from "../contexts/toaster-context.tsx";
import { useSearch } from "../contexts/search-context.tsx";
import { useNavigation } from "../contexts/navigation-context.tsx";
import { useTodo } from "../contexts/todo-context.tsx";
import { IndexType } from "../types/enums.ts";
import { UpperCaseLetter } from "../types/types.ts";
import { IndexEntry } from "../logic/indexes.ts";
import { ExtendedKey } from "../hooks/useFocusedInput.ts";
import { PRIMARY_COLOR, SECONDARY_COLOR } from "../constants.ts";

const renderTodoText = (
  text: string,
  isHighlighted: boolean,
  isOverdue: boolean,
) => {
  const parts = text.split(/(@[^ ]+|\+[^ ]+)/g);
  return parts.map((part, i) => {
    if (part.startsWith("@")) {
      return (
        <Text key={i} color={isHighlighted ? "black" : "yellow"}>{part}</Text>
      );
    } else if (part.startsWith("+")) {
      return (
        <Text key={i} color={isHighlighted ? "black" : "blue"}>{part}</Text>
      );
    }
    return (
      <Text
        key={i}
        color={isHighlighted ? "black" : (isOverdue ? "red" : undefined)}
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
    ? (isOverdue ? "red" : "white")
    : (isSelectedInRange ? "magenta" : undefined);

  return (
    <Box
      backgroundColor={backgroundColor}
    >
      <Text
        dimColor
        color={isHighlighted ? "black" : (isOverdue ? "red" : undefined)}
      >
        {`${paddedNumber} `}
      </Text>
      <Text color={isHighlighted ? "black" : (isOverdue ? "red" : undefined)}>
        {`${checkbox} `}
      </Text>
      {priority && (
        <Text
          color={isHighlighted
            ? "black"
            : todo.priority === "A"
            ? "cyan"
            : todo.priority === "B"
            ? "magenta"
            : todo.priority === "C"
            ? "yellow"
            : todo.priority === "D"
            ? "blue"
            : todo.priority === "E"
            ? "green"
            : todo.priority === "F"
            ? "red"
            : undefined}
        >
          {`${priority} `}
        </Text>
      )}
      {renderTodoText(todo.text, isHighlighted, isOverdue)}
      {dueDate && (
        <Text color={isHighlighted ? "black" : "red"}>{` ${dueDate}`}</Text>
      )}
      {threshold && (
        <Text color={isHighlighted ? "black" : "green"}>{` ${threshold}`}</Text>
      )}
      {recurrence && (
        <Text color={isHighlighted ? "black" : "cyan"}>{` ${recurrence}`}</Text>
      )}
    </Box>
  );
};

const ContextTitle = memo(
  ({ title, count }: { title: string; count: number; key?: React.Key }) => {
    return (
      <Box>
        <Text backgroundColor={PRIMARY_COLOR} color="black">
          {` ${title} (${count}) `}
        </Text>
      </Box>
    );
  },
);

export const TodoList = () => {
  const { exit } = useApp();
  const {
    indexes,
    offsetRow,
    listHeight,
    navigateUp,
    navigateDown,
    navigatePageUp,
    navigatePageDown,
    navigateHome,
    navigateEnd,
    setSelectedTodoId,
    useSelectedTodo,
    toggleShowHidden,
    showHidden,
    selectedTodoIds,
    clearMultiSelect,
  } = useNavigation();

  const { openModal } = useModal();
  const { showToaster } = useToaster();
  const { focusRef } = useSearch();
  const {
    toggleTodo,
    toggleHidden,
    deleteTodo,
    deleteTodos,
    archiveCompletedTodos,
    updateTodo,
    addTodos,
    undo,
    redo,
    todos,
  } = useTodo();

  const todo = useSelectedTodo();

  // Handle global shortcuts (only when focused)
  useFocusedInput((input, key: ExtendedKey) => {
    if (key.upArrow) return navigateUp(key.shift);
    if (key.downArrow) return navigateDown(key.shift);
    if (key.pageUp) return navigatePageUp(key.shift);
    if (key.pageDown) return navigatePageDown(key.shift);
    if (key.home) return navigateHome();
    if (key.end) return navigateEnd();
    if (key.return) return openModal("todo-menu");
    if (key.escape) return clearMultiSelect();
    if (key.delete) {
      if (selectedTodoIds.size > 0) {
        const todosToDelete = todos.filter((t) => selectedTodoIds.has(t.id));
        openModal("confirm-modal", {
          title: "Delete Todos",
          message:
            `Are you sure you want to delete ${todosToDelete.length} todos?`,
          onConfirm: () => deleteTodos(todosToDelete),
        });
      } else if (todo) {
        openModal("confirm-modal", {
          title: "Delete Todo",
          message: "Are you sure you want to delete this todo?",
          onConfirm: () => deleteTodo(todo),
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
        if (todo) toggleTodo(todo);
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
        if (todo) {
          copyToClipboard(todo.toString());
          showToaster("Todo copied");
        }
        break;
      case "h":
        if (todo) toggleHidden(todo);
        break;
      case "H":
        toggleShowHidden();
        showToaster(showHidden ? "Hidden todos hidden" : "Hidden todos shown");
        break;
      default:
        if (["A", "B", "C", "D", "E", "F"].includes(input)) {
          if (todo) {
            const newPriority = input.toUpperCase() as UpperCaseLetter;
            const updatedTodo = todo.priority === newPriority
              ? todo.setPriority(undefined)
              : todo.setPriority(newPriority);
            updateTodo(todo, updatedTodo);
          }
        }
        break;
    }
  }, { autoFocus: true });

  // Derived state for rendering
  const visibleIndexes: IndexEntry[] = useMemo(
    () => indexes.slice(offsetRow, offsetRow + listHeight),
    [listHeight, offsetRow, indexes],
  );

  // Calculate the maximum number of digits needed for numbering
  const totalTodoCount =
    indexes.filter((e) => e.type === IndexType.todo).length;
  const maxDigits = totalTodoCount.toString().length;

  return (
    <Box flexDirection="column" flexGrow={1} height={listHeight}>
      {visibleIndexes.length === 0
        ? (
          <Box
            width="100%"
            height="100%"
            justifyContent="center"
            alignItems="center"
            flexDirection="column"
          >
            <Text>
              I love deadlines. I love the whooshing noise they make as they go
              by.
            </Text>
            <Text color="gray">
              - Douglas Adams
            </Text>
            <Newline />
            <Text color="gray" dimColor>
              Press &apos;n&apos; to create a new todo.
            </Text>
          </Box>
        )
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
              key={originalIndex}
              todo={entry.todo}
              isFocused={isFocused}
              isSelectedInRange={isSelectedInRange}
              number={todoNumber}
              maxDigits={maxDigits}
            />
          );
        })}
    </Box>
  );
};
