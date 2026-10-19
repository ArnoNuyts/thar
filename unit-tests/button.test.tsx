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
