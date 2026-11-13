import { isBefore, isSameDay, isValid, startOfDay } from "date-fns";
import { TodoStateEnum } from "../types/enums.ts";
import { UpperCaseLetter } from "../types/types.ts";
import {
  formatDateTag,
  isValidTodoDate,
  parseDateTag,
  scanTodoPrefix,
} from "./dates.ts";
import { CONTEXT_REGEX, PROJECT_REGEX } from "./patterns.ts";
import { isValidRecurrence, planRecurrence } from "./recurrence.ts";

export { isValidRecurrence, MAX_RECURRENCE_AMOUNT } from "./recurrence.ts";

const TAG_REGEX = /(^|\s)(?<key>[A-Za-z]+):(?<value>[^\s]+)/g;

let nextTodoId = 0;

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
  private _datesInText = false;
  /**
   * True when `_completionDate` is already present as the leading literal
   * token in `_text` (an invalid/ambiguous done line keeps its dates in text).
   * Serialization must then not prepend the same date again.
   */
  private _completionDateInText = false;

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
    this.id = Symbol(String(nextTodoId++));
    const prefix = scanTodoPrefix(text);
    this._state = prefix.hasDoneMarker
      ? TodoStateEnum.done
      : TodoStateEnum.todo;
    this._priority = prefix.priority as UpperCaseLetter | undefined;

    const dateSection = text.slice(prefix.dateStartIndex);
    const remainder = text.slice(prefix.endIndex);
    const hasBody = remainder.trim().length > 0;
    const canConsumeDates =
      prefix.dateTokens.length > 0 &&
      prefix.invalidDateTokens.length === 0 &&
      hasBody &&
      (prefix.hasDoneMarker || prefix.dateTokens.length === 1);

    if (canConsumeDates) {
      if (prefix.hasDoneMarker) {
        // For completed todos, the first date is the completion date and an
        // optional second date is the creation date.
        this._completionDate = parseDateTag(prefix.dateTokens[0]);
        this._creationDate = parseDateTag(prefix.dateTokens[1]);
      } else {
        // Without the `x` marker the first date is a creation date.
        this._creationDate = parseDateTag(prefix.dateTokens[0]);
      }
      text = remainder;
    } else {
      text = dateSection;
      if (prefix.dateTokens.length > 0) {
        // Invalid or ambiguous leading dates stay in the body text so the
        // line round-trips. Valid date fields are still exposed when their
        // position is unambiguous (a completed line).
        this._datesInText = true;
        if (prefix.hasDoneMarker) {
          this._completionDate = parseDateTag(prefix.dateTokens[0]);
          this._completionDateInText = this._completionDate !== undefined;
          this._creationDate = parseDateTag(prefix.dateTokens[1]);
        } else if (
          prefix.dateTokens.length === 1 &&
          prefix.invalidDateTokens.length === 0
        ) {
          this._creationDate = parseDateTag(prefix.dateTokens[0]);
        }
      }
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

  toggleState(): {
    updated: Todo;
    recurring?: Todo;
    recurrenceError?: string;
  } {
    const next = this.with((next) => {
      next._state =
        next._state == TodoStateEnum.todo
          ? TodoStateEnum.done
          : TodoStateEnum.todo;
      if (next._state === TodoStateEnum.done) {
        // Completing always records today, even when the line had no creation
        // date or kept its dates as literal text.
        next._completionDate = new Date();
        next._completionDateInText = false;
      } else if (next._completionDate) {
        next._completionDate = undefined;
        next._completionDateInText = false;
      }
    });

    if (next._state === TodoStateEnum.done && next._tags.rec) {
      const plan = planRecurrence(next._tags.rec, new Date());
      if ("error" in plan) {
        return { updated: next, recurrenceError: plan.error };
      }

      const newTodo = new Todo(next.toString())
        .setState(TodoStateEnum.todo)
        .setCompletionDate(undefined)
        .setDue(plan.nextDue);

      return { updated: next, recurring: newTodo };
    }

    return { updated: next };
  }
  toString() {
    return (
      (this.isDone() ? "x " : "") +
      (this._priority ? `(${this._priority}) ` : "") +
      (!this._completionDateInText &&
      this._completionDate &&
      isValid(this._completionDate)
        ? formatDateTag(this._completionDate) + " "
        : "") +
      (!this._datesInText && this._creationDate && isValid(this._creationDate)
        ? formatDateTag(this._creationDate) + " "
        : "") +
      this._text +
      (Object.keys(this._tags).length > 0 ? " " : "") +
      Object.keys(this._tags)
        .map((k) => k + ":" + this._tags[k])
        .join(" ")
    );
  }
  setPriority(key?: UpperCaseLetter): Todo {
    return this.with((next) => {
      next._priority = key;
    });
  }

  setCreationDate(date: Date): Todo {
    if (!isValidTodoDate(date)) return this;
    return this.with((next) => {
      next._creationDate = date;
    });
  }

  setCompletionDate(date: Date | undefined): Todo {
    if (date !== undefined && !isValidTodoDate(date)) return this;
    return this.with((next) => {
      next._completionDate = date;
      next._completionDateInText = false;
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
    for (const tag of text.matchAll(TAG_REGEX)) {
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
    }
    // Remove every tag token in one pass. Replacing per tag is quadratic on
    // lines with many tags.
    text = text.replace(TAG_REGEX, "");
    // Tags in the supplied text are authoritative unless the caller explicitly
    // preserves programmatic metadata (project/context edits re-parse text
    // that has had its tags stripped).
    this._tags = preserveTags ? { ...this._tags, ...parsedTags } : parsedTags;
    this._text = text.trim();
  }

  setRecurrence(recurrence: string): Todo {
    if (!isValidRecurrence(recurrence)) return this;
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
    if (!isValidTodoDate(date)) return this;
    return this.with((next) => {
      next._tags.due = formatDateTag(date);
    });
  }

  setThreshold(date: Date): Todo {
    if (!isValidTodoDate(date)) return this;
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
