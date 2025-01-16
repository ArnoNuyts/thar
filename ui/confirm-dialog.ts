import { crayon } from "https://deno.land/x/crayon@3.3.3/mod.ts";
import { Computed, Tui } from "https://deno.land/x/tui@2.1.11/mod.ts";
import { Button } from "https://deno.land/x/tui@2.1.11/src/components/button.ts";
import { Popup } from "./popup.ts";

export default (title: string, parent: Tui): Promise<void> => {
  const popup = new Popup({
    parent,
    zIndex: 5,
    title: title,
    rectangle: { height: 3 },
    visible: true,
  });

  const okButton = new Button({
    parent: popup,
    theme: {
      base: crayon.bgBlack,
      focused: crayon.bgWhite.black,
      active: crayon.bgYellow.black,
    },
    rectangle: new Computed(() => ({
      column: popup.rectangle.value.column + 1,
      row: popup.rectangle.value.row + 1,
      width: popup.rectangle.value.width / 2 - 2,
      height: 1,
    })),
    zIndex: 6,
    label: { text: "Ok" },
  });

  const cancelButton = new Button({
    parent: popup,
    theme: {
      base: crayon.bgBlack,
      focused: crayon.bgWhite.black,
      active: crayon.bgYellow.black,
    },
    rectangle: new Computed(() => ({
      column: popup.rectangle.value.column + 1 +
        popup.rectangle.value.width / 2,
      row: popup.rectangle.value.row + 1,
      width: popup.rectangle.value.width / 2 - 2,
      height: 1,
    })),
    zIndex: 6,
    label: { text: "Cancel" },
  });
  cancelButton.state.value = "base";
  setTimeout(() => okButton.state.value = "focused", 20);

  const destroy = () => {
    okButton.destroy();
    cancelButton.destroy();
    popup.destroy();
  };

  // Set timeout otherwise toggle breaks :/
  const toggleFocus = () => {
    if (okButton.state.value === "focused") {
      setTimeout(() => cancelButton.state.value = "focused", 20);
    } else {
      setTimeout(() => okButton.state.value = "focused", 20);
    }
  };

  return new Promise((resolve, reject) => {
    cancelButton.interact = (event) => {
      if (event === "mouse") {
        destroy();
        // Prevent event bubbling
        setTimeout(reject, 200);
      }
    };

    okButton.interact = (event) => {
      if (event === "mouse") {
        destroy();
        // Prevent event bubbling
        setTimeout(resolve, 200);
      }
    };

    cancelButton.on("keyPress", ({ key, ctrl, meta, shift }) => {
      if (cancelButton.state.value !== "focused") return;

      if (ctrl || meta || shift) return;

      switch (key) {
        case "tab":
          toggleFocus();
          break;
        case "left":
          okButton.state.value = "focused";
          break;
        case "space":
        case "escape":
        case "return":
          destroy();
          reject("Canceled");
          break;
      }
    });
    okButton.on("keyPress", ({ key, ctrl, meta, shift }) => {
      if (okButton.state.value !== "focused") return;

      if (ctrl || meta || shift) return;

      switch (key) {
        case "tab":
          toggleFocus();
          break;
        case "right":
          cancelButton.state.value = "focused";
          break;
        case "escape":
          destroy();
          reject("Canceled");
          break;
        case "space":
        case "return":
          destroy();
          resolve();
          break;
      }
    });
  });
};
