import { assertEquals } from "@std/assert";
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

Deno.test("Button.Group: ignores keys while unfocused", () => {
  const pressed: string[] = [];
  const indexChanges: number[] = [];
  const { stdin, unmount } = render(
    buttonTree(false, pressed, (index) => indexChanges.push(index)),
  );

  stdin.write("\u001B[C"); // Right
  stdin.write("\r"); // Enter
  stdin.write(" "); // Space

  assertEquals(indexChanges, []);
  assertEquals(pressed, []);

  unmount();
});

Deno.test("Button.Group: focused buttons navigate and activate", () => {
  const pressed: string[] = [];
  const indexChanges: number[] = [];
  const { stdin, unmount } = render(
    buttonTree(true, pressed, (index) => indexChanges.push(index)),
  );

  stdin.write("\u001B[C"); // Right selects the second button
  stdin.write("\r"); // Enter activates it

  assertEquals(indexChanges, [1]);
  assertEquals(pressed, ["Second"]);

  unmount();
});

Deno.test("Button.Group: repeated labels keep unique keys and navigate", () => {
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

    assertEquals(indexChanges, [1]);
    assertEquals(pressed, ["second"]);
    assertEquals(
      errors.some((message) => message.includes("same key")),
      false,
    );
  } finally {
    unmount();
    console.error = originalError;
  }
});
