import { assertStrictEquals } from "@std/assert";
import { render } from "ink-testing-library";
import { type ReactElement, useContext, useEffect } from "react";

import {
  NavigationContext,
  NavigationContextType,
} from "../contexts/navigation-context.tsx";
import { TodoContext, TodoContextType } from "../contexts/todo-context.tsx";
import { ToasterProvider } from "../contexts/toaster-context.tsx";
import { MockTodoProvider } from "./mock-todo-provider.tsx";
import { TestWrapper } from "./test-components.tsx";
import { waitFor } from "./test-utils.ts";

type ObservedValues = {
  todo: TodoContextType | undefined;
  nav: NavigationContextType | undefined;
};

const committedValues: ObservedValues[] = [];

const Probe = () => {
  const todo = useContext(TodoContext);
  const nav = useContext(NavigationContext);

  // Record the latest committed context value so the test never compares
  // against a render pass that React discarded.
  useEffect(() => {
    committedValues.push({ todo, nav });
  });

  return null;
};

const assertStableAcrossRerender = async (
  // A fresh element tree each time so the providers render again.
  tree: () => ReactElement,
) => {
  committedValues.length = 0;

  const { rerender, unmount } = render(tree());

  try {
    await waitFor(() => {
      assertStrictEquals(committedValues.length >= 1, true);
    });
    const baseline = committedValues[committedValues.length - 1];

    rerender(tree());

    await waitFor(() => {
      assertStrictEquals(committedValues.length >= 2, true);
    });
    const latest = committedValues[committedValues.length - 1];

    assertStrictEquals(latest.todo, baseline.todo);
    assertStrictEquals(latest.nav, baseline.nav);
  } finally {
    unmount();
  }
};

Deno.test({
  name:
    "TestWrapper: reuses context values when overrides are referentially stable",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const todoValue: Partial<TodoContextType> = {};
    const navValue: Partial<NavigationContextType> = {};
    await assertStableAcrossRerender(() => (
      <TestWrapper todoValue={todoValue} navValue={navValue}>
        <Probe />
      </TestWrapper>
    ));
  },
});

Deno.test({
  name:
    "TestWrapper: reuses default context values when no overrides are given",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await assertStableAcrossRerender(() => (
      <TestWrapper>
        <Probe />
      </TestWrapper>
    ));
  },
});

Deno.test({
  name: "MockTodoProvider: reuses its context value when state is unchanged",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await assertStableAcrossRerender(() => (
      <ToasterProvider>
        <MockTodoProvider>
          <Probe />
        </MockTodoProvider>
      </ToasterProvider>
    ));
  },
});
