import { expect, test } from "vitest";

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
      expect(committedValues.length >= 1).toBe(true);
    });
    const baseline = committedValues[committedValues.length - 1];

    rerender(tree());

    await waitFor(() => {
      expect(committedValues.length >= 2).toBe(true);
    });
    const latest = committedValues[committedValues.length - 1];

    expect(latest.todo).toBe(baseline.todo);
    expect(latest.nav).toBe(baseline.nav);
  } finally {
    unmount();
  }
};

test("TestWrapper: reuses context values when overrides are referentially stable", async () => {
  const todoValue: Partial<TodoContextType> = {};
  const navValue: Partial<NavigationContextType> = {};
  await assertStableAcrossRerender(() => (
    <TestWrapper todoValue={todoValue} navValue={navValue}>
      <Probe />
    </TestWrapper>
  ));
});

test("TestWrapper: reuses default context values when no overrides are given", async () => {
  await assertStableAcrossRerender(() => (
    <TestWrapper>
      <Probe />
    </TestWrapper>
  ));
});

test("MockTodoProvider: reuses its context value when state is unchanged", async () => {
  await assertStableAcrossRerender(() => (
    <ToasterProvider>
      <MockTodoProvider>
        <Probe />
      </MockTodoProvider>
    </ToasterProvider>
  ));
});
