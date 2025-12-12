import { render } from "ink-testing-library";
import { assertEquals } from "@std/assert";
import { delay } from "@std/async";
import {
  NavigationProvider,
  useNavigation,
} from "../contexts/navigation-context.tsx";
import { SearchProvider } from "../contexts/search-context.tsx";
import { Text } from "ink";
import { useEffect } from "react";
import { Todo } from "../logic/todo.ts";
import { Todos } from "../logic/Todos.ts";

const TestWrapper = (
  { children, todos }: {
    children: React.ReactNode;
    todos: Todos;
  },
) => (
  <SearchProvider>
    <NavigationProvider todos={todos}>
      {children}
    </NavigationProvider>
  </SearchProvider>
);

// Helper component to interact with NavigationContext
// deno-lint-ignore no-explicit-any
const NavigationTester = ({ onContext }: { onContext: (ctx: any) => void }) => {
  const nav = useNavigation();
  useEffect(() => {
    onContext(nav);
  });
  return <Text>Tester</Text>;
};

Deno.test({
  name: "NavigationContext Tests",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async (t) => {
    await t.step("should initialize with first todo selected", async () => {
      const todos = new Todos(
        new Todo("Todo 1"),
        new Todo("Todo 2"),
        new Todo("Todo 3"),
      );
      // deno-lint-ignore no-explicit-any
      let navContext: any;

      const { unmount } = render(
        <TestWrapper todos={todos}>
          <NavigationTester onContext={(ctx) => navContext = ctx} />
        </TestWrapper>,
      );

      await delay(100);

      // Verify initial state
      // indexes should have 3 todos + 1 context header = 4
      assertEquals(navContext?.indexes?.length, 4);
      // selectedTodoHash should act roughly like Todo 1's hash
      // We can check if useSelectedTodo returns Todo 1
      const selected = navContext.useSelectedTodo();
      assertEquals(selected.text, "Todo 1");

      unmount();
    });

    await t.step("should navigate down", async () => {
      const todos = new Todos(
        new Todo("Todo 1"),
        new Todo("Todo 2"),
        new Todo("Todo 3"),
      );
      // deno-lint-ignore no-explicit-any
      let navContext: any;

      const { unmount } = render(
        <TestWrapper todos={todos}>
          <NavigationTester onContext={(ctx) => navContext = ctx} />
        </TestWrapper>,
      );

      await delay(100);

      navContext.navigateDown();
      await delay(50); // State update

      const selected = navContext.useSelectedTodo();
      assertEquals(selected.text, "Todo 2");

      unmount();
    });

    await t.step("should navigate up", async () => {
      const todos = new Todos(
        new Todo("Todo 1"),
        new Todo("Todo 2"),
      );
      // deno-lint-ignore no-explicit-any
      let navContext: any;

      const { unmount } = render(
        <TestWrapper todos={todos}>
          <NavigationTester onContext={(ctx) => navContext = ctx} />
        </TestWrapper>,
      );

      await delay(100);

      // Start at 1
      navContext.navigateDown();
      await delay(50);
      assertEquals(navContext.useSelectedTodo().text, "Todo 2");

      navContext.navigateUp();
      await delay(50);
      assertEquals(navContext.useSelectedTodo().text, "Todo 1");

      unmount();
    });

    await t.step("should clamp navigation at bounds", async () => {
      const todos = new Todos(
        new Todo("Todo 1"),
        new Todo("Todo 2"),
      );
      // deno-lint-ignore no-explicit-any
      let navContext: any;

      const { unmount } = render(
        <TestWrapper todos={todos}>
          <NavigationTester onContext={(ctx) => navContext = ctx} />
        </TestWrapper>,
      );

      await delay(100);

      // Up from top
      navContext.navigateUp();
      await delay(50);
      assertEquals(navContext.useSelectedTodo().text, "Todo 1");

      // Down to bottom
      navContext.navigateDown();
      await delay(50);
      assertEquals(navContext.useSelectedTodo().text, "Todo 2");

      // Down past bottom
      navContext.navigateDown(); // Should stay at 2
      await delay(50);
      assertEquals(navContext.useSelectedTodo().text, "Todo 2");

      unmount();
    });
  },
});
