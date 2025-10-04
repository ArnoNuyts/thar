import { crayon } from "https://deno.land/x/crayon@3.3.3/mod.ts";
import {
  Component,
  Computed,
  Signal,
  Style,
  TextObject
} from "https://deno.land/x/tui@2.1.11/mod.ts";

export interface TodoActionMenuItemOptions {
  parent: Component;
  zIndex: Signal<number>;
  row: Computed<number>;
  key: string;
  description: string;
  callBack: () => void;
}

export class TodoActionMenuItem extends Component {
  key: string;
  description: string;
  callBack: () => void;
  baseStyle = new Signal(crayon.bgBlack);

  constructor(options: TodoActionMenuItemOptions) {
    const rectangle = new Computed(() => (
       {
        column: options.parent.rectangle.value.column + 1,
        height: 1,
        row: options.row.value,
        width: options.key.length + options.description.length + 2,
      }));

    super(
      {
        parent: options.parent,
        zIndex: options.zIndex,
        rectangle,
        theme: {}
      } ,
    );
    this.key = options.key;
    this.description = options.description;
    this.callBack = options.callBack;

  }

  override draw(): void {

    super.draw();

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

