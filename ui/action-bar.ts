import { crayon } from "https://deno.land/x/crayon@3.3.3/mod.ts";
import {
  Component,
  ComponentOptions,
  Computed,
  TextObject,
} from "https://deno.land/x/tui@2.1.11/mod.ts";
import { ActionBarItem } from "./action-bar-item.ts";

export interface ActionBarOptions extends Omit<ComponentOptions, "theme"> {
  editCallback: () => Promise<void>;
  dueCallback: () => void;
  thresholdCallback: () => void;
  deleteCallback: () => void;
  toggleHiddenCallback: () => void;
  newCallback: () => void;
  archiveCallback: () => void;
  openActionsMenuCallback: () => void;
}

export class ActionBar extends Component {
  editCallback: () => void;
  dueCallback: () => void;
  thresholdCallback: () => void;
  deleteCallback: () => void;
  toggleHiddenCallback: () => void;
  newCallback: () => void;
  archiveCallback: () => void;
  openActionsMenuCallback: () => void;

  constructor(options: ActionBarOptions) {
    super(options as unknown as ComponentOptions);
    this.editCallback = options.editCallback;
    this.dueCallback = options.dueCallback;
    this.thresholdCallback = options.thresholdCallback;
    this.deleteCallback = options.deleteCallback;
    this.toggleHiddenCallback = options.toggleHiddenCallback;
    this.newCallback = options.newCallback;
    this.archiveCallback = options.archiveCallback;
    this.openActionsMenuCallback = options.openActionsMenuCallback;

    this.state.subscribe((state) => {
      Object.keys(this.subComponents).forEach((key) =>
        this.subComponents[key].state.value = state
      );
    });
  }

  override draw(): void {
    super.draw();

    const { canvas } = this.tui;

    const line = new TextObject({
      canvas,
      view: this.view,
      zIndex: this.zIndex.value + 1,
      style: crayon.bgBlack.white.dim,
      value: new Computed(() => "┈".repeat(this.rectangle.value.width)),
      rectangle: new Computed(() => {
        const { column, row } = this.rectangle.value;

        return {
          column: column,
          row: row,
        };
      }),
    });

    const menu = new ActionBarItem({
      callBack: this.openActionsMenuCallback,
      previousItem: { // This is a dummy previous item to position the first item
        rectangle: new Computed(() => {
          const { row } = this.rectangle.value;
          return {
            row: row + 1,
            column: 0,
            width: 0,
            height: 1,
          };
        }),
        zIndex: this.zIndex,
        parent: this,
      },
      key: "x",
      description: "Menu",
    });

    const quit = new ActionBarItem({
      callBack: () => Deno.exit(),
      previousItem: menu,
      key: "q",
      description: "Quit",
    });

    const newItem = new ActionBarItem({
      callBack: this.newCallback,
      previousItem: quit,
      key: "n",
      description: "New",
    });

    const edit = new ActionBarItem({
      callBack: this.editCallback,
      previousItem: newItem,
      key: "e",
      description: "Edit",
    });

    const archive = new ActionBarItem({
      callBack: this.archiveCallback,
      previousItem: edit,
      key: "a",
      description: "Archive",
    });

    menu.draw();
    line.draw();
    quit.draw();
    newItem.draw();
    edit.draw();
    archive.draw();

    this.drawnObjects.line = line;
    this.subComponents.menu = menu;
    this.subComponents.newItem = newItem;
    this.subComponents.quit = quit;
    this.subComponents.edit = edit;
    this.subComponents.archive = archive;
  }
}
