import { Box, Newline, Text, useApp } from "ink";
import { memo, useMemo } from "react";
import { useFocusedInput } from "../hooks/useFocusedInput.ts";
import { Todo } from "../logic/todo.ts";
import { useModal } from "../contexts/modal-context.tsx";
import { copyToClipboard } from "../logic/clipboard.ts";
import { useToaster } from "../contexts/toaster-context.tsx";
import { useSearch } from "../contexts/search-context.tsx";
import { useNavigation } from "../contexts/navigation-context.tsx";
import { IndexType } from "../types/enums.ts";
import { UpperCaseLetter } from "../types/types.ts";
import { IndexEntry } from "../logic/indexes.ts";

const renderTodoText = (
  text: string,
  isSelected: boolean,
  isOverdue: boolean,
) => {
  const parts = text.split(/(@[^ ]+|\+[^ ]+)/g);
  return parts.map((part, i) => {
    if (part.startsWith("@")) {
      return <Text key={i} color="yellow">{part}</Text>;
    } else if (part.startsWith("+")) {
      return <Text key={i} color="blue">{part}</Text>;
    }
    return (
      <Text
        key={i}
        color={isSelected ? "black" : (isOverdue ? "red" : undefined)}
      >
        {part}
      </Text>
    );
  });
};

const TodoItem = (
  { todo, isSelected, number, maxDigits }: {
    todo: Todo;
    isSelected: boolean;
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

  return (
    <Box
      backgroundColor={isSelected ? (isOverdue ? "red" : "white") : undefined}
    >
      <Text
        dimColor
        color={isSelected ? "black" : (isOverdue ? "red" : undefined)}
      >
        {`${paddedNumber} `}
      </Text>
      <Text color={isSelected ? "black" : (isOverdue ? "red" : undefined)}>
        {`${checkbox} `}
      </Text>
      {priority && (
        <Text
          color={isSelected
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
      {renderTodoText(todo.text, isSelected, isOverdue)}
      {dueDate && <Text color="red">{` ${dueDate}`}</Text>}
      {threshold && <Text color="yellow">{` ${threshold}`}</Text>}
      {recurrence && <Text color="cyan">{` ${recurrence}`}</Text>}
    </Box>
  );
};

const ContextTitle = memo(
  ({ title, count }: { title: string; count: number; key?: React.Key }) => {
    return (
      <Box>
        <Text backgroundColor="yellow" color="black">
          {` ${title} (${count}) `}
        </Text>
      </Box>
    );
  },
);

interface TodoListProps {
  toggleTodo: (todo: Todo) => void;
  deleteTodo: (todo: Todo) => void;
  archiveCompletedTodos: () => Promise<void>;
  updateTodo: (todo: Todo) => void;
}

export const TodoList = ({
  toggleTodo,
  deleteTodo,
  archiveCompletedTodos,
  updateTodo,
}: TodoListProps) => {
  const { exit } = useApp();
  const {
    indexes,
    offsetRow,
    listHeight,
    navigateUp,
    navigateDown,
    navigatePageUp,
    navigatePageDown,
    useSelectedTodo,
  } = useNavigation();

  const { openModal } = useModal();
  const { showToaster } = useToaster();
  const { focusRef } = useSearch();

  const todo = useSelectedTodo();

  // Handle global shortcuts (only when focused)
  useFocusedInput((input, key) => {
    if (input === "/") {
      focusRef.current?.();
      return;
    }

    if (input === "q") {
      exit();
      return;
    }

    if (key.upArrow) {
      navigateUp();
    } else if (key.downArrow) {
      navigateDown();
    } else if (key.pageUp) {
      navigatePageUp();
    } else if (key.pageDown) {
      navigatePageDown();
    } else if (input === " ") {
      if (todo) {
        toggleTodo(todo);
      }
    } else if (input === "x") {
      openModal("todo-menu");
    } else if (key.return) {
      openModal("todo-menu");
    } else if (input === "n") {
      openModal("create-todo");
    } else if (input === "e") {
      if (todo) openModal("edit-todo", todo);
    } else if (input === "a") {
      openModal("confirm-modal", {
        title: "Archive Completed",
        message: "Archive all completed todos to done.txt?",
        onConfirm: () => {
          archiveCompletedTodos();
        },
      });
    } else if (input === "d") {
      openModal("set-due-date");
    } else if (input === "t") {
      openModal("set-threshold-date");
    } else if (input === "r") {
      openModal("set-recurrence");
    } else if (key.delete) {
      if (todo) {
        openModal("confirm-modal", {
          title: "Delete Todo",
          message: "Are you sure you want to delete this todo?",
          onConfirm: () => deleteTodo(todo),
        });
      }
    } else if (input === "c") {
      if (todo) {
        copyToClipboard(todo.toString());
        showToaster("Todo copied");
      }
    } else if (["A", "B", "C", "D", "E", "F"].includes(input)) {
      if (todo) {
        const newPriority = input.toUpperCase() as UpperCaseLetter;
        if (todo.priority === newPriority) {
          todo.setPriority(undefined);
        } else {
          todo.setPriority(newPriority);
        }
        updateTodo(todo);
      }
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
          // Check if this specific todo is selected
          const isSelected = entry.todo === todo;

          return (
            <TodoItem
              key={originalIndex}
              todo={entry.todo}
              isSelected={isSelected}
              number={todoNumber}
              maxDigits={maxDigits}
            />
          );
        })}
    </Box>
  );
};
