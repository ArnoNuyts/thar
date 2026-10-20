import { expect, test } from "vitest";

import { render } from "ink-testing-library";
import { TodoListScrollbar } from "../components/TodoListScrollbar.tsx";

test("TodoListScrollbar: hidden when list is not scrollable", () => {
  const { lastFrame, unmount } = render(
    <TodoListScrollbar totalRows={5} listHeight={10} offsetRow={0} />,
  );

  expect(lastFrame()).toEqual("");
  unmount();
});

test("TodoListScrollbar: handle size reflects viewport/total ratio", () => {
  const { lastFrame, unmount } = render(
    <TodoListScrollbar totalRows={20} listHeight={10} offsetRow={0} />,
  );

  const frame = lastFrame() ?? "";
  const handleRows = frame.split("").filter((char) => char === "│").length;

  expect(handleRows).toEqual(5);
  unmount();
});

test("TodoListScrollbar: handle position follows offset", () => {
  const { lastFrame, unmount } = render(
    <TodoListScrollbar totalRows={20} listHeight={10} offsetRow={10} />,
  );

  const lines = (lastFrame() ?? "").split("\n");
  const firstHandleRow = lines.findIndex((line) => line.includes("│"));

  expect(firstHandleRow).toEqual(5);
  unmount();
});
