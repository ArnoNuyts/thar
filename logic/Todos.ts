import { Todo } from "./todo.ts";

export type Todos = Todo[];

const firstContext = (todo: Todo): string | undefined =>
  todo.contexts.values().next().value;

/**
 * Orders todos by:
 *  1. state (open before done)
 *  2. first context (uncontextualised first, then alphabetical)
 *  3. overdue first
 *  4. priority (unprioritised last, then alphabetical)
 *
 * Todos that compare equal keep their original relative order.
 */
export const sortByImportance = (todos: Todo[]): Todo[] =>
  [...todos].sort((a, b) => {
    if (a.state !== b.state) {
      return a.state - b.state;
    }

    const aContext = firstContext(a);
    const bContext = firstContext(b);
    if (aContext === undefined && bContext !== undefined) return -1;
    if (aContext !== undefined && bContext === undefined) return 1;
    if (aContext !== undefined && bContext !== undefined) {
      const byContext = aContext.localeCompare(bContext);
      if (byContext !== 0) return byContext;
    }

    const overdue = (b.isOverdue() ? 1 : 0) - (a.isOverdue() ? 1 : 0);
    if (overdue !== 0) return overdue;

    if (a.priority === undefined && b.priority !== undefined) return 1;
    if (a.priority !== undefined && b.priority === undefined) return -1;
    if (a.priority !== undefined && b.priority !== undefined) {
      return a.priority.localeCompare(b.priority);
    }

    return 0;
  });

export const filterHidden = (todos: Todo[]): Todo[] =>
  todos.filter((todo) => todo.isVisibleInOverview());
