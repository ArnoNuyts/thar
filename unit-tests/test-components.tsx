import React, { useEffect, useMemo } from "react";
import { FocusProvider, useFocusManager } from "../contexts/focus-context.tsx";
import { TodoContext, TodoContextType } from "../contexts/todo-context.tsx";
import {
  NavigationContext,
  NavigationContextType,
  useNavigation,
} from "../contexts/navigation-context.tsx";
import { ModalProvider } from "../contexts/modal-context.tsx";
import { SuggestionProvider } from "../contexts/suggestion-context.tsx";

export const FocusObserver = (
  { onFocused }: { onFocused: (tag?: string) => void },
) => {
  const { activeId } = useFocusManager();
  useEffect(() => {
    if (activeId) {
      onFocused(activeId.description);
    }
  }, [activeId, onFocused]);
  return null;
};

export const SelectionObserver = ({
  onSelectionIdChange,
}: {
  onSelectionIdChange?: (id: symbol | undefined) => void;
}) => {
  const { selectedTodoId } = useNavigation();

  useEffect(() => {
    if (onSelectionIdChange) {
      onSelectionIdChange(selectedTodoId);
    }
  }, [selectedTodoId, onSelectionIdChange]);

  return null;
};

export const SelectionStateObserver = ({
  onSelectionChange,
}: {
  onSelectionChange: (
    state: {
      cursorId: symbol | undefined;
      anchorId: symbol | undefined;
      rangeIds: Set<symbol>;
    },
  ) => void;
}) => {
  const { selectedTodoId, selectedTodoIds } = useNavigation();

  useEffect(() => {
    onSelectionChange({
      cursorId: selectedTodoId,
      anchorId: undefined,
      rangeIds: selectedTodoIds,
    });
  }, [selectedTodoId, selectedTodoIds, onSelectionChange]);

  return null;
};

export const NavController = ({
  onNav,
}: {
  onNav: (nav: NavigationContextType) => void;
}) => {
  const nav = useNavigation();
  useEffect(() => {
    onNav(nav);
  }, [nav, onNav]);
  return null;
};

import { ToasterProvider } from "../contexts/toaster-context.tsx";

// Stable fallbacks so omitting the overrides never creates a fresh object on
// every render of TestWrapper.
const EMPTY_TODO_VALUE: Partial<TodoContextType> = {};
const EMPTY_NAV_VALUE: Partial<NavigationContextType> = {};

export const TestWrapper = ({
  children,
  todoValue = EMPTY_TODO_VALUE,
  navValue = EMPTY_NAV_VALUE,
}: {
  children: React.ReactNode;
  todoValue?: Partial<TodoContextType>;
  navValue?: Partial<NavigationContextType>;
}) => {
  const fullTodoValue = useMemo(
    () =>
      ({
        todos: [],
        setTodos: () => {},
        addTodos: () => [],
        updateTodos: () => {},
        deleteTodos: () => {},
        toggleTodos: () => {},
        toggleHidden: () => {},
        archiveCompletedTodos: async () => {},
        undo: () => {},
        canUndo: false,
        redo: () => {},
        canRedo: false,
        ...todoValue,
      }) as TodoContextType,
    [todoValue],
  );

  const fullNavValue = useMemo(
    () =>
      ({
        indexes: [],
        offsetRow: 0,
        listHeight: 10,
        navigateUp: () => {},
        navigateDown: () => {},
        navigatePageUp: () => {},
        navigatePageDown: () => {},
        navigateHome: () => {},
        navigateEnd: () => {},
        selectedTodoId: undefined,
        setSelectedTodoId: () => {},
        selectedTodoIds: new Set<symbol>(),
        clearMultiSelect: () => {},
        getSelectedTodo: () => undefined,
        getSelectedTodos: () => [],
        showHidden: false,
        toggleShowHidden: () => {},
        ...navValue,
      }) as NavigationContextType,
    [navValue],
  );

  return (
    <ToasterProvider>
      <TodoContext.Provider value={fullTodoValue}>
        <NavigationContext.Provider value={fullNavValue}>
          <FocusProvider>
            <SuggestionProvider>
              <ModalProvider>
                {children}
              </ModalProvider>
            </SuggestionProvider>
          </FocusProvider>
        </NavigationContext.Provider>
      </TodoContext.Provider>
    </ToasterProvider>
  );
};
