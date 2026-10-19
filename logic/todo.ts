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
import { formatDateTag, parseDateTag } from "./dates.ts";
import { CONTEXT_REGEX, PROJECT_REGEX } from "./patterns.ts";

const TODO_REGEX =
  /^((?<done>[x])\s){0,1}(\((?<prio>[A-Z])\)\s){0,1}((?<completionDate>\d{4}-[0-1][0-9]-[0-3][0-9])\s){0,1}((?<creationDate>\d{4}-[0-1][0-9]-[0-3][0-9])\s){0,1}(?<rest>[^\n\r]+)\s*$/;
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
      if (match.groups.done) {
        // For completed todos, the first date is the completion date and an
        // optional second date is the creation date.
        this._completionDate = match.groups.completionDate
          ? parseISO(match.groups.completionDate)
          : undefined;
        this._creationDate = match.groups.creationDate
          ? parseISO(match.groups.creationDate)
          : undefined;
      } else {
        // Without the `x` marker the first date is a creation date.
        this._completionDate = undefined;
        this._creationDate =
          match.groups.creationDate || match.groups.completionDate
            ? parseISO(match.groups.creationDate || match.groups.completionDate)
            : undefined;
      }
      this._priority = match.groups.prio as UpperCaseLetter;
      text = match.groups.rest as string;
      this._state = match.groups.done ? TodoStateEnum.done : TodoStateEnum.todo;
    }
    this.internalParseText(text);
  }

  /**
   * Returns an independent copy of this todo with `mutate` applied to it.
   * All setters go through this helper, so callers always get a new todo with
   * its own projects, contexts, and tags (including array-valued tags), and
   * the receiver is never modified.
   */
  private with(mutate: (next: Todo) => void): Todo {
    const next = this.clone();
    mutate(next);
    return next;
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
    const next = this.with((next) => {
      next._state = next._state == TodoStateEnum.todo
        ? TodoStateEnum.done
        : TodoStateEnum.todo;
      if (next._state === TodoStateEnum.done && next._creationDate) {
        next._completionDate = new Date();
      }
      if (next._state === TodoStateEnum.todo && next._completionDate) {
        next._completionDate = undefined;
      }
    });

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
    return this.with((next) => {
      next._priority = key;
    });
  }

  setCreationDate(date: Date): Todo {
    return this.with((next) => {
      next._creationDate = date;
    });
  }

  setCompletionDate(date: Date | undefined): Todo {
    return this.with((next) => {
      next._completionDate = date;
    });
  }

  setState(state: TodoStateEnum): Todo {
    return this.with((next) => {
      next._state = state;
    });
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
    const dueDate = parseDateTag(this._tags.due);
    // A missing or malformed due tag means the todo is not overdue.
    if (!dueDate) return false;
    const today = startOfDay(new Date());
    // isOverdue returns true if today >= dueDate
    return isSameDay(today, dueDate) || isBefore(dueDate, today);
  }

  isPassedThreshold() {
    const thresholdDate = parseDateTag(this._tags.t);
    // A missing or malformed threshold tag does not hide the todo.
    if (!thresholdDate) return true;
    const today = startOfDay(new Date());
    return isSameDay(today, thresholdDate) || isBefore(thresholdDate, today);
  }

  setText(text: string, options: { preserveTags?: boolean } = {}): Todo {
    return this.with((next) => {
      next.internalParseText(text, options.preserveTags);
    });
  }

  private internalParseText(text: string, preserveTags = false) {
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

    const parsedTags: { [key: string]: string | string[] } = {};
    const matchTags = text.matchAll(TAG_REGEX);
    for (const tag of matchTags) {
      const key = tag.groups!.key;
      const value = tag.groups!.value;
      const current = parsedTags[key];
      if (Array.isArray(current)) {
        current.push(value);
      } else if (typeof current === "string") {
        parsedTags[key] = [current, value];
      } else {
        parsedTags[key] = value;
      }
      text = text.replace(tag[0], "");
    }
    // Tags in the supplied text are authoritative unless the caller explicitly
    // preserves programmatic metadata (project/context edits re-parse text
    // that has had its tags stripped).
    this._tags = preserveTags ? { ...this._tags, ...parsedTags } : parsedTags;
    this._text = text.trim();
  }

  setRecurrence(recurrence: string): Todo {
    return this.with((next) => {
      next._tags.rec = recurrence;
    });
  }

  removeRecurrence(): Todo {
    return this.with((next) => {
      delete next._tags.rec;
    });
  }

  setDue(date: Date): Todo {
    return this.with((next) => {
      next._tags.due = formatDateTag(date);
    });
  }

  setThreshold(date: Date): Todo {
    return this.with((next) => {
      next._tags.t = formatDateTag(date);
    });
  }

  removeDue(): Todo {
    return this.with((next) => {
      delete next._tags.due;
    });
  }

  removeThreshold(): Todo {
    return this.with((next) => {
      delete next._tags.t;
    });
  }

  toggleHidden(): Todo {
    return this.with((next) => {
      if (next._tags.h && next._tags.h !== "0") {
        delete next._tags.h;
      } else {
        next._tags.h = "1";
      }
    });
  }

  addContext(context: string): Todo {
    if (this._contexts.has(context)) {
      return this;
    }
    return this.setText(`${this._text} @${context}`, { preserveTags: true });
  }

  removeContext(context: string): Todo {
    if (!this._contexts.has(context)) {
      return this;
    }
    // Remove @context from text (with optional leading space)
    const regex = new RegExp(`\\s*@${context}(?=\\s|$)`, "g");
    return this.setText(this._text.replace(regex, "").trim(), {
      preserveTags: true,
    });
  }

  addProject(project: string): Todo {
    if (this._projects.has(project)) {
      return this;
    }
    return this.setText(`${this._text} +${project}`, { preserveTags: true });
  }

  removeProject(project: string): Todo {
    if (!this._projects.has(project)) {
      return this;
    }
    // Remove +project from text (with optional leading space)
    const regex = new RegExp(`\\s*\\+${project}(?=\\s|$)`, "g");
    return this.setText(this._text.replace(regex, "").trim(), {
      preserveTags: true,
    });
  }

  getHash(): string {
    return this.toString();
  }
}
