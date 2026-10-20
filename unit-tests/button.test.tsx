import { expect, test } from "vitest";

import { render } from "ink-testing-library";

import { Button } from "../components/Button.tsx";

const buttonTree = (
  isFocused: boolean,
  pressed: string[],
  onSelectedIndexChange: (index: number) => void,
) => (
  <Button.Group
    isFocused={isFocused}
    selectedIndex={0}
    onSelectedIndexChange={onSelectedIndexChange}
  >
    <Button label="First" onPress={() => pressed.push("First")} />
    <Button label="Second" onPress={() => pressed.push("Second")} />
  </Button.Group>
);

test("Button.Group: ignores keys while unfocused", () => {
  const pressed: string[] = [];
  const indexChanges: number[] = [];
  const { stdin, unmount } = render(
    buttonTree(false, pressed, (index) => indexChanges.push(index)),
  );

  stdin.write("\u001B[C"); // Right
  stdin.write("\r"); // Enter
  stdin.write(" "); // Space

  expect(indexChanges).toEqual([]);
  expect(pressed).toEqual([]);

  unmount();
});

test("Button.Group: focused buttons navigate and activate", () => {
  const pressed: string[] = [];
  const indexChanges: number[] = [];
  const { stdin, unmount } = render(
    buttonTree(true, pressed, (index) => indexChanges.push(index)),
  );

  stdin.write("\u001B[C"); // Right selects the second button
  stdin.write("\r"); // Enter activates it

  expect(indexChanges).toEqual([1]);
  expect(pressed).toEqual(["Second"]);

  unmount();
});

test("Button.Group: repeated labels keep unique keys and navigate", () => {
  const pressed: string[] = [];
  const indexChanges: number[] = [];
  const originalError = console.error;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args.map((arg) => String(arg)).join(" "));
  };

  const { stdin, unmount } = render(
    <Button.Group
      isFocused
      selectedIndex={0}
      onSelectedIndexChange={(index) => indexChanges.push(index)}
    >
      <Button label="Same" onPress={() => pressed.push("first")} />
      <Button label="Same" onPress={() => pressed.push("second")} />
      <Button label="Same" onPress={() => pressed.push("third")} />
    </Button.Group>,
  );

  try {
    stdin.write("\u001B[C"); // Right selects the second button
    stdin.write("\r"); // Enter activates it

    expect(indexChanges).toEqual([1]);
    expect(pressed).toEqual(["second"]);
    expect(errors.some((message) => message.includes("same key"))).toEqual(
      false,
    );
  } finally {
    unmount();
    console.error = originalError;
  }
});
