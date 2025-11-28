import { Box, render, Text, useApp, useStdout } from "ink";
import React, { memo, useEffect, useMemo, useState } from "react";
import { ActionBar } from "./components/ActionBar.tsx";
import { CreateTodoModal } from "./components/CreateTodoModal.tsx";
import { EditTodoModal } from "./components/EditTodoModal.tsx";
import { SetDueDateModal } from "./components/SetDueDateModal.tsx";
import { MenuAction, TodoMenu } from "./components/TodoMenu.tsx";
import { FocusProvider } from "./contexts/focus-context.tsx";
import { ModalProvider, useModal } from "./contexts/modal-context.tsx";
import { TodoProvider, useTodo } from "./contexts/todo-context.tsx";
import { useFocusedInput } from "./hooks/useFocusedInput.ts";
import { Todo } from "./logic/todo.ts";
import { Todos } from "./logic/Todos.ts";

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
      return <Text key={i} color="green">{part}</Text>;
    } else if (part.startsWith("+")) {
      // @ts-ignore: key prop issue
      return <Text key={i} color="blue">{part}</Text>;
    }
    // @ts-ignore: key prop issue
    return <Text key={i}>{part}</Text>;
  });
};

const TodoItem: React.FC<{ todo: Todo; isSelected: boolean }> = (
  { todo, isSelected },
) => {
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

const ContextTitle: React.FC<{ title: string; count: number }> = memo(
  ({ title, count }) => {
    return (
      <Box>
        <Text backgroundColor="yellow" color="black">
          {` ${title} (${count}) `}
        </Text>
      </Box>
    );
  },
);

const AppContent = () => {
  const { todos, setTodos } = useTodo();
  const [selectedTodoHash, setSelectedTodoHash] = useState<string | undefined>(
    undefined,
  );
  const [offsetRow, setOffsetRow] = useState(0);
  const { openModal, activeModal } = useModal();
  const { stdout } = useStdout();
  const listHeight = stdout.rows - 4;

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
      const selectedEntry = indexes[selectedRow];
      if (selectedEntry?.type === IndexType.todo) {
        openModal("edit-todo", selectedEntry.todo);
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
      const selectedEntry = indexes[selectedRow];
      if (selectedEntry?.type === IndexType.todo) {
        const newTodo = selectedEntry.todo.toggleState();
        // Force re-render by creating a new Todos object
        setTodos(new Todos(...todos));
        if (newTodo) {
          // If a new todo was created (recurrence), add it to the list
          setTodos(new Todos(...todos, newTodo));
        }
        setSelectedTodoHash(selectedEntry.todo.getHash());
      }
    }
  }, { autoFocus: true });

  const visibleIndexes: IndexEntry[] = useMemo(
    () => indexes.slice(offsetRow, offsetRow + listHeight),
    [listHeight, offsetRow, indexes],
  );

  const handleSave = (text: string) => {
    const newTodo = new Todo(text);
    newTodo.creationDate = new Date();
    setTodos(new Todos(...todos, newTodo));
  };

  const handleSaveEdit = (text: string) => {
    const selectedEntry = indexes[selectedRow];
    if (selectedEntry?.type === IndexType.todo) {
      selectedEntry.todo.setText(text);
      setTodos(new Todos(...todos));
      setSelectedTodoHash(selectedEntry.todo.getHash());
    }
  };

  const handleSaveDueDate = (date: Date) => {
    const selectedEntry = indexes[selectedRow];
    if (selectedEntry?.type === IndexType.todo) {
      selectedEntry.todo.setDue(date);
      setTodos(new Todos(...todos));
      setSelectedTodoHash(selectedEntry.todo.getHash());
    }
  };

  const handleMenuAction = (action: MenuAction) => {
    const selectedEntry = indexes[selectedRow];
    if (!selectedEntry || selectedEntry.type !== IndexType.todo) return;
    const todo = selectedEntry.todo;

    switch (action) {
      case "edit": {
        const selectedEntry = indexes[selectedRow];
        if (selectedEntry?.type === IndexType.todo) {
          openModal("edit-todo", selectedEntry.todo);
        }
        break;
      }
      case "delete": {
        const newTodos = todos.filter((t: Todo) => t !== todo);
        setTodos(new Todos(...newTodos));
        setSelectedTodoHash(undefined);
        break;
      }
      case "toggle": {
        const recurring = todo.toggleState();
        if (recurring) {
          setTodos(new Todos(...todos, recurring));
        } else {
          setTodos(new Todos(...todos));
        }
        setSelectedTodoHash(todo.getHash());
        break;
      }
      case "toggle-hidden":
        todo.toggleHidden();
        setTodos(new Todos(...todos));
        setSelectedTodoHash(todo.getHash());
        break;
      // Placeholder for other actions
      case "due":
        openModal("set-due-date");
        break;
      case "threshold":
      case "recurrence":
        break;
    }
  };

  return (
    <Box flexDirection="column" height="100%" width="100%" flexGrow={1}>
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
      <ActionBar />
      {activeModal === "create-todo" && <CreateTodoModal onSave={handleSave} />}
      {activeModal === "edit-todo" && <EditTodoModal onSave={handleSaveEdit} />}
      {activeModal === "todo-menu" && <TodoMenu onSelect={handleMenuAction} />}
      {activeModal === "set-due-date" && (
        <SetDueDateModal onSave={handleSaveDueDate} />
      )}
    </Box>
  );
};

const App = ({ filename }: { filename: string }) => {
  return (
    <TodoProvider filename={filename}>
      <ModalProvider>
        <FocusProvider>
          <AppContent />
        </FocusProvider>
      </ModalProvider>
    </TodoProvider>
  );
};

const filename = Deno.args[0] || "test.txt";
render(<App filename={filename} />);
