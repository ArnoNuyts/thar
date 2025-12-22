import {
  addDays,
  addMonths,
  addWeeks,
  addYears,
  format,
  isBefore,
  isSameDay,
  parseISO,
  startOfDay,
} from "date-fns";
import { TodoStateEnum } from "../types/enums.ts";
import { UpperCaseLetter } from "../types/types.ts";

const TODO_REGEX =
  /^((?<done>[x])\s){0,1}(\((?<prio>[A-Z])\)\s){0,1}((?<completionDate>\d{4}-[0-1][0-9]-[0-3][0-9])\s){0,1}((?<creationDate>\d{4}-[0-1][0-9]-[0-3][0-9])\s){0,1}(?<rest>[^\n\r]+)\s*$/;
const PROJECT_REGEX = /(^|\s)\+(?<name>[\w.\_\-]+)/g;
const CONTEXT_REGEX = /(^|\s)\@(?<name>[\w.\_\-]+)/g;
const TAG_REGEX = /(^|\s)(?<key>[A-Za-z]+):(?<value>[^\s]+)/g;

export class Todo {
  readonly id: symbol;
  private _text: string = "";
  private _state: TodoStateEnum = TodoStateEnum.todo;
  private _completionDate: undefined | Date;
  private _creationDate: undefined | Date;
  private _priority: UpperCaseLetter | undefined;
  private _projects: Set<string> = new Set();
  private _contexts: Set<string> = new Set();
  private _tags: { [key: string]: string | string[] } = {};

  get text(): string {
    return this._text;
  }
  get state(): TodoStateEnum {
    return this._state;
  }
  get completionDate(): Date | undefined {
    return this._completionDate;
  }
  get creationDate(): Date | undefined {
    return this._creationDate;
  }
  get priority(): UpperCaseLetter | undefined {
    return this._priority;
  }
  get projects(): Set<string> {
    return this._projects;
  }
  get contexts(): Set<string> {
    return this._contexts;
  }
  get tags(): { [key: string]: string | string[] } {
    return this._tags;
  }

  constructor(text: string) {
    this.id = Symbol();
    const match = text.match(TODO_REGEX);
    if (match?.groups) {
      this._completionDate =
        match.groups.creationDate && match.groups.completionDate
          ? parseISO(match.groups.completionDate)
          : undefined;
      this._creationDate =
        match.groups.creationDate || match.groups.completionDate
          ? parseISO(match.groups.creationDate || match.groups.completionDate)
          : undefined;
      this._priority = match.groups.prio as UpperCaseLetter;
      text = match.groups.rest as string;
      this._state = match.groups.done ? TodoStateEnum.done : TodoStateEnum.todo;
    }
    this.internalParseText(text);
  }

  private clone(): Todo {
    const next = Object.create(Todo.prototype);
    Object.assign(next, this);
    next._projects = new Set(this._projects);
    next._contexts = new Set(this._contexts);
    next._tags = { ...this._tags };
    for (const key in next._tags) {
      if (Array.isArray(next._tags[key])) {
        next._tags[key] = [...(next._tags[key] as string[])];
      }
    }
    return next;
  }

  toggleState(): { updated: Todo; recurring?: Todo } {
    const next = this.clone();
    next._state = next._state == TodoStateEnum.todo
      ? TodoStateEnum.done
      : TodoStateEnum.todo;
    if (next._state === TodoStateEnum.done && next._creationDate) {
      next._completionDate = new Date();
    }
    if (next._state === TodoStateEnum.todo && next._completionDate) {
      next._completionDate = undefined;
    }

    if (next._state === TodoStateEnum.done && next._tags.rec) {
      const recurrence = next._tags.rec as string;
      let newTodo = new Todo(next.toString());
      newTodo = newTodo.setState(TodoStateEnum.todo);
      newTodo = newTodo.setCompletionDate(undefined);

      const regex = /(\d+)([dwmy])/;
      const match = recurrence.match(regex);
      if (match) {
        const amount = parseInt(match[1]);
        const unit = match[2];
        let newDueDate = new Date();
        /*if (this._tags.due) {
          newDueDate = parseISO(this._tags.due as string);
        }*/

        switch (unit) {
          case "d":
            newDueDate = addDays(newDueDate, amount);
            break;
          case "w":
            newDueDate = addWeeks(newDueDate, amount);
            break;
          case "m":
            newDueDate = addMonths(newDueDate, amount);
            break;
          case "y":
            newDueDate = addYears(newDueDate, amount);
            break;
        }
        newTodo = newTodo.setDue(newDueDate);
      }

      return { updated: next, recurring: newTodo };
    }

    return { updated: next };
  }
  toString() {
    return (this.isDone() ? "x " : "") +
      (this._priority ? `(${this._priority}) ` : "") +
      (this._completionDate
        ? format(this._completionDate, "yyyy-MM-dd") + " "
        : "") +
      (this._creationDate
        ? format(this._creationDate, "yyyy-MM-dd") + " "
        : "") +
      this._text +
      (Object.keys(this._tags).length > 0 ? " " : "") +
      (Object.keys(this._tags).map((k) => k + ":" + this._tags[k]).join(" "));
  }
  setPriority(key?: UpperCaseLetter): Todo {
    const next = this.clone();
    next._priority = key;
    return next;
  }

  setCreationDate(date: Date): Todo {
    const next = this.clone();
    next._creationDate = date;
    return next;
  }

  setCompletionDate(date: Date | undefined): Todo {
    const next = this.clone();
    next._completionDate = date;
    return next;
  }

  setState(state: TodoStateEnum): Todo {
    const next = this.clone();
    next._state = state;
    return next;
  }

  isDone() {
    return this._state == TodoStateEnum.done;
  }

  isHidden() {
    return !!this._tags["h"] && this._tags["h"] !== "0";
  }

  isVisibleInOverview() {
    return !this.isHidden() && this.isPassedThreshold();
  }

  isOverdue() {
    if (typeof this._tags.due !== "string") return false;
    const dueDate = startOfDay(parseISO(this._tags.due));
    const today = startOfDay(new Date());
    // isOverdue returns true if today >= dueDate
    return isSameDay(today, dueDate) || isBefore(dueDate, today);
  }

  isPassedThreshold() {
    if (typeof this._tags.t !== "string") return true;
    const thresholdDate = startOfDay(parseISO(this._tags.t));
    const today = startOfDay(new Date());
    return isSameDay(today, thresholdDate) || isBefore(thresholdDate, today);
  }

  setText(text: string): Todo {
    const next = this.clone();
    next.internalParseText(text);
    return next;
  }

  private internalParseText(text: string) {
    this._projects.clear();

    const matchProjects = text.matchAll(PROJECT_REGEX);
    for (const project of matchProjects) {
      this._projects.add(project.groups!.name);
    }

    this._contexts.clear();
    const matchContexts = text.matchAll(CONTEXT_REGEX);
    for (const context of matchContexts) {
      this._contexts.add(context.groups!.name);
    }

    const matchTags = text.matchAll(TAG_REGEX);
    for (const tag of matchTags) {
      switch (typeof this._tags[tag.groups!.key]) {
        case "object":
          this._tags[tag.groups!.key] = [
            ...(this._tags[tag.groups!.key] as string[]),
            tag.groups!.value,
          ];
          break;
        case "string":
          this._tags[tag.groups!.key] = [
            this._tags[tag.groups!.key] as string,
            tag.groups!.value,
          ];
          break;
        default:
          this._tags[tag.groups!.key] = tag.groups!.value;
      }
      text = text.replace(tag[0], "");
    }
    this._text = text.trim();
  }

  setRecurrence(recurrence: string): Todo {
    const next = this.clone();
    next._tags.rec = recurrence;
    return next;
  }

  removeRecurrence(): Todo {
    const next = this.clone();
    delete next._tags.rec;
    return next;
  }

  setDue(date: Date): Todo {
    const next = this.clone();
    next._tags.due = format(date, "yyyy-MM-dd");
    return next;
  }

  setThreshold(date: Date): Todo {
    const next = this.clone();
    next._tags.t = format(date, "yyyy-MM-dd");
    return next;
  }

  removeDue(): Todo {
    const next = this.clone();
    delete next._tags.due;
    return next;
  }

  removeThreshold(): Todo {
    const next = this.clone();
    delete next._tags.t;
    return next;
  }

  toggleHidden(): Todo {
    const next = this.clone();
    if (next._tags.h && next._tags.h !== "0") {
      delete next._tags.h;
    } else {
      next._tags.h = "1";
    }
    return next;
  }

  getHash(): string {
    return this.toString();
  }
}
