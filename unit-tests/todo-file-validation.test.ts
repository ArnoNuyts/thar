import { expect, test } from "vitest";

import {
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_LINE_CHARS,
  DEFAULT_MAX_READ_TODOS,
  getReadLimits,
  InvalidLimitError,
  type ReadLimits,
  TodoControlCharacterError,
  TodoLineCountLimitError,
  TodoLineLengthLimitError,
} from "../logic/limits.ts";
import { validateTodoFileContent } from "../logic/todo-file-validation.ts";

const limits = (): ReadLimits => getReadLimits({});
const validate = (data: string, overrides: Partial<ReadLimits> = {}) =>
  validateTodoFileContent(data, { ...limits(), ...overrides });

const captureError = (callback: () => unknown): unknown => {
  try {
    callback();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the callback to throw");
};

test("limits: defaults and positive-integer environment overrides", () => {
  expect(limits()).toEqual({
    maxFileBytes: DEFAULT_MAX_FILE_BYTES,
    maxReadTodos: DEFAULT_MAX_READ_TODOS,
    maxLineChars: DEFAULT_MAX_LINE_CHARS,
  });
  expect(DEFAULT_MAX_FILE_BYTES).toEqual(1024 * 1024);
  expect(DEFAULT_MAX_READ_TODOS).toEqual(10_000);
  expect(DEFAULT_MAX_LINE_CHARS).toEqual(8_192);

  expect(
    getReadLimits({
      THAR_MAX_FILE_BYTES: "2048",
      THAR_MAX_READ_TODOS: "25",
      THAR_MAX_LINE_CHARS: "100",
    }),
  ).toEqual({ maxFileBytes: 2048, maxReadTodos: 25, maxLineChars: 100 });
});

test("limits: invalid environment values throw a clear, bounded error", () => {
  for (const value of ["0", "-1", "abc", "1.5", "", " 10", "Infinity"]) {
    const error = captureError(() =>
      getReadLimits({ THAR_MAX_READ_TODOS: value }),
    );
    expect(error).toBeInstanceOf(InvalidLimitError);
    const message = (error as Error).message;
    expect(message).toContain("THAR_MAX_READ_TODOS");
    expect(message).toContain("positive integer");
    if (value !== "") expect(message).not.toContain(value);
  }
});

test("validate: accepts exactly the line-count limit and rejects one more", () => {
  const atLimit = Array.from(
    { length: DEFAULT_MAX_READ_TODOS },
    (_, index) => `task ${index}`,
  ).join("\n");
  expect(validate(atLimit)).toHaveLength(DEFAULT_MAX_READ_TODOS);

  // A trailing newline terminates the last line and must not count as an
  // extra line.
  expect(validate(`${atLimit}\n`)).toHaveLength(DEFAULT_MAX_READ_TODOS + 1);

  const overLimit = Array.from(
    { length: DEFAULT_MAX_READ_TODOS + 1 },
    (_, index) => `task ${index}`,
  ).join("\n");
  const error = captureError(() => validate(overLimit));
  expect(error).toBeInstanceOf(TodoLineCountLimitError);
  expect((error as TodoLineCountLimitError).lineCount).toEqual(
    DEFAULT_MAX_READ_TODOS + 1,
  );
  expect((error as TodoLineCountLimitError).maxReadTodos).toEqual(
    DEFAULT_MAX_READ_TODOS,
  );
});

test("validate: a 500k-line file is rejected without splitting it", () => {
  const data = "x\n".repeat(500_000);
  const startedAt = performance.now();
  const error = captureError(() => validate(data));

  expect(error).toBeInstanceOf(TodoLineCountLimitError);
  expect((error as TodoLineCountLimitError).lineCount).toEqual(500_000);
  expect(performance.now() - startedAt).toBeLessThan(1000);
});

test("validate: accepts the line-length boundary and reports line 2 for 8193 chars", () => {
  const atLimit = "x".repeat(DEFAULT_MAX_LINE_CHARS);
  expect(validate(atLimit)).toEqual([atLimit]);

  const overLimit = `${atLimit}y`;
  const error = captureError(() => validate(overLimit));
  expect(error).toBeInstanceOf(TodoLineLengthLimitError);
  expect((error as TodoLineLengthLimitError).lineNumber).toEqual(1);
  expect((error as TodoLineLengthLimitError).length).toEqual(
    DEFAULT_MAX_LINE_CHARS + 1,
  );
  expect((error as TodoLineLengthLimitError).maxLineChars).toEqual(
    DEFAULT_MAX_LINE_CHARS,
  );

  const secondLine = captureError(() =>
    validate(`short\n${overLimit}`),
  ) as TodoLineLengthLimitError;
  expect(secondLine).toBeInstanceOf(TodoLineLengthLimitError);
  expect(secondLine.lineNumber).toEqual(2);
});

test("validate: control-character matrix allows tab and rejects the rest", () => {
  expect(validate("before\tafter")).toEqual(["before\tafter"]);

  const cases: Array<[string, number]> = [
    ["nul\u0000byte", 0x00],
    ["soh\u0001byte", 0x01],
    ["esc\u001b[31mred", 0x1b],
    ["del\u007fbyte", 0x7f],
    ["c1\u009b31m", 0x9b],
    ["line\u2028sep", 0x2028],
    ["line\u2029sep", 0x2029],
    ["bare\rcr", 0x0d],
    ["bare end\r", 0x0d],
  ];

  for (const [data, codePoint] of cases) {
    const error = captureError(() => validate(data));
    expect(error, `Expected ${data} to be rejected`).toBeInstanceOf(
      TodoControlCharacterError,
    );
    expect((error as TodoControlCharacterError).lineNumber).toEqual(1);
    expect((error as TodoControlCharacterError).codePoint).toEqual(codePoint);
    expect((error as Error).message).toContain(
      `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`,
    );
  }
});

test("validate: accepts CRLF, rejects a remaining CR, and reports the line", () => {
  expect(validate("First\r\nSecond\r\n")).toEqual(["First", "Second", ""]);
  expect(validate("First\r\nSecond")).toEqual(["First", "Second"]);

  const error = captureError(() => validate("First\r\r\nSecond\r\n"));
  expect(error).toBeInstanceOf(TodoControlCharacterError);
  expect((error as TodoControlCharacterError).lineNumber).toEqual(1);
  expect((error as TodoControlCharacterError).codePoint).toEqual(0x0d);
});

test("validate: error messages never echo file content", () => {
  const marker = "DO_NOT_ECHO_THIS_MARKER";
  const cases = [
    `${marker}\u0000`,
    `${marker}\u001b[31m`,
    `${marker}${"y".repeat(DEFAULT_MAX_LINE_CHARS)}`,
    `${Array.from({ length: DEFAULT_MAX_READ_TODOS + 1 }, () => marker).join(
      "\n",
    )}`,
  ];

  for (const data of cases) {
    const error = captureError(() => validate(data));
    const message = (error as Error).message;
    expect(message).not.toContain(marker);
    expect(message).not.toContain("\u0000");
    expect(message).not.toContain("\u001b");
    expect(message).toMatch(/line|bytes|characters/u);
    expect(message.length).toBeLessThan(400);
  }
});
