import { crayon } from "https://deno.land/x/crayon@3.3.3/mod.ts";
import { Tui, handleInput } from "https://deno.land/x/tui@2.1.11/mod.ts";
import { Input } from "https://deno.land/x/tui@2.1.11/src/components/input.ts";

const tui = new Tui({
  style: crayon.bgBlack, // Make background black
  refreshRate: 1000 / 60, // Run in 60FPS
});

handleInput(tui);
tui.dispatch();
tui.run();



const input = new Input({
  parent: tui,
  rectangle: {
    width: tui.rectangle.value.width,
    column: 0,
    row: 0,
  },
  theme: {
    cursor: {
      base: crayon.bgWhite.blink,
    }
  },
  placeholder: "Type éèàçëêâë to simulate issue",
  zIndex: 1,
  multiCodePointSupport: true,
});

input.state.value = "focused";