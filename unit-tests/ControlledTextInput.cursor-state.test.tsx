import { expect, test } from "vitest";

import { render } from "ink-testing-library";
import { ControlledTextInput } from "../components/ControlledTextInput.tsx";
import { waitFor } from "./test-utils.ts";

test("ControlledTextInput - a changed controlled cursor moves the insertion point", async () => {
  const changes: string[] = [];
  const cursorEvents: Array<{ offset: number; value: string }> = [];

  const tree = (cursorOffset: number) => (
    <ControlledTextInput
      value="hello"
      cursorOffset={cursorOffset}
      onChange={(value) => changes.push(value)}
      onCursorChange={(offset, value) => cursorEvents.push({ offset, value })}
    />
  );
  const { stdin, rerender, unmount } = render(tree(5));

  try {
    // The parent moves the cursor from the end to just after "he".
    rerender(tree(2));

    await stdin.write("X");

    await waitFor(() => {
      expect(changes).toEqual(["heXllo"]);
      expect(cursorEvents.at(-1)).toEqual({ offset: 3, value: "heXllo" });
    });
  } finally {
    unmount();
  }
});

test("ControlledTextInput - the initial controlled cursor is used by the first keypress", async () => {
  let value = "hello";

  const { stdin, unmount } = render(
    <ControlledTextInput
      value="hello"
      cursorOffset={2}
      onChange={(nextValue) => {
        value = nextValue;
      }}
    />,
  );

  try {
    await stdin.write("X");

    await waitFor(() => {
      expect(value).toEqual("heXllo");
    });
  } finally {
    unmount();
  }
});

test("ControlledTextInput - uncontrolled cursor is clamped when the value shrinks", async () => {
  let value = "hello world";

  const tree = (nextValue: string) => (
    <ControlledTextInput
      value={nextValue}
      onChange={(changedValue) => {
        value = changedValue;
      }}
    />
  );
  const { stdin, rerender, unmount } = render(tree(value));

  try {
    // The cursor was at offset 11, which no longer exists in "hello".
    rerender(tree("hello"));

    await stdin.write("\x1b[D");
    await stdin.write("X");

    await waitFor(() => {
      expect(value).toEqual("hellXo");
    });
  } finally {
    unmount();
  }
});

test("ControlledTextInput - uncontrolled cursor follows arrow keys before typing", async () => {
  let value = "hello";

  const { stdin, unmount } = render(
    <ControlledTextInput
      value="hello"
      onChange={(nextValue) => {
        value = nextValue;
      }}
    />,
  );

  try {
    // Uncontrolled cursor starts at the end; move it left once, then insert.
    await stdin.write("\x1b[D");
    await stdin.write("X");

    await waitFor(() => {
      expect(value).toEqual("hellXo");
    });
  } finally {
    unmount();
  }
});
