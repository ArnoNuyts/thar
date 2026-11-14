import { createContext, ReactNode, useContext, useEffect } from "react";
import { Todo } from "../logic/todo.ts";
import type { Todos } from "../logic/Todos.ts";
import type { IndexEntry } from "../logic/indexes.ts";
import { useNavigationState } from "../hooks/useNavigationState.ts";

// Imperative escape hatch for components that need the current selection
// without subscribing to navigation re-renders.
export const navigationSelectedTodoRef: { current: Todo | undefined } = {
  current: undefined,
};

export interface NavigationContextType {
  indexes: IndexEntry[];
  offsetRow: number;
  listHeight: number;
  scrollViewportUp: () => void;
  scrollViewportDown: () => void;
  navigateUp: (shift?: boolean) => void;
  navigateDown: (shift?: boolean) => void;
  navigateContextUp: (shift?: boolean) => void;
  navigateContextDown: (shift?: boolean) => void;
  navigatePageUp: (shift?: boolean) => void;
  navigatePageDown: (shift?: boolean) => void;
  navigateHome: () => void;
  navigateEnd: () => void;
  selectedTodoId: symbol | undefined;
  setSelectedTodoId: (id: symbol | undefined, shift?: boolean) => void;
  selectedTodoIds: Set<symbol>;
  clearMultiSelect: () => void;
  getSelectedTodo: () => Todo | undefined;
  /** Returns a shared selection snapshot; callers must not mutate the array. */
  getSelectedTodos: () => Todo[];
  showHidden: boolean;
  toggleShowHidden: () => void;
}

export const NavigationContext = createContext<
  NavigationContextType | undefined
>(undefined);

export const NavigationProvider = ({
  children,
  todos,
  listHeightForTest,
}: {
  children: ReactNode;
  todos: Todos;
  listHeightForTest?: number;
}) => {
  const { value, selectedTodo } = useNavigationState(todos, listHeightForTest);

  // Keep the imperative ref in sync after commit; writing it during render
  // would be a side effect of rendering.
  useEffect(() => {
    navigationSelectedTodoRef.current = selectedTodo;
  }, [selectedTodo]);

  return (
    <NavigationContext.Provider value={value}>
      {children}
    </NavigationContext.Provider>
  );
};

export const useNavigation = () => {
  const context = useContext(NavigationContext);
  if (!context) {
    throw new Error("useNavigation must be used within a NavigationProvider");
  }
  return context;
};
