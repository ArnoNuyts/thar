import { expect, test } from "vitest";

import { render } from "ink-testing-library";
import { useEffect } from "react";
import * as ink from "ink";
import {
  NavigationProvider,
  useNavigation,
} from "../contexts/navigation-context.tsx";
import { SearchProvider } from "../contexts/search-context.tsx";
import { Todo } from "../logic/todo.ts";
import type { Todos } from "../logic/Todos.ts";
import { waitFor } from "./test-utils.ts";

// Helper component to interact with NavigationContext
const NavigationTester = ({ onContext }: { onContext: (ctx: any) => void }) => {
  const nav = useNavigation();
  useEffect(() => {
    onContext(nav);
  });
  return <ink.Text>Tester</ink.Text>;
};

const TestWrapper = ({
  children,
  todos,
  listHeight,
}: {
  children: React.ReactNode;
  todos: Todos;
  listHeight: number;
}) => (
  <SearchProvider>
    <NavigationProvider todos={todos} listHeightForTest={listHeight}>
      {children}
    </NavigationProvider>
  </SearchProvider>
);

test("scrolling with padding", async () => {
  await (async () => {
    const todos = [
      ...Array.from({ length: 20 }, (_, i) => new Todo(`Todo ${i + 1}`)),
    ];
    let navContext: any;

    const { unmount } = render(
      <TestWrapper todos={todos} listHeight={10}>
        <NavigationTester onContext={(ctx) => (navContext = ctx)} />
      </TestWrapper>,
    );

    await waitFor(() => {
      expect(navContext.listHeight).toEqual(10);
      expect(navContext.getSelectedTodo()?.text).toEqual("Todo 1");
    });

    // Navigate to selectedRow 8 (index 9 with header).
    for (let i = 0; i < 7; i++) {
      navContext.navigateDown();
    }
    await waitFor(() => {
      expect(navContext.getSelectedTodo()?.text).toEqual(`Todo 8`);
      expect(navContext.offsetRow).toEqual(0);
    });

    // First scroll ("1 deep")
    navContext.navigateDown();
    await waitFor(() => {
      expect(navContext.getSelectedTodo()?.text).toEqual("Todo 9");
      // selectedRow is 9. listHeight=10, pad=1. trigger is 9 >= 0+10-1=9.
      // new offset = 9 - 10 + 1 + 1 = 1.
      expect(navContext.offsetRow).toEqual(1);
    });

    // Second scroll ("2 deep")
    navContext.navigateDown();
    await waitFor(() => {
      expect(navContext.getSelectedTodo()?.text).toEqual("Todo 10");
      // selectedRow is 10. offset=1. trigger is 10 >= 1+10-1=10.
      // new offset = 10 - 10 + 1 + 1 = 2.
      expect(navContext.offsetRow).toEqual(2);
    });

    unmount();
  })();

  await (async () => {
    const todos = [
      ...Array.from({ length: 20 }, (_, i) => new Todo(`Todo ${i + 1}`)),
    ];
    let navContext: any;

    const { unmount } = render(
      <TestWrapper todos={todos} listHeight={10}>
        <NavigationTester onContext={(ctx) => (navContext = ctx)} />
      </TestWrapper>,
    );
    await waitFor(() =>
      expect(navContext.getSelectedTodo()?.text).toEqual("Todo 1"),
    );

    // Scroll down to row 15 to establish an offset
    for (let i = 0; i < 14; i++) {
      navContext.navigateDown();
    }
    await waitFor(() => {
      expect(navContext.getSelectedTodo()?.text).toEqual("Todo 15");
      expect(navContext.offsetRow).toEqual(7);
    });

    // Navigate up to the padded edge (selectedRow 8)
    for (let i = 0; i < 7; i++) {
      navContext.navigateUp();
    }
    await waitFor(() => {
      expect(navContext.getSelectedTodo()?.text).toEqual("Todo 8");
      expect(navContext.offsetRow).toEqual(7);
    });

    // First scroll up
    navContext.navigateUp();
    await waitFor(() => {
      expect(navContext.getSelectedTodo()?.text).toEqual("Todo 7");
      // selectedRow is 7. offset=7. trigger up is 7 < 7+1=8. true.
      // new offset = 7 - 1 = 6.
      expect(navContext.offsetRow).toEqual(6);
    });

    // Second scroll up
    navContext.navigateUp();
    await waitFor(() => {
      expect(navContext.getSelectedTodo()?.text).toEqual("Todo 6");
      // selectedRow is 6. offset=6. trigger up is 6 < 6+1=7. true.
      // new offset = 6 - 1 = 5.
      expect(navContext.offsetRow).toEqual(5);
    });

    unmount();
  })();

  await (async () => {
    const todos = [
      ...Array.from({ length: 20 }, (_, i) => new Todo(`Todo ${i + 1}`)),
    ];
    let navContext: any;

    const { unmount } = render(
      <TestWrapper todos={todos} listHeight={10}>
        <NavigationTester onContext={(ctx) => (navContext = ctx)} />
      </TestWrapper>,
    );

    await waitFor(() => {
      expect(navContext.listHeight).toEqual(10);
      expect(navContext.getSelectedTodo()?.text).toEqual("Todo 1");
    });

    // Navigate to the last item
    for (let i = 0; i < 19; i++) {
      navContext.navigateDown();
    }
    await waitFor(() => {
      expect(navContext.getSelectedTodo()?.text).toEqual("Todo 20");
      expect(navContext.offsetRow).toEqual(11);
    });

    unmount();
  })();
});
