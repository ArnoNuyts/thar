/**
 * Read-path limits and typed, bounded errors.
 *
 * Every error in this module reports only counts, line numbers, lengths, and
 * `U+XXXX` code points. File content must never appear in an error message:
 * these messages are shown in the TUI and may be logged.
 */

export const DEFAULT_MAX_FILE_BYTES = 1024 * 1024; // 1 MiB
export const DEFAULT_MAX_READ_TODOS = 10_000;
export const DEFAULT_MAX_LINE_CHARS = 8_192;

/**
 * Maximum length of a single todo line created or edited in the TUI, in
 * UTF-16 code units.
 *
 * This is intentionally smaller than `DEFAULT_MAX_LINE_CHARS`: the reader
 * accepts legacy overlong lines (up to 8,192 characters) so existing files
 * stay loadable, while new writes stay comfortably below the read limit. The
 * edit modal grandfathers an unchanged overlong value by only enforcing this
 * cap when the value grows.
 */
export const MAX_TODO_CHARS = 2_000;

/** Maximum number of todos accepted from one paste. */
export const MAX_PASTE_TODOS = 100;

/**
 * Maximum number of todos kept in memory (including recurrence copies).
 * Derived from the read limit so the in-memory cap and a file that can be
 * loaded always agree.
 */
export const MAX_TODOS = DEFAULT_MAX_READ_TODOS;

export interface ReadLimits {
  maxFileBytes: number;
  maxReadTodos: number;
  maxLineChars: number;
}

const LIMIT_ENV_VARS = {
  maxFileBytes: "TODOTUI_MAX_FILE_BYTES",
  maxReadTodos: "TODOTUI_MAX_READ_TODOS",
  maxLineChars: "TODOTUI_MAX_LINE_CHARS",
} as const;

export class InvalidLimitError extends Error {
  readonly limitName: string;

  constructor(limitName: string) {
    super(
      `Invalid ${limitName}: expected a positive integer. ` +
        `Fix the environment variable or unset it to use the default.`,
    );
    this.name = "InvalidLimitError";
    this.limitName = limitName;
  }
}

const parsePositiveInteger = (
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number => {
  const raw = env[name];
  if (raw === undefined) return fallback;

  // Deliberately avoid echoing the raw value: it is environment input and may
  // itself contain control characters.
  if (!/^[0-9]+$/.test(raw)) {
    throw new InvalidLimitError(name);
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new InvalidLimitError(name);
  }

  return value;
};

/** Resolve the read limits from the environment, validating each override. */
export const getReadLimits = (
  env: NodeJS.ProcessEnv = process.env,
): ReadLimits => ({
  maxFileBytes: parsePositiveInteger(
    env,
    LIMIT_ENV_VARS.maxFileBytes,
    DEFAULT_MAX_FILE_BYTES,
  ),
  maxReadTodos: parsePositiveInteger(
    env,
    LIMIT_ENV_VARS.maxReadTodos,
    DEFAULT_MAX_READ_TODOS,
  ),
  maxLineChars: parsePositiveInteger(
    env,
    LIMIT_ENV_VARS.maxLineChars,
    DEFAULT_MAX_LINE_CHARS,
  ),
});

export const formatCodePoint = (codePoint: number): string =>
  `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;

export class TodoFileValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class TodoFileTooLargeError extends TodoFileValidationError {
  readonly actualBytes: number;
  readonly maxBytes: number;

  constructor(actualBytes: number, maxBytes: number) {
    super(
      "FILE_TOO_LARGE",
      `Todo file is ${actualBytes} bytes; the limit is ${maxBytes} bytes. ` +
        `Trim the file or raise ${LIMIT_ENV_VARS.maxFileBytes}. Nothing was changed.`,
    );
    this.actualBytes = actualBytes;
    this.maxBytes = maxBytes;
  }
}

export class TodoLineCountLimitError extends TodoFileValidationError {
  readonly lineCount: number;
  readonly maxReadTodos: number;

  constructor(lineCount: number, maxReadTodos: number) {
    super(
      "TOO_MANY_LINES",
      `Todo file has ${lineCount} lines; the limit is ${maxReadTodos}. ` +
        `Trim the file or raise ${LIMIT_ENV_VARS.maxReadTodos}. Nothing was changed.`,
    );
    this.lineCount = lineCount;
    this.maxReadTodos = maxReadTodos;
  }
}

export class TodoLineLengthLimitError extends TodoFileValidationError {
  readonly lineNumber: number;
  readonly length: number;
  readonly maxLineChars: number;

  constructor(lineNumber: number, length: number, maxLineChars: number) {
    super(
      "LINE_TOO_LONG",
      `Todo file line ${lineNumber} is ${length} characters; the limit is ${maxLineChars}. ` +
        `Shorten the line or raise ${LIMIT_ENV_VARS.maxLineChars}. Nothing was changed.`,
    );
    this.lineNumber = lineNumber;
    this.length = length;
    this.maxLineChars = maxLineChars;
  }
}

export class TodoControlCharacterError extends TodoFileValidationError {
  readonly lineNumber: number;
  readonly codePoint: number;

  constructor(lineNumber: number, codePoint: number) {
    super(
      "CONTROL_CHARACTER",
      `Todo file line ${lineNumber} contains the control character ${formatCodePoint(
        codePoint,
      )}. Remove control characters from the file. Nothing was changed.`,
    );
    this.lineNumber = lineNumber;
    this.codePoint = codePoint;
  }
}
