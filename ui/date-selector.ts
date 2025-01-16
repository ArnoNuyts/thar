import { crayon } from "https://deno.land/x/crayon@3.3.3/mod.ts";
import { Computed, Tui, clamp } from "https://deno.land/x/tui@2.1.11/mod.ts";
import { Box } from "https://deno.land/x/tui@2.1.11/src/components/box.ts";
import { Frame } from "https://deno.land/x/tui@2.1.11/src/components/frame.ts";
import { Text } from "https://deno.land/x/tui@2.1.11/src/components/text.ts";
import { addDays, addMonths, addWeeks } from "https://esm.sh/date-fns@4.1.0";
import { List } from "./list.ts";
import { keepComponentFocussed } from "./tui-helpers.ts";

export default (title: string, parent: Tui): Promise<Date> => {
  const options = [
    { date: addDays(new Date(), 0), text: "Today" },
    { date: addDays(new Date(), 1), text: "Tomorrow" },
    { date: addWeeks(new Date(), 1), text: "Next week" },
    { date: addWeeks(new Date(), 2), text: "In two weeks" },
    { date: addWeeks(new Date(), 3), text: "In three weeks" },
    { date: addMonths(new Date(), 1), text: "Next month" },
  ]

  const box = new Box({
    parent: parent,
    theme: {
      base: crayon.bgBlack.white,
    },
    rectangle: new Computed(() => {
      let width = clamp(clamp(parent.rectangle.value.width / 2, 20, 60), 0, parent.rectangle.value.width);
      if (width % 2 !== 0) {
        // Adjust the value to make it even
        width = Math.floor(width / 2) * 2;
      }
      const height = 2 + options.length;
      return {
        column: Math.floor((parent.rectangle.value.width - width) / 2),
        row: Math.floor((parent.rectangle.value.height - height) / 2),
        height,
        width,
      };
    }),
    zIndex: 5,
  })

  const frame = new Frame({
    parent: box,
    charMap: "sharp",
    theme: {
      base: crayon.bgBlack.white,
    },
    rectangle: box.rectangle,
    zIndex: 5,
  });

  const textBox = new Text({
    parent: box,
    text: `| ${title} |`,
    theme: {
      base: crayon.bgBlack.white,
    },
    rectangle: new Computed(() => ({
      column: box.rectangle.value.column + 2,
      row: box.rectangle.value.row - 1,
    })),
    zIndex: 6,
  });
  return new Promise((resolve, reject) => {

    const list = new List({
      parent: frame,
      theme: {
        base: crayon.bgBlack.white,
        frame: { base: crayon.bgBlack },
        selectedRow: {
          base: crayon.bold.bgBlue.white,
          focused: crayon.bold.bgWhite.black,
          active: crayon.bold.bgWhite.black,
        },
      },
      rectangle: {
        column: frame.rectangle.value.column + 1,
        row: frame.rectangle.value.row,
        width: frame.rectangle.value.width - 2,
        height: options.length,
      },
      data: options.map(x => [x.text]),
      zIndex: 7,
      interactCallback: () => {
        destroy();
        // Prevent event bubbeling hack
        setTimeout(() => resolve(options[list.selectedRow.peek()!]?.date), 200);
      }
    });

    const destroy = () => {
      box.destroy();
      textBox.destroy();
      list.destroy();
    }

    keepComponentFocussed(list);

    list.on("keyPress", ({ key, ctrl, meta, shift }) => {

      if (ctrl || meta || shift) return;

      switch (key) {
        case "escape":
          destroy();
          reject("Canceled");
          break;
        case "return":
          destroy();
          if (list.selectedRow.peek() === undefined) {
            reject("No selection");
            break;
          }
          resolve(options[list.selectedRow.peek()!]?.date);
          break;
      }
    });
  });
}
