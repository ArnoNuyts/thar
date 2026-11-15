import { formatDateTag, parseDateTag } from "../../logic/dates.ts";
import { getReadLimits } from "../../logic/limits.ts";
import { Todo } from "../../logic/todo.ts";
import { serializeTodosForWrite } from "../../logic/todo-file-helpers.ts";
import { validateTodoFileContent } from "../../logic/todo-file-validation.ts";
import { TodoStateEnum } from "../../types/enums.ts";
import type { ContractTodo } from "./types.ts";

/**
 * The parse/serialize adapter the contract is built through.
 *
 * The unmutated adapter calls exactly the production load and write paths:
 *
 * - parse: `validateTodoFileContent(...).filter(trim).map(new Todo)`
 * - serialize: `serializeTodosForWrite(todos)` (`writeTodosToFile`'s serializer,
 *   including its write-time control-character guard)
 *
 * Seeded bugs are applied *here* (never by editing `logic/**` at runtime) so
 * the self-test can prove the comparator catches a wrong candidate. Each
 * mutation simulates a specific mistake a Rust port could make.
 */
export type MutationName =
  | "drop-done-marker"
  | "accept-invalid-date"
  | "collapse-duplicate-tags"
  | "ignore-hidden"
  | "reorder-tags";

export const MUTATION_NAMES: readonly MutationName[] = [
  "drop-done-marker",
  "accept-invalid-date",
  "collapse-duplicate-tags",
  "ignore-hidden",
  "reorder-tags",
];

export interface MutationDescription {
  /** What a candidate with this bug would do. */
  description: string;
  /** Fixture and field the self-test expects the comparator to report. */
  proof: { fixture: string; path: string };
}

/** Documented in `tools/port/README.md`; also printed by `--list-mutations`. */
export const MUTATIONS: Record<MutationName, MutationDescription> = {
  "drop-done-marker": {
    description:
      "serializes a completed todo without its leading `x ` marker while " +
      "still parsing the done state (a port that forgets to write the marker)",
    proof: { fixture: "crlf.txt", path: "serialized.sha256" },
  },
  "accept-invalid-date": {
    description:
      "rolls an impossible leading calendar date forward (2023-02-29 -> " +
      "2023-03-01) instead of leaving the token literal (a port with a lenient " +
      "date parser)",
    proof: {
      fixture: "leading-dates-done-invalid.txt",
      path: "todos[0].text",
    },
  },
  "collapse-duplicate-tags": {
    description:
      "serializes an array-valued duplicate tag with only its first value " +
      "(`beta:one,two` -> `beta:one`) while keeping the parsed array",
    proof: { fixture: "due-threshold-hidden.txt", path: "serialized.sha256" },
  },
  "ignore-hidden": {
    description:
      "reports `isHidden: false` and derives `isVisibleInOverview` only from " +
      "the threshold tag, ignoring `h:` (a port that drops the hidden rule)",
    proof: { fixture: "due-threshold-hidden.txt", path: "todos[7].isHidden" },
  },
  "reorder-tags": {
    description:
      "serializes the tags of a line in reverse key order (a port that keeps " +
      "tags in a map instead of insertion order)",
    proof: { fixture: "due-threshold-hidden.txt", path: "serialized.sha256" },
  },
};

export const isMutationName = (value: string): value is MutationName =>
  (MUTATION_NAMES as readonly string[]).includes(value);

export interface ContractAdapter {
  /** Parse raw file bytes exactly like the production reader. */
  parse(raw: Buffer): Todo[];
  /** Serialize one todo as the write path would. */
  serializeLine(todo: Todo): string;
  /** Serialize a todo list as the write path would. */
  serialize(todos: Todo[]): string;
  /** Build the contract record for one parsed todo. */
  record(todo: Todo): ContractTodo;
}

const DONE_PREFIX = /^x\s+/;
const PRIORITY_PREFIX = /^\([A-Z]\)\s+/;
const LEADING_DATE = /^(\d{4}-\d{2}-\d{2})(?=\s|$)/;
const WHITESPACE_PREFIX = /^\s+/;

/** Roll an impossible `yyyy-MM-dd` forward the way a lenient parser would. */
const rollForwardDate = (token: string): string => {
  const [year, month, day] = token.split("-").map((part) => Number(part));
  const rolled = new Date(year, month - 1, day);
  return formatDateTag(rolled);
};

/**
 * Rewrite invalid leading date tokens to rolled-forward dates. Only used by
 * the `accept-invalid-date` mutation.
 */
const rollForwardLeadingDates = (line: string): string => {
  let prefix = "";
  let rest = line;

  const done = DONE_PREFIX.exec(rest);
  if (done) {
    prefix += done[0];
    rest = rest.slice(done[0].length);
  }

  const priority = PRIORITY_PREFIX.exec(rest);
  if (priority) {
    prefix += priority[0];
    rest = rest.slice(priority[0].length);
  }

  for (let count = 0; count < 2; count++) {
    const token = LEADING_DATE.exec(rest);
    if (!token) break;
    const value = parseDateTag(token[1]) ? token[1] : rollForwardDate(token[1]);
    prefix += value;
    rest = rest.slice(token[1].length);
    const spacing = WHITESPACE_PREFIX.exec(rest);
    if (spacing) {
      prefix += spacing[0];
      rest = rest.slice(spacing[0].length);
    }
  }

  return prefix + rest;
};

const dateOrNull = (date: Date | undefined): string | null =>
  date === undefined ? null : formatDateTag(date);

const baselineParse = (raw: Buffer): Todo[] =>
  validateTodoFileContent(raw.toString("utf8"), getReadLimits())
    .filter((line) => line.trim())
    .map((line) => new Todo(line));

const baselineSerializeLine = (todo: Todo): string => todo.toString();

const baselineRecord = (
  todo: Todo,
  serializeLine: typeof baselineSerializeLine,
): ContractTodo => {
  const line = serializeLine(todo);
  return {
    text: todo.text,
    state: todo.state === TodoStateEnum.done ? "done" : "todo",
    priority: todo.priority ?? null,
    completionDate: dateOrNull(todo.completionDate),
    creationDate: dateOrNull(todo.creationDate),
    projects: [...todo.projects],
    contexts: [...todo.contexts],
    tags: Object.entries(todo.tags).map(([key, value]) => [key, value]),
    isDone: todo.isDone(),
    isHidden: todo.isHidden(),
    isVisibleInOverview: todo.isVisibleInOverview(),
    isOverdue: todo.isOverdue(),
    toString: line,
    hash: line,
  };
};

/** Serialize a todo with its array-valued tags collapsed to their first value. */
const collapseDuplicateTags = (todo: Todo, line: string): string => {
  let collapsed = line;
  for (const [key, value] of Object.entries(todo.tags)) {
    if (!Array.isArray(value)) continue;
    const original = `${key}:${value.join(",")}`;
    collapsed = collapsed.split(original).join(`${key}:${value[0]}`);
  }
  return collapsed;
};

/** Serialize a todo with its tags in reverse key order. */
const reverseTags = (todo: Todo, line: string): string => {
  const entries = Object.entries(todo.tags);
  if (entries.length < 2) return line;
  const original = entries.map(([key, value]) => `${key}:${value}`).join(" ");
  const reversed = [...entries]
    .reverse()
    .map(([key, value]) => `${key}:${value}`)
    .join(" ");
  if (!line.endsWith(original)) {
    throw new Error(
      "reorder-tags mutation expected the tags at the end of the line",
    );
  }
  return line.slice(0, line.length - original.length) + reversed;
};

export const createAdapter = (mutation?: MutationName): ContractAdapter => {
  const serializeLine = (todo: Todo): string => {
    const line = baselineSerializeLine(todo);
    switch (mutation) {
      case "drop-done-marker":
        return todo.isDone() ? line.replace(/^x /, "") : line;
      case "collapse-duplicate-tags":
        return collapseDuplicateTags(todo, line);
      case "reorder-tags":
        return reverseTags(todo, line);
      default:
        return line;
    }
  };

  const parse = (raw: Buffer): Todo[] => {
    const todos = baselineParse(raw);
    if (mutation !== "accept-invalid-date") return todos;
    // Re-parse only the lines the lenient date parser changes, so unrelated
    // parsed state (for example duplicate tag arrays) is preserved.
    return todos.map((todo) => {
      const line = todo.toString();
      const rewritten = rollForwardLeadingDates(line);
      return rewritten === line ? todo : new Todo(rewritten);
    });
  };

  const record = (todo: Todo): ContractTodo => {
    const base = baselineRecord(todo, serializeLine);
    if (mutation === "ignore-hidden") {
      return {
        ...base,
        isHidden: false,
        isVisibleInOverview: todo.isPassedThreshold(),
      };
    }
    return base;
  };

  return {
    parse,
    serializeLine,
    // Unmutated builds use the production whole-file serializer, so the
    // contract also runs `writeTodosToFile`'s write-time control-character
    // guard. Mutated builds must keep the seeded serialization instead.
    serialize: (todos) =>
      mutation === undefined
        ? serializeTodosForWrite(todos)
        : todos.map(serializeLine).join("\n") + "\n",
    record,
  };
};
