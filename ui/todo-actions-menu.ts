import { crayon } from "https://deno.land/x/crayon@3.3.3/mod.ts";
import { clamp, Computed, Tui } from "https://deno.land/x/tui@2.1.11/mod.ts";
import { Box } from "https://deno.land/x/tui@2.1.11/src/components/box.ts";
import { Frame } from "https://deno.land/x/tui@2.1.11/src/components/frame.ts";
import { List } from "./list.ts";
import { keepComponentFocussed } from "./tui-helpers.ts";

export default (
  parent: Tui,
): Promise<string> => {
  const box = new Box({
    parent: parent,
    theme: {
      base: crayon.bgBlack.white,
    },
    rectangle: new Computed(() => {
      let width = clamp(
        clamp(parent.rectangle.value.width / 2, 20, 60),
        0,
        parent.rectangle.value.width,
      );
      if (width % 2 !== 0) {
        // Adjust the value to make it even
        width = Math.floor(width / 2) * 2; // Rounds down to nearest even number
      }

      return {
        column: Math.floor((parent.rectangle.value.width - width) / 2),
        row: Math.floor((parent.rectangle.value.height - 10) / 2),
        height: 10,
        width: width,
      };
    }),
    zIndex: 5,
  });

  const frame = new Frame({
    parent: box,
    charMap: "sharp",
    theme: {
      base: crayon.bgBlack.white,
    },
    rectangle: box.rectangle,
    zIndex: 5,
  });

  const actions = [
    { name: "Edit" },
    { name: "Delete" },
    { name: "Toggle Complete" },
    { name: "Set Due Date" },
    { name: "Set Threshold Date" },
    { name: "Set Recurrence" },
    { name: "Toggle Hidden" },
  ];

  const list = new List({
    parent: frame,
    data: actions.map((a) => [a.name]),
    theme: {
      base: crayon.bgBlack.white,
      frame: { base: crayon.bgBlack },
      selectedRow: {
        base: crayon.bold.bgBlue.white,
        focused: crayon.bold.bgWhite.black,
        active: crayon.bold.bgWhite.black,
      },
    },
    rectangle: new Computed(() => ({
      column: frame.rectangle.value.column + 1,
      row: frame.rectangle.value.row,
      width: frame.rectangle.value.width - 2,
      height: frame.rectangle.value.height,
    })),
    zIndex: 6,
  });

  keepComponentFocussed(list);

  return new Promise((resolve, reject) => {
    list.on("keyPress", ({ key }) => {
      if (key === "escape") {
        box.destroy();
        reject("Canceled");
      } else if (key === "return") {
        box.destroy();
        resolve(actions[list.selectedRow.peek()].name);
      }
    });
  });
};
