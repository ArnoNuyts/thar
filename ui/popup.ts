import { crayon } from "https://deno.land/x/crayon@3.3.3/mod.ts";
import {
  clamp,
  Component,
  ComponentOptions,
  Computed,
} from "https://deno.land/x/tui@2.1.11/mod.ts";
import { Box } from "https://deno.land/x/tui@2.1.11/src/components/box.ts";
import { Frame } from "https://deno.land/x/tui@2.1.11/src/components/frame.ts";
import { Text } from "https://deno.land/x/tui@2.1.11/src/components/text.ts";

export interface PopupOptions
  extends Omit<ComponentOptions, "theme" | "rectangle"> {
  title: string;
  rectangle: {
    height: number;
  };
}

export class Popup extends Component {
  title: string;
  constructor(options: PopupOptions) {
    super({
      ...options,
      theme: { base: crayon.bgBlack.white },
      rectangle: new Computed(() => {
        let width = clamp(
          clamp(options.parent.rectangle.value.width / 2, 20, 60),
          0,
          options.parent.rectangle.value.width,
        );
        if (width % 2 !== 0) {
          // Adjust the value to make it even
          width = Math.floor(width / 2) * 2; // Rounds down to nearest even number
        }

        return {
          column: Math.floor(
            (options.parent.rectangle.value.width - width) / 2,
          ),
          row: Math.floor(
            (options.parent.rectangle.value.height - options.rectangle.height) /
              2,
          ),
          height: options.rectangle.height,
          width: width,
        };
      }),
    });

    this.title = options.title;

    const box = new Box({
      parent: this,
      theme: {
        base: crayon.bgBlack.white,
      },
      rectangle: this.rectangle,
      zIndex: this.zIndex,
    });

    const frame = new Frame({
      parent: box,
      charMap: "sharp",
      theme: {
        base: crayon.bgBlack.white,
      },
      rectangle: this.rectangle,
      zIndex: this.zIndex,
    });

    const titleLabel = new Text({
      parent: box,
      text: `| ${this.title} |`,
      theme: {
        base: crayon.bgBlack.white,
      },
      rectangle: new Computed(() => ({
        column: this.rectangle.value.column + 2,
        row: this.rectangle.value.row - 1,
      })),
      zIndex: new Computed(() => this.zIndex.value + 1),
    });
    this.subComponents = { ...this.subComponents, titleLabel, frame, box };
  }
  override destroy(): void {
    super.destroy();
    this.subComponents.titleLabel.destroy();
    this.subComponents.frame.destroy();
    this.subComponents.box.destroy();
  }
}
