import { expect, test } from "vitest";

import { Text } from "ink";
import { render } from "ink-testing-library";
import { useEffect } from "react";
import {
  NavigationProvider,
  useNavigation,
} from "../contexts/navigation-context.tsx";
import { SearchProvider } from "../contexts/search-context.tsx";
import { Todo } from "../logic/todo.ts";
import type { Todos } from "../logic/Todos.ts";
import { waitFor } from "./test-utils.ts";
import { IndexType } from "../types/enums.ts";

const TestWrapper = ({
  todos,
  onContext,
}: {
  todos: Todos;
  onContext: (ctx: any) => void;
}) => (
  <SearchProvider>
    <NavigationProvider todos={todos}>
      <NavigationTester onContext={onContext} />
    </NavigationProvider>
  </SearchProvider>
);

// Helper component to interact with NavigationContext
const NavigationTester = ({ onContext }: { onContext: (ctx: any) => void }) => {
  const nav = useNavigation();
  useEffect(() => {
    onContext(nav);
  });
  return <Text>Tester</Text>;
};

test("NavigationContext: should initialize with showHidden = false and filter hidden todos", async () => {
  const todoVisible = new Todo("visible todo");
  const todoHidden = new Todo("h:1 hidden todo");
  const todos = [todoVisible, todoHidden];
  let navContext: any;

  const { unmount } = render(
    <TestWrapper todos={todos} onContext={(ctx) => (navContext = ctx)} />,
  );

  await waitFor(() => {
    expect(navContext?.showHidden).toEqual(false);
    // Wait for indexes to populate
    if (!navContext?.indexes) throw new Error("Indexes not ready");
  });

  // Check visible todos
  const visibleTodos = navContext.indexes.filter(
    (i: any) => i.type === IndexType.todo,
  );
  expect(visibleTodos.length).toEqual(1);
  expect(visibleTodos[0].todo.text).toEqual("visible todo");

  unmount();
});

test("NavigationContext: should toggle showHidden and show all todos", async () => {
  const todoVisible = new Todo("visible todo");
  const todoHidden = new Todo("h:1 hidden todo");
  const todos = [todoVisible, todoHidden];
  let navContext: any;

  const { unmount } = render(
    <TestWrapper todos={todos} onContext={(ctx) => (navContext = ctx)} />,
  );

  await waitFor(() => {
    expect(navContext?.showHidden).toEqual(false);
  });

  navContext.toggleShowHidden();

  await waitFor(() => {
    expect(navContext.showHidden).toEqual(true);
    const allTodos = navContext.indexes.filter(
      (i: any) => i.type === IndexType.todo,
    );
    expect(allTodos.length).toEqual(2);
  });

  unmount();
});

test("NavigationContext: should toggle back to hidden", async () => {
  const todoVisible = new Todo("visible todo");
  const todoHidden = new Todo("h:1 hidden todo");
  const todos = [todoVisible, todoHidden];
  let navContext: any;

  const { unmount } = render(
    <TestWrapper todos={todos} onContext={(ctx) => (navContext = ctx)} />,
  );

  // First toggle
  await waitFor(() => {
    if (!navContext) throw new Error("Context not ready");
  });

  navContext.toggleShowHidden();
  await waitFor(() => expect(navContext.showHidden).toEqual(true));

  // Second toggle
  navContext.toggleShowHidden();
  await waitFor(() => expect(navContext.showHidden).toEqual(false));

  const visibleTodos = navContext.indexes.filter(
    (i: any) => i.type === IndexType.todo,
  );
  expect(visibleTodos.length).toEqual(1);
  expect(visibleTodos[0].todo.text).toEqual("visible todo");

  unmount();
});
