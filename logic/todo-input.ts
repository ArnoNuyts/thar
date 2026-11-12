import { scanTodoPrefix } from "./dates.ts";

/** Maximum length of a single todo line, in UTF-16 code units. */
export const MAX_TODO_CHARS = 2_000;

/** Maximum number of todos accepted from one paste. */
export const MAX_PASTE_TODOS = 100;

/** Maximum number of todos kept in the list (including recurrence copies). */
export const MAX_TODOS = 10_000;

export type TodoInputErrorCode =
  | "empty"
  | "multiline"
  | "control-character"
  | "unpaired-surrogate"
  | "too-long"
  | "invalid-date"
  | "ambiguous-date"
  | "batch-too-large"
  | "too-many-todos";

/**
 * A rejected write-side input. Messages are bounded and never echo the
 * rejected payload, so they are safe to show in a toast.
 */
export class TodoInputError extends Error {
  readonly code: TodoInputErrorCode;

  constructor(code: TodoInputErrorCode, message: string) {
    super(message);
    this.name = "TodoInputError";
    this.code = code;
  }
}

const MULTILINE_REGEX = /[\n\r\u2028\u2029]/;
// C0 and C1 controls, excluding tab (U+0009) which the write path allows.
const CONTROL_CHARACTER_REGEX = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;

/**
 * Validate one todo line before it is parsed or written.
 *
 * Throws `TodoInputError` with a bounded message when `text` is empty,
 * multiline, contains a disallowed control character or unpaired surrogate, is
 * too long, or starts with an impossible or ambiguous date.
 */
export const validateTodoText = (text: string): void => {
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new TodoInputError(
      "empty",
      "Todo text cannot be empty or whitespace only",
    );
  }

  if (MULTILINE_REGEX.test(text)) {
    throw new TodoInputError("multiline", "Todo must be a single line");
  }

  if (CONTROL_CHARACTER_REGEX.test(text)) {
    throw new TodoInputError(
      "control-character",
      "Todo contains a disallowed control character",
    );
  }

  if (!text.isWellFormed()) {
    throw new TodoInputError(
      "unpaired-surrogate",
      "Todo contains an unpaired surrogate",
    );
  }

  if (text.length > MAX_TODO_CHARS) {
    throw new TodoInputError(
      "too-long",
      `Todo is too long; the limit is ${MAX_TODO_CHARS} characters`,
    );
  }

  const prefix = scanTodoPrefix(text);
  if (prefix.invalidDateTokens.length > 0) {
    throw new TodoInputError(
      "invalid-date",
      "Todo starts with an impossible date",
    );
  }

  if (prefix.dateTokens.length > 1) {
    throw new TodoInputError(
      "ambiguous-date",
      "Todo starts with more than one date",
    );
  }
};

/** Alias used by programmatic callers that want an assertion-like name. */
export const validateTodoInput = validateTodoText;

/**
 * Validate a batch of todo lines atomically and check the list capacity.
 *
 * `existingCount` is the number of todos already in the list. When validation
 * throws, the caller must not add any of the lines.
 */
export const validateTodoBatch = (
  texts: readonly string[],
  existingCount = 0,
  maxBatch: number = MAX_PASTE_TODOS,
): void => {
  if (texts.length > maxBatch) {
    throw new TodoInputError(
      "batch-too-large",
      `Too many todos in one paste; the limit is ${maxBatch}`,
    );
  }

  if (existingCount + texts.length > MAX_TODOS) {
    throw new TodoInputError(
      "too-many-todos",
      `Too many todos; the limit is ${MAX_TODOS}`,
    );
  }

  for (const text of texts) {
    validateTodoText(text);
  }
};
