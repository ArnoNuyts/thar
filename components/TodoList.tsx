import { Box, Text, useApp, useStdout } from "ink";
import React, { memo, useEffect, useMemo, useState } from "react";
import { useFocusedInput } from "../hooks/useFocusedInput.ts";
import { Todo } from "../logic/todo.ts";
import { Todos } from "../logic/Todos.ts";
import { useTodo } from "../contexts/todo-context.tsx";
import { useModal } from "../contexts/modal-context.tsx";

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

enum IndexType {
  context,
  todo,
}

type ContextIndexEntry = {
  type: IndexType.context;
  todoCount: number;
  contextName: string;
};

type TodoIndexEntry = {
  type: IndexType.todo;
  todo: Todo;
};

type IndexEntry = ContextIndexEntry | TodoIndexEntry;

const createIndexes = (todos: Todos): IndexEntry[] => {
  const indexArray: IndexEntry[] = [];
  let prevTodo: Todo | null = null;
  let currHeader: ContextIndexEntry | null = null;
  let currHeaderTodoCounter = 0;

  for (const todo of todos) {
    if (!todo?.id) {
      continue;
    }

    const currentContext = todo?.contexts?.values().next().value;
    const prevContext = prevTodo?.contexts?.values().next().value;

    if (prevTodo === null || currentContext != prevContext) {
      if (currHeader) {
        currHeader.todoCount = currHeaderTodoCounter;
        currHeaderTodoCounter = 0;
      }

      currHeader = {
        type: IndexType.context,
        todoCount: 0,
        contextName: currentContext ?? "None",
      };
      indexArray.push(currHeader);
    }

    indexArray.push({ type: IndexType.todo, todo });
    currHeaderTodoCounter++;
    prevTodo = todo;
  }

  if (currHeader) {
    currHeader.todoCount = currHeaderTodoCounter;
  }

  return indexArray;
};

const renderTodoText = (text: string) => {
  const parts = text.split(/(@[^ ]+|\+[^ ]+)/g);
  return parts.map((part, i) => {
    if (part.startsWith("@")) {
      // @ts-ignore: key prop issue
      return <Text key={i} color="yellow">{part}</Text>;
    } else if (part.startsWith("+")) {
      // @ts-ignore: key prop issue
      return <Text key={i} color="blue">{part}</Text>;
    }
    // @ts-ignore: key prop issue
    return <Text key={i}>{part}</Text>;
  });
};

const TodoItem = ({ todo, isSelected }: { todo: Todo; isSelected: boolean; key?: React.Key }) => {
  const checkbox = todo.isDone() ? "[x]" : "[ ]";
  const priority = todo.priority ? `(${todo.priority})` : "";
  const dueDate = todo.tags.due ? `due:${todo.tags.due}` : "";
  const threshold = todo.tags.t ? `t:${todo.tags.t}` : "";
  const recurrence = todo.tags.rec ? `rec:${todo.tags.rec}` : "";

  return (
    <Box backgroundColor={isSelected ? "gray" : undefined}>
      <Text>{`${checkbox} `}</Text>
      {priority && <Text>{`${priority} `}</Text>}
      {renderTodoText(todo.text)}
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

export const TodoList = () => {
  const { todos, selectedTodoHash, setSelectedTodoHash, useSelectedTodo, toggleTodo, deleteTodo } = useTodo();
  const [offsetRow, setOffsetRow] = useState(0);
  const { openModal } = useModal();
  const { stdout } = useStdout();
  const listHeight = stdout.rows - 4;
  const todo = useSelectedTodo();

  const indexes: IndexEntry[] = useMemo(() => {
    const sortedTodos = todos.sortByImportance().filterHidden();
    return createIndexes(sortedTodos);
  }, [todos]);

  const selectedRow = useMemo(() => {
    if (selectedTodoHash === undefined) {
      // Select the first non-context item
      const firstTodoIndex = indexes.findIndex((entry) =>
        entry.type === IndexType.todo
      );
      return firstTodoIndex === -1 ? 0 : firstTodoIndex;
    }
    const index = indexes.findIndex((entry) =>
      entry.type === IndexType.todo && entry.todo.getHash() === selectedTodoHash
    );
    return index === -1 ? 0 : index;
  }, [indexes, selectedTodoHash]);

  useEffect(() => {
    if (selectedRow < offsetRow) {
      setOffsetRow(selectedRow);
    } else if (selectedRow >= offsetRow + listHeight) {
      setOffsetRow(selectedRow - listHeight + 1);
    }
  }, [selectedRow, listHeight]);

  // Initialize selectedTodoHash if undefined
  useEffect(() => {
    if (selectedTodoHash === undefined && indexes.length > 0) {
      const firstTodoIndex = indexes.findIndex((entry) =>
        entry.type === IndexType.todo
      );
      if (firstTodoIndex !== -1 && indexes[firstTodoIndex].type === IndexType.todo) {
        setSelectedTodoHash(indexes[firstTodoIndex].todo.getHash());
      }
    }
  }, [indexes, selectedTodoHash, setSelectedTodoHash]);

  const { exit } = useApp();
  useFocusedInput((input, key) => {
    if (input === "q") {
      exit();
    }

    if (input === "n") {
      openModal("create-todo");
      return;
    }

    if (input === "e") {
      if (todo) {
        openModal("edit-todo", todo);
      }
      return;
    }

    if (input === "x") {
      openModal("todo-menu");
      return;
    }

    if (input === "d") {
      openModal("set-due-date");
      return;
    }

    if (input === "t") {
      openModal("set-threshold-date");
      return;
    }

    if (input === "r") {
      openModal("set-recurrence");
      return;
    }

    if (key.delete) {
      if (todo) {
        deleteTodo(todo);
      }
      return;
    }

    let newSelectedRow = selectedRow;
    let direction = 0;

    if (key.upArrow) {
      newSelectedRow = Math.max(0, selectedRow - 1);
      direction = -1;
    }

    if (key.downArrow) {
      newSelectedRow = Math.min(indexes.length - 1, selectedRow + 1);
      direction = 1;
    }

    if (key.pageUp) {
      newSelectedRow = Math.max(0, selectedRow - 5);
      direction = -1;
    }

    if (key.pageDown) {
      newSelectedRow = Math.min(indexes.length - 1, selectedRow + 5);
      direction = 1;
    }

    while (indexes[newSelectedRow]?.type === IndexType.context) {
      newSelectedRow += direction;
      if (newSelectedRow < 0 || newSelectedRow >= indexes.length) {
        newSelectedRow = selectedRow;
        break;
      }
    }

    const selectedEntry = indexes[newSelectedRow];
    if (selectedEntry?.type === IndexType.todo) {
      setSelectedTodoHash(selectedEntry.todo.getHash());
    }

    setOffsetRow(
      clamp(
        clamp(
          offsetRow,
          newSelectedRow - (listHeight - 2),
          newSelectedRow - 1,
        ),
        0,
        indexes.length - listHeight,
      ),
    );

    if (input === " ") {
      if (todo) {
        toggleTodo(todo);
      }
    }
  }, { autoFocus: true });

  const visibleIndexes: IndexEntry[] = useMemo(
    () => indexes.slice(offsetRow, offsetRow + listHeight),
    [listHeight, offsetRow, indexes],
  );

  return (
    <Box flexDirection="column" flexGrow={1} height={listHeight}>
      {visibleIndexes.map((entry, index) => {
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
        return (
          <TodoItem
            key={originalIndex}
            todo={entry.todo}
            isSelected={originalIndex === selectedRow}
          />
        );
      })}
    </Box>
  );
};
