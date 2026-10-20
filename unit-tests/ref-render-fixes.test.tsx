import { assertEquals, assertMatch } from "@std/assert";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { Button } from "../components/Button.tsx";
import { FocusProvider } from "../contexts/focus-context.tsx";
import { useFocusedInput } from "../hooks/useFocusedInput.ts";
import { useInput } from "../hooks/useInput.ts";
import { type MouseEvent, useMouseInput } from "../hooks/useMouseInput.ts";
import { waitFor } from "./test-utils.ts";

// Regression coverage for refs updated with the latest handler/state. The
// updates must happen after commit (in an effect) while still guaranteeing
// that input arriving right after mount or a rerender uses the latest value.

type InputHandler = (input: string) => void;

function InputHarness({ onInput }: { onInput: InputHandler }) {
  useInput((input) => onInput(input));
  return <Text>input</Text>;
}

function FocusedInputHarness({ onInput }: { onInput: InputHandler }) {
  const { isFocused } = useFocusedInput((input) => onInput(input), {
    autoFocus: true,
  });
  return <Text>{isFocused ? "focused" : "blurred"}</Text>;
}

function MouseHarness({ onMouse }: { onMouse: (event: MouseEvent) => void }) {
  useMouseInput(onMouse);
  return <Text>mouse</Text>;
}

Deno.test("useInput: first render handler receives input", async () => {
  const calls: string[] = [];
  const { stdin, unmount } = render(
    <InputHarness onInput={(input) => calls.push(`first:${input}`)} />,
  );

  try {
    await stdin.write("a");
    await waitFor(() => assertEquals(calls, ["first:a"]));
  } finally {
    unmount();
  }
});

Deno.test("useInput: rerender uses the latest handler", async () => {
  const calls: string[] = [];
  const { stdin, rerender, unmount } = render(
    <InputHarness onInput={(input) => calls.push(`first:${input}`)} />,
  );

  try {
    rerender(
      <InputHarness onInput={(input) => calls.push(`second:${input}`)} />,
    );

    await stdin.write("b");
    await waitFor(() => assertEquals(calls, ["second:b"]));
  } finally {
    unmount();
  }
});

Deno.test("useFocusedInput: rerender uses the latest handler while focused", async () => {
  const calls: string[] = [];
  const { stdin, rerender, lastFrame, unmount } = render(
    <FocusProvider>
      <FocusedInputHarness onInput={(input) => calls.push(`first:${input}`)} />
    </FocusProvider>,
  );

  try {
    await waitFor(() => assertMatch(lastFrame() ?? "", /focused/));

    rerender(
      <FocusProvider>
        <FocusedInputHarness
          onInput={(input) => calls.push(`second:${input}`)}
        />
      </FocusProvider>,
    );

    await waitFor(() => assertMatch(lastFrame() ?? "", /focused/));

    await stdin.write("c");
    await waitFor(() => assertEquals(calls, ["second:c"]));
  } finally {
    unmount();
  }
});

Deno.test("useMouseInput: rerender uses the latest handler", async () => {
  const calls: string[] = [];
  const { stdin, rerender, unmount } = render(
    <MouseHarness onMouse={() => calls.push("first")} />,
  );

  try {
    rerender(<MouseHarness onMouse={() => calls.push("second")} />);

    // SGR left click at column 5, row 5.
    await stdin.write("\x1b[<0;5;5M");
    await waitFor(() => assertEquals(calls, ["second"]));
  } finally {
    unmount();
  }
});

Deno.test("Button.Group: controlled selection changes retarget activation", async () => {
  const pressed: string[] = [];
  const tree = (selectedIndex: number) => (
    <Button.Group
      isFocused
      selectedIndex={selectedIndex}
      onSelectedIndexChange={() => {}}
    >
      <Button label="First" onPress={() => pressed.push("First")} />
      <Button label="Second" onPress={() => pressed.push("Second")} />
    </Button.Group>
  );
  const { stdin, rerender, unmount } = render(tree(0));

  try {
    rerender(tree(1));

    await stdin.write("\r");
    await waitFor(() => assertEquals(pressed, ["Second"]));
  } finally {
    unmount();
  }
});

Deno.test("Button.Group: first render activation uses the initial selection", async () => {
  const pressed: string[] = [];
  const { stdin, unmount } = render(
    <Button.Group
      isFocused
      defaultSelectedIndex={1}
      onSelectedIndexChange={() => {}}
    >
      <Button label="First" onPress={() => pressed.push("First")} />
      <Button label="Second" onPress={() => pressed.push("Second")} />
    </Button.Group>,
  );

  try {
    await stdin.write("\r");
    await waitFor(() => assertEquals(pressed, ["Second"]));
  } finally {
    unmount();
  }
});
