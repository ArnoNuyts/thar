import React, { useState, useEffect, memo, useMemo, useRef, Fragment } from 'react';
import { render, Box, Text, useInput, useApp, useStdout } from 'ink';
import { readTodosFromFile } from './logic/todo-file-helpers.ts';
import { Todos } from './logic/Todos.ts';
import { type Todo } from './logic/todo.ts';
import { useMouse } from 'ink-mouse';

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
        return <Text key={i} color="green">{part}</Text>;
      } else if (part.startsWith('+')) {
        return <Text key={i} color="blue">{part}</Text>;
      }
      return <Text key={i}>{part}</Text>;
    });
};

const TodoItem = ({ todo, isSelected }: { todo: Todo, isSelected: boolean }) => {
  const checkbox = todo.isDone() ? '[x]' : '[ ]';
  const priority = todo.priority ? `(${todo.priority})` : '';
  const completionDate = todo.completionDate ? todo.completionDate.toISOString().slice(0, 10) : '';
  const creationDate = todo.creationDate ? todo.creationDate.toISOString().slice(0, 10) : '';

  return (
    <Box backgroundColor={isSelected ? "gray" : undefined}>
      <Text>{checkbox} </Text>
      <Text>{priority} </Text>
      <Text>{completionDate} </Text>
      <Text>{creationDate} </Text>
      {renderTodoText(todo.text)}
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

const App = ({ filename }: { filename: string }) => {
  const [todos, setTodos] = useState<Todos>(new Todos());
  const [selectedTodoId, setSelectedTodoId] = useState<symbol | undefined>(undefined);
  const [offsetRow, setOffsetRow] = useState(0);
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
  useInput((input, key) => {
    if (input === 'q') {
        exit();
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

    if (key.home) {
        newSelectedRow = 0;
        direction = 1;
    }

    if (key.end) {
        newSelectedRow = indexes.length - 1;
        direction = -1;
    }

    while (indexes[newSelectedRow]?.type === IndexType.context) {
        newSelectedRow += direction;
        if (newSelectedRow < 0 || newSelectedRow >= indexes.length) {
            newSelectedRow = selectedRow;
            break;
        }
    }

    if (indexes[newSelectedRow]?.type === IndexType.todo) {
        setSelectedTodoId(indexes[newSelectedRow]?.todo.id);
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
  });

  const visibleIndexes: IndexEntry[] = useMemo(() => indexes.slice(offsetRow, offsetRow + listHeight), [listHeight, offsetRow, indexes]);

  return (
    <Box flexDirection="column" height="100%" width="100%" flexGrow={1}>
      <Box flexDirection="column" flexGrow={1} height={listHeight}>
        {visibleIndexes.map((entry, index) => {
            const originalIndex = index + offsetRow;
            if (entry.type === IndexType.context) {
                return <ContextTitle key={originalIndex} title={entry.contextName} count={entry.todoCount} />
            }
            return <TodoItem key={originalIndex} todo={entry.todo} isSelected={originalIndex === selectedRow} />
        })}
      </Box>
      <ActionBar />
    </Box>
  );
};

const filename = Deno.args[0] || 'test.txt';
render(<App filename={filename} />);