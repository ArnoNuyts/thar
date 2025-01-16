import { Todo } from "./todo.ts";

export class Todos extends Array<Todo> {
  sortByImportance = (): Todos =>
    new Todos(...this)
      .sort((a, b) => {
        if (a.priority === undefined && b.priority === undefined) {
          return 0;
        }
        if (a.priority === undefined) {
          return 1;
        }
        if (b.priority === undefined) {
          return -1;
        }
        return a.priority.localeCompare(b.priority);
      })
      .sort((a, b) => (b.isOverdue() ? 1 : 0) - (a.isOverdue() ? 1 : 0))
      .sort((a, b) => {
        const aContext = [...a.contexts][0];
        const bContext = [...b.contexts][0];
        if (aContext === undefined && bContext === undefined) {
          return 0;
        }
        if (aContext === undefined) {
          return -1;
        }
        if (bContext === undefined) {
          return 1;
        }
        return aContext.localeCompare(bContext);
      })
      .sort((a, b) => a.state - b.state) as Todos;
  filterHidden = () =>
    new Todos(...this.filter((todo) => todo.isVisibleInOverview()));
}
