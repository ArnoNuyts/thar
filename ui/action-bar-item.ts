import { crayon } from "https://deno.land/x/crayon@3.3.3/mod.ts";
import { Key } from "https://deno.land/x/tui@2.1.11/src/input_reader/types.ts";
import {
  Component,
  ComponentOptions,
  Computed,
  Signal,
  signalify,
  Style,
  TextObject,
} from "https://deno.land/x/tui@2.1.11/mod.ts";

export interface ActionBarItemOptions {
  previousItem: Omit<ComponentOptions, "theme">;
  key: Key;
  description: string;
  callBack: () => void;
}

export class ActionBarItem extends Component {
  key: string;
  description: string;
  callBack: () => void;
  baseStyle = new Signal(crayon.bgBlack);

  constructor(options: ActionBarItemOptions) {
    const rectangle = new Computed(() => {
      const { width, column, height, row } =
        signalify(options.previousItem.rectangle).value;
      return {
        column: column + width + 2,
        height,
        row,
        width: options.key.length + options.description.length + 2,
      };
    });
    super(
      {
        ...options,
        zIndex: options.previousItem.zIndex,
        rectangle,
        parent: options.previousItem.parent,
      } as unknown as ComponentOptions,
    );
    this.key = options.key;
    this.description = options.description;
    this.callBack = options.callBack;
    this.on("mouseEvent", () => {
      this.baseStyle.value = crayon.bgBlue.lightYellow;
    });
  }

  override interact(method: "keyboard" | "mouse"): void {
    if (this.state.value !== "disabled") {
      this.callBack();
      super.interact(method);
    }
  }

  override draw(): void {
    const { canvas } = this.tui;

    const key = new TextObject({
      canvas,
      view: this.view,
      zIndex: this.zIndex.value + 1,
      style: new Computed(() => this.baseStyle.value.lightYellow as Style),
      value: this.key,
      rectangle: new Computed(() => {
        const { column, row } = this.rectangle.value;

        return {
          column: column,
          row: row,
        };
      }),
    });

    const description = new TextObject({
      canvas,
      view: this.view,
      zIndex: this.zIndex.value + 1,
      style: crayon.bgBlack.lightCyan,
      value: this.description,
      rectangle: new Computed(() => {
        const { column, row } = this.rectangle.value;

        return {
          column: column + this.key.length + 1,
          row: row,
        };
      }),
    });

    key.draw();
    description.draw();
    this.drawnObjects.key = key;
    this.drawnObjects.description = description;
  }
}
