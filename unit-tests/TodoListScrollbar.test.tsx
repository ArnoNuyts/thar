import { assertEquals } from "@std/assert";
import { render } from "ink-testing-library";
import { TodoListScrollbar } from "../components/TodoListScrollbar.tsx";

Deno.test("TodoListScrollbar: hidden when list is not scrollable", () => {
  const { lastFrame, unmount } = render(
    <TodoListScrollbar totalRows={5} listHeight={10} offsetRow={0} />,
  );

  assertEquals(lastFrame(), "");
  unmount();
});

Deno.test("TodoListScrollbar: handle size reflects viewport/total ratio", () => {
  const { lastFrame, unmount } = render(
    <TodoListScrollbar totalRows={20} listHeight={10} offsetRow={0} />,
  );

  const frame = lastFrame() ?? "";
  const handleRows = frame.split("").filter((char) => char === "│").length;

  assertEquals(handleRows, 5);
  unmount();
});

Deno.test("TodoListScrollbar: handle position follows offset", () => {
  const { lastFrame, unmount } = render(
    <TodoListScrollbar totalRows={20} listHeight={10} offsetRow={10} />,
  );

  const lines = (lastFrame() ?? "").split("\n");
  const firstHandleRow = lines.findIndex((line) => line.includes("│"));

  assertEquals(firstHandleRow, 5);
  unmount();
});
