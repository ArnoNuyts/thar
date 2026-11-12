import { findUnsafeTodoTextCodePoint } from "./control-characters.ts";
import { scanTodoPrefix } from "./dates.ts";
import { MAX_PASTE_TODOS, MAX_TODO_CHARS, MAX_TODOS } from "./limits.ts";

export type TodoInputErrorCode =
  | "empty"
  | "multiline"
  | "control-character"
  | "unpaired-surrogate"
  | "too-long"
  | "invalid-date"
  | "ambiguous-date"
  | "leading-date"
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

const MULTILINE_SEPARATORS = ["\n", "\r", "\u2028", "\u2029"] as const;

export interface TodoTextValidationOptions {
  /**
   * Effective character cap. Defaults to `MAX_TODO_CHARS`. The edit modal
   * passes the original length when it is already over the cap so unchanged
   * legacy values can still be saved; a growing value is rejected.
   */
  maxChars?: number;
}

/**
 * Validate one todo line before it is parsed or written.
 *
 * Throws `TodoInputError` with a bounded message when `text` is empty,
 * multiline, contains a disallowed control character or unpaired surrogate, is
 * too long, or starts with a date. The app owns creation dates, so a leading
 * date token is rejected instead of being silently dropped or prepended.
 */
export const validateTodoText = (
  text: string,
  options: TodoTextValidationOptions = {},
): void => {
  const maxChars = options.maxChars ?? MAX_TODO_CHARS;

  if (typeof text !== "string" || text.trim().length === 0) {
    throw new TodoInputError(
      "empty",
      "Todo text cannot be empty or whitespace only",
    );
  }

  if (MULTILINE_SEPARATORS.some((separator) => text.includes(separator))) {
    throw new TodoInputError("multiline", "Todo must be a single line");
  }

  // `findUnsafeTodoTextCodePoint` is the shared write/read/display policy.
  // LF, CR, and the Unicode separators are handled above so they keep their
  // dedicated "multiline" message.
  if (findUnsafeTodoTextCodePoint(text) !== undefined) {
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

  if (text.length > maxChars) {
    throw new TodoInputError(
      "too-long",
      `Todo is too long; the limit is ${maxChars} characters`,
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

  if (prefix.dateTokens.length > 0) {
    throw new TodoInputError(
      "leading-date",
      "Todo text cannot start with a date; use the date picker",
    );
  }
};

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
