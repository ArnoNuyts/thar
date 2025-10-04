import { crayon } from "https://deno.land/x/crayon@3.3.3/mod.ts";
import {
  Component,
  Computed,
  Signal,
  SignalOfObject,
  TextObject,
  TextRectangle,
} from "https://deno.land/x/tui@2.1.11/mod.ts";

export interface TodoActionMenuTitleItemOptions {
  parent: Component;
  zIndex: Signal<number>;
  row: Computed<number>;
  description: string;
}

export class TodoActionMenuTitleItem extends Component {
  description: string;

  constructor(options: TodoActionMenuTitleItemOptions) {
    const rectangle = new Computed(() => ({
      column: options.parent.rectangle.value.column + 7,
      height: 1,
      row: options.row.value,
      width: options.parent.rectangle.value.width - 2,
    }));

    super({
      parent: options.parent,
      zIndex: options.zIndex,
      rectangle,
      theme: {},
    });
    this.description = options.description;
  }

  override draw(): void {
    super.draw();
    const { canvas } = this.tui;

    const description = new TextObject({
      canvas,
      view: this.view,
      zIndex: this.zIndex.value + 1,
      style: crayon.bgYellow.black,
      value: new Computed(() => {
        const text = ` ${this.description} `;
        return text
      }),
      rectangle: this.rectangle as unknown as SignalOfObject<TextRectangle>,
    });

    description.draw();
    this.drawnObjects.description = description;
  }
}
