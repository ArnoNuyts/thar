import { Box, render, Text, useApp, useStdout } from 'ink';
import React, { Fragment, memo, useEffect, useMemo, useRef, useState } from 'react';
import { CreateTodoModal } from './components/CreateTodoModal.tsx';
import { EditTodoModal } from './components/EditTodoModal.tsx';
import { SetDueDateModal } from './components/SetDueDateModal.tsx';
import { MenuAction, TodoMenu } from './components/TodoMenu.tsx';
import { FocusProvider } from './components/focus-context.tsx';
import { useFocusedInput } from './hooks/useFocusedInput.ts';
import { readTodosFromFile } from './logic/todo-file-helpers.ts';
import { Todo } from './logic/todo.ts';
import { Todos } from './logic/Todos.ts';

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

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
    const parts = text.split(/(@[\w-]+|\+[\w-]+)/g);
    return parts.map((part, i) => {
      if (part.startsWith('@')) {
        // @ts-ignore: key prop issue
        return <Text key={i} color="green">{part}</Text>;
      } else if (part.startsWith('+')) {
        // @ts-ignore: key prop issue
        return <Text key={i} color="blue">{part}</Text>;
      }
      // @ts-ignore: key prop issue
      return <Text key={i}>{part}</Text>;
    });
};

const TodoItem = ({ todo, isSelected }: { todo: Todo, isSelected: boolean }) => {
  const checkbox = todo.isDone() ? '[x]' : '[ ]';
  const priority = todo.priority ? `(${todo.priority})` : '';
  const completionDate = todo.completionDate ? todo.completionDate.toISOString().slice(0, 10) : '';
  const creationDate = todo.creationDate ? todo.creationDate.toISOString().slice(0, 10) : '';
  const dueDate = todo.tags.due ? `due:${todo.tags.due}` : '';
  const threshold = todo.tags.t ? `t:${todo.tags.t}` : '';
  const recurrence = todo.tags.rec ? `rec:${todo.tags.rec}` : '';

  return (
    <Box backgroundColor={isSelected ? "gray" : undefined}>
      <Text>{checkbox} </Text>
      <Text>{priority} </Text>
      <Text>{completionDate} </Text>
      <Text>{creationDate} </Text>
      {renderTodoText(todo.text)}
      {dueDate && <Text color="red"> {dueDate}</Text>}
      {threshold && <Text color="yellow"> {threshold}</Text>}
      {recurrence && <Text color="cyan"> {recurrence}</Text>}
    </Box>
  );
};

const ContextTitle = memo(({ title, count }: { title: string, count: number }) => {
    return (
        <Box>
            <Text backgroundColor="yellow" color="black">{` ${title} (${count}) `}</Text>
        </Box>
    );
});

const ActionBar = () => {
    return (
        <Box borderStyle="single" borderTop borderLeft={false} borderRight={false} borderBottom={false}>
            {[{key: "x", text: "Menu"}, {key: "q", text: "Quit"}, {key: "n", text: "New"}, {key: "e", text: "Edit"}, {key: "a", text: "Archive"}].map((item) => {
                return <Fragment key={item.key}>
                    <Text color="yellow">  {item.key} </Text>
                    <Text>{item.text} </Text>
                </Fragment>;
            })}
        </Box>
    );
}

const AppContent = ({ filename }: { filename: string }) => {
  const [todos, setTodos] = useState<Todos>(new Todos());
  const [selectedTodoId, setSelectedTodoId] = useState<symbol | undefined>(undefined);
  const [offsetRow, setOffsetRow] = useState(0);
  const [showModal, setShowModal] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [showDueDateModal, setShowDueDateModal] = useState(false);
  const [editingTodo, setEditingTodo] = useState<Todo | null>(null);
  const { stdout } = useStdout();
  const listHeight = stdout.rows - 4;

  const lastClick = useRef<{ time: number; x: number; y: number } | null>(null);

  useEffect(() => {
    readTodosFromFile(filename).then(initialTodos => {
      setTodos(new Todos(...initialTodos));
    });
  }, [filename]);

     const indexes: IndexEntry[] = useMemo(() => {
     const sortedTodos = todos.sortByImportance().filterHidden();
        return createIndexes(sortedTodos);
      }, [todos]);

  const selectedRow = useMemo(() => {
    if (selectedTodoId === undefined) {
      // Select the first non-context item
      const firstTodoIndex = indexes.findIndex(entry => entry.type === IndexType.todo);
      return firstTodoIndex === -1 ? 0 : firstTodoIndex;
    }
    const index = indexes.findIndex(entry => entry.type === IndexType.todo && entry.todo.id === selectedTodoId);
    return index === -1 ? 0 : index;
  }, [indexes, selectedTodoId]);

  const {exit} = useApp();
  useFocusedInput((input, key) => {
    if (input === 'q') {
        exit();
    }

    if (input === 'n') {
        setShowModal(true);
        return;
    }

    if (input === 'e') {
        const selectedEntry = indexes[selectedRow];
        if (selectedEntry?.type === IndexType.todo) {
            setEditingTodo(selectedEntry.todo);
        }
        return;
    }

    if (input === 'x') {
        setShowMenu(true);
        return;
    }

    if (input === 'd') {
        setShowDueDateModal(true);
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
        setSelectedTodoId(selectedEntry.todo.id);
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
        )
    );

    if (input === ' ') {
        const selectedEntry = indexes[selectedRow];
        if (selectedEntry?.type === IndexType.todo) {
            const newTodo = selectedEntry.todo.toggleState();
            // Force re-render by creating a new Todos object
            setTodos(new Todos(...todos));
            if (newTodo) {
                // If a new todo was created (recurrence), add it to the list
                setTodos(new Todos(...todos, newTodo));
            }
        }
    }
  }, { autoFocus: true });

  const visibleIndexes: IndexEntry[] = useMemo(() => indexes.slice(offsetRow, offsetRow + listHeight), [listHeight, offsetRow, indexes]);

  const handleSave = (text: string) => {
      const newTodo = new Todo(text);
      newTodo.creationDate = new Date();
      setTodos(new Todos(...todos, newTodo));
      setShowModal(false);
  };

  const handleSaveEdit = (text: string) => {
      if (editingTodo) {
          editingTodo.setText(text);
          // Force re-render
          setTodos(new Todos(...todos));
          setEditingTodo(null);
      }
  };

  const handleSaveDueDate = (date: Date) => {
      const selectedEntry = indexes[selectedRow];
      if (selectedEntry?.type === IndexType.todo) {
          selectedEntry.todo.setDue(date);
          setTodos(new Todos(...todos));
      }
      setShowDueDateModal(false);
  };

  const handleMenuAction = (action: MenuAction) => {
      setShowMenu(false);
      const selectedEntry = indexes[selectedRow];
      if (!selectedEntry || selectedEntry.type !== IndexType.todo) return;
      const todo = selectedEntry.todo;

      switch (action) {
          case 'edit':
              setEditingTodo(todo);
              break;
          case 'delete': {
              const newTodos = todos.filter((t: Todo) => t !== todo);
              setTodos(new Todos(...newTodos));
              setSelectedTodoId(undefined);
              break;
          }
          case 'toggle': {
              const recurring = todo.toggleState();
              if (recurring) {
                  setTodos(new Todos(...todos, recurring));
              } else {
                  setTodos(new Todos(...todos));
              }
              break;
          }
          case 'toggle-hidden':
              todo.toggleHidden();
              setTodos(new Todos(...todos));
              break;
          // Placeholder for other actions
          case 'due':
              setShowDueDateModal(true);
              break;
          case 'threshold':
          case 'recurrence':
              break;
      }
  };

  return (
    <Box flexDirection="column" height="100%" width="100%" flexGrow={1}>
      <Box flexDirection="column" flexGrow={1} height={listHeight}>
        {visibleIndexes.map((entry, index) => {
            const originalIndex = index + offsetRow;
            if (entry.type === IndexType.context) {
                // @ts-ignore: key prop issue
                return <ContextTitle key={originalIndex} title={entry.contextName} count={entry.todoCount} />
            }
            // @ts-ignore: key prop issue
            return <TodoItem key={originalIndex} todo={entry.todo} isSelected={originalIndex === selectedRow} />
        })}
      </Box>
      <ActionBar />
      {showModal && (
        <Box position="absolute" width="100%" height="100%" alignItems="center" justifyContent="center">
            <CreateTodoModal onSave={handleSave} onCancel={() => setShowModal(false)} />
        </Box>
      )}
      {editingTodo && (
        <Box position="absolute" width="100%" height="100%" alignItems="center" justifyContent="center">
            <EditTodoModal 
                initialValue={editingTodo.text} 
                onSave={handleSaveEdit} 
                onCancel={() => setEditingTodo(null)} 
            />
        </Box>
      )}
      {showMenu && (
        <Box position="absolute" width="100%" height="100%" alignItems="center" justifyContent="center">
            <TodoMenu onSelect={handleMenuAction} onCancel={() => setShowMenu(false)} />
        </Box>
      )}
      {showDueDateModal && (
        <Box position="absolute" width="100%" height="100%" alignItems="center" justifyContent="center">
            <SetDueDateModal onSave={handleSaveDueDate} onCancel={() => setShowDueDateModal(false)} />
        </Box>
      )}
    </Box>
  );
};

const App = ({ filename }: { filename: string }) => {
    return (
        // @ts-ignore: children prop issue
        <FocusProvider>
            <AppContent filename={filename} />
        </FocusProvider>
    );
};

const filename = Deno.args[0] || 'test.txt';
render(<App filename={filename} />);