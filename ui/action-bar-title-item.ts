import { crayon } from "https://deno.land/x/crayon@3.3.3/mod.ts";
import {
  Component,
  ComponentOptions,
  Computed,
  Signal,
  signalify,
  TextObject,
} from "https://deno.land/x/tui@2.1.11/mod.ts";

export interface ActionBarTitleItemOptions {
  previousItem: Omit<ComponentOptions, "theme">;
  description: string;
}

export class ActionBarTitleItem extends Component {
  description: string;
  baseStyle = new Signal(crayon.bgYellow.black);

  constructor(options: ActionBarTitleItemOptions) {
    const rectangle = new Computed(() => {
      const { width, column, height, row } =
        signalify(options.previousItem.rectangle).value;
      return {
        column: column + width + 2,
        height,
        row,
        width: options.description.length + 2,
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
    this.description = options.description;
  }

  override draw(): void {
    const { canvas } = this.tui;

    const description = new TextObject({
      canvas,
      view: this.view,
      zIndex: this.zIndex.value + 1,
      style: this.baseStyle.value,
      value: ` ${this.description} `,
      rectangle: new Computed(() => {
        const { column, row } = this.rectangle.value;

        return {
          column: column,
          row: row,
        };
      }),
    });

    description.draw();
    this.drawnObjects.description = description;
  }
}