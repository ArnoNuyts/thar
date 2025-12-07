import { TodoStateEnum } from "../types/enums.ts";
import { UpperCaseLetter } from "../types/types.ts";

const TODO_REGEX =
  /^((?<done>[x])\s){0,1}(\((?<prio>[A-Z])\)\s){0,1}((?<completionDate>\d{4}-[0-1][0-9]-[0-3][0-9])\s){0,1}((?<creationDate>\d{4}-[0-1][0-9]-[0-3][0-9])\s){0,1}(?<rest>[^\n\r]+)\s*$/;
const PROJECT_REGEX = /(^|\s)\+(?<name>[\w.\_\-]+)/g;
const CONTEXT_REGEX = /(^|\s)\@(?<name>[\w.\_\-]+)/g;
const TAG_REGEX = /(^|\s)(?<key>[A-Za-z]+):(?<value>[^\s]+)/g;

export class Todo {
  readonly id = Symbol();
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
    const match = text.match(TODO_REGEX);
    if (match?.groups) {
      this._completionDate =
        match.groups.creationDate && match.groups.completionDate
          ? new Date(match.groups.completionDate)
          : undefined;
      this._creationDate =
        match.groups.creationDate || match.groups.completionDate
          ? new Date(match.groups.creationDate || match.groups.completionDate)
          : undefined;
      this._priority = match.groups.prio as UpperCaseLetter;
      text = match.groups.rest as string;
      this._state = match.groups.done ? TodoStateEnum.done : TodoStateEnum.todo;
    }
    this.setText(text);
  }
  toggleState() {
    this._state = this._state == TodoStateEnum.todo
      ? TodoStateEnum.done
      : TodoStateEnum.todo;
    if (this._state === TodoStateEnum.done && this._creationDate) {
      this._completionDate = new Date();
    }
    if (this._state === TodoStateEnum.todo && this._completionDate) {
      this._completionDate = undefined;
    }

    if (this._state === TodoStateEnum.done && this._tags.rec) {
      const recurrence = this._tags.rec as string;
      const newTodo = new Todo(this.toString());
      newTodo._state = TodoStateEnum.todo;
      newTodo._completionDate = undefined;

      const regex = /(\d+)([dwmy])/;
      const match = recurrence.match(regex);
      if (match) {
        const amount = parseInt(match[1]);
        const unit = match[2];
        const newDueDate = new Date();
        /*if (this._tags.due) {
          newDueDate = new Date(this._tags.due as string);
        }*/

        switch (unit) {
          case "d":
            newDueDate.setDate(newDueDate.getDate() + amount);
            break;
          case "w":
            newDueDate.setDate(newDueDate.getDate() + amount * 7);
            break;
          case "m":
            newDueDate.setMonth(newDueDate.getMonth() + amount);
            break;
          case "y":
            newDueDate.setFullYear(newDueDate.getFullYear() + amount);
            break;
        }
        newTodo.setDue(newDueDate);
      }

      return newTodo;
    }
  }
  toString() {
    return (this.isDone() ? "x " : "") +
      (this._priority ? `(${this._priority}) ` : "") +
      (this._completionDate
        ? this._completionDate!.toISOString().substring(0, 10) + " "
        : "") +
      (this._creationDate
        ? this._creationDate!.toISOString().substring(0, 10) + " "
        : "") +
      this._text +
      (Object.keys(this._tags).length > 0 ? " " : "") +
      (Object.keys(this._tags).map((k) => k + ":" + this._tags[k]).join(" "));
  }
  setPriority(key?: UpperCaseLetter) {
    this._priority = key;
  }

  setCreationDate(date: Date) {
    this._creationDate = date;
  }

  setCompletionDate(date: Date | undefined) {
    this._completionDate = date;
  }

  setState(state: TodoStateEnum) {
    this._state = state;
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
    return typeof this._tags.due === "string" &&
      new Date() > new Date(this._tags.due);
  }

  isPassedThreshold() {
    return typeof this._tags.t !== "string" ||
      new Date() >= new Date(this._tags.t);
  }

  setText(text: string) {
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
            ...this._tags[tag.groups!.key],
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
    this._text = text;
  }

  setRecurrence(recurrence: string): void {
    this._tags.rec = recurrence;
  }

  setDue(date: Date): void {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    this._tags.due = `${year}-${month}-${day}`;
  }

  setThreshold(date: Date): void {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    this._tags.t = `${year}-${month}-${day}`;
  }

  removeDue(): void {
    delete this._tags.due;
  }

  removeThreshold(): void {
    delete this._tags.t;
  }

  toggleHidden(): void {
    if (this._tags.h && this._tags.h !== "0") {
      delete this._tags.h;
    } else {
      this._tags.h = "1";
    }
  }

  getHash(): string {
    return this.toString();
  }
}
