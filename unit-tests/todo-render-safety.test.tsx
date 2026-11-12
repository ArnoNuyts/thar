import { expect, test } from "vitest";
import { render } from "ink-testing-library";

import { TodoList } from "../components/TodoList.tsx";
import { FocusProvider } from "../contexts/focus-context.tsx";
import { ModalProvider } from "../contexts/modal-context.tsx";
import { NavigationProvider } from "../contexts/navigation-context.tsx";
import { SearchProvider } from "../contexts/search-context.tsx";
import { SuggestionProvider } from "../contexts/suggestion-context.tsx";
import { ToasterProvider } from "../contexts/toaster-context.tsx";
import { sanitizeForDisplay } from "../logic/display-safety.ts";
import type { Todos } from "../logic/Todos.ts";
import { Todo } from "../logic/todo.ts";
import { MockTodoProvider } from "./mock-todo-provider.tsx";
import { waitFor } from "./test-utils.ts";

const CONTROLS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]/u;

const Wrapper = ({ todos }: { todos: Todos }) => (
  <ToasterProvider>
    <MockTodoProvider initialTodos={todos}>
      <FocusProvider>
        <SuggestionProvider>
          <SearchProvider>
            <NavigationProvider todos={todos} listHeightForTest={20}>
              <ModalProvider>
                <TodoList />
              </ModalProvider>
            </NavigationProvider>
          </SearchProvider>
        </SuggestionProvider>
      </FocusProvider>
    </MockTodoProvider>
  </ToasterProvider>
);

test("renderTodoText: terminal control and ANSI sequences never reach the frame", async () => {
  const poisoned = [
    "innocent\rFAKE ROW",
    "ansi\u001b]0;pwned\u0007title",
    "sgr\u001b[31mred",
    "hyperlink\u001b]8;;https://evil\u0007link\u001b]8;;\u0007",
    "line\u2028sep\u2029next",
    "nul\u0000byte",
    "c1\u009b31m",
    "del\u007fchar",
    "tag task due:2020-01-01\u001b[31m",
  ];
  const todos = poisoned.map((line) => new Todo(line));

  const { lastFrame, unmount } = render(<Wrapper todos={todos} />);

  try {
    await waitFor(() => {
      const frame = lastFrame() ?? "";
      expect(frame.includes("innocent")).toEqual(true);
      expect(frame).toContain("\\u001B");
      expect(frame).toContain("\\u0000");
      expect(frame).toContain("\\u009B");
      expect(frame).toContain("\\u2028");
    });

    const frame = lastFrame() ?? "";
    expect(frame.includes("\u001b"), "no ESC").toEqual(false);
    expect(frame.includes("\r"), "no CR").toEqual(false);
    expect(frame.includes("\u0000"), "no NUL").toEqual(false);
    expect(CONTROLS.test(frame), "no C0/C1/DEL/line separators").toEqual(false);
  } finally {
    unmount();
  }
});

test("sanitizeForDisplay: escapes terminal controls but keeps text and tabs", () => {
  expect(sanitizeForDisplay("plain text @home +work")).toEqual(
    "plain text @home +work",
  );
  expect(sanitizeForDisplay("before\tafter")).toEqual("before\tafter");

  const cases: Array<[string, string]> = [
    ["\u0000", "\\u0000"],
    ["\u0001", "\\u0001"],
    ["\u0007", "\\u0007"],
    ["\u0008", "\\u0008"],
    ["\n", "\\u000A"],
    ["\r", "\\u000D"],
    ["\u001b", "\\u001B"],
    ["\u001b[31m", "\\u001B[31m"],
    ["\u007f", "\\u007F"],
    ["\u009b31m", "\\u009B31m"],
    ["\u2028", "\\u2028"],
    ["\u2029", "\\u2029"],
  ];

  for (const [input, expected] of cases) {
    const safe = sanitizeForDisplay(input);
    expect(safe).toEqual(expected);
    expect(CONTROLS.test(safe), `leaked control for ${expected}`).toEqual(
      false,
    );
  }
});
