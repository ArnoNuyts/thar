import { expect, test } from "vitest";

import {
  MAX_PASTE_TODOS,
  MAX_TODO_CHARS,
  MAX_TODOS,
  TodoInputError,
  validateTodoBatch,
  validateTodoInput,
  validateTodoText,
} from "../logic/todo-input.ts";

test("write validation rejects empty and whitespace-only text", () => {
  for (const text of ["", " ", "   ", "\t", " \t "]) {
    expect(() => validateTodoText(text)).toThrow(TodoInputError);
    expect(() => validateTodoText(text)).toThrow(/empty|whitespace/i);
  }
});

test("write validation rejects multiline text", () => {
  for (const separator of ["\n", "\r", "\u2028", "\u2029"]) {
    expect(() => validateTodoText(`first${separator}second`)).toThrow(
      TodoInputError,
    );
    expect(() => validateTodoText(`first${separator}second`)).toThrow(
      /single line/i,
    );
  }
});

test("write validation rejects C0 and C1 controls but allows tab", () => {
  for (const code of [0x00, 0x01, 0x08, 0x0b, 0x0c, 0x1b, 0x1f, 0x7f, 0x9b]) {
    expect(() => validateTodoText(`a${String.fromCharCode(code)}b`)).toThrow(
      TodoInputError,
    );
  }
  expect(() => validateTodoText("a\tb")).not.toThrow();
});

test("write validation rejects unpaired surrogates", () => {
  expect(() => validateTodoText("a\ud800b")).toThrow(TodoInputError);
  expect(() => validateTodoText("a\udc00b")).toThrow(TodoInputError);
  expect(() => validateTodoText("a😀b")).not.toThrow();
});

test("write validation enforces the character limit", () => {
  expect(() => validateTodoText("a".repeat(MAX_TODO_CHARS))).not.toThrow();
  expect(() => validateTodoText("a".repeat(MAX_TODO_CHARS + 1))).toThrow(
    TodoInputError,
  );
  expect(() => validateTodoText("a".repeat(MAX_TODO_CHARS + 1))).toThrow(
    /too long/i,
  );
});

test("write validation rejects impossible and ambiguous leading dates", () => {
  for (const token of [
    "2024-13-01",
    "2024-02-30",
    "2024-00-00",
    "2024-01-39",
  ]) {
    expect(() => validateTodoText(`${token} task`)).toThrow(TodoInputError);
  }
  expect(() => validateTodoText("2026-01-01 2026-01-02 task")).toThrow(
    TodoInputError,
  );
  expect(() => validateTodoText("2026-01-01 task")).not.toThrow();
});

test("write validation messages do not echo the payload", () => {
  const payload = `secret-${"x".repeat(MAX_TODO_CHARS + 50)}`;
  try {
    validateTodoText(payload);
    throw new Error("expected validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(TodoInputError);
    expect((error as Error).message).not.toContain("secret");
  }
});

test("batch validation caps paste batches at 100", () => {
  const batch = (count: number) => Array.from({ length: count }, () => "todo");

  expect(() => validateTodoBatch(batch(MAX_PASTE_TODOS))).not.toThrow();
  expect(() => validateTodoBatch(batch(MAX_PASTE_TODOS + 1))).toThrow(
    TodoInputError,
  );
  expect(() => validateTodoBatch(batch(MAX_PASTE_TODOS + 1))).toThrow(
    /limit is 100/i,
  );
});

test("batch validation enforces the total todo cap", () => {
  expect(() => validateTodoBatch(["todo"], MAX_TODOS - 1)).not.toThrow();
  expect(() => validateTodoBatch(["todo"], MAX_TODOS)).toThrow(TodoInputError);
  expect(() => validateTodoBatch(["a", "b"], MAX_TODOS - 1)).toThrow(
    TodoInputError,
  );
});

test("batch validation is atomic: one bad line rejects the whole batch", () => {
  expect(() => validateTodoBatch(["good", " ", "also good"])).toThrow(
    TodoInputError,
  );
  expect(() => validateTodoBatch(["good", "bad\u0000", "also good"])).toThrow(
    TodoInputError,
  );
});

test("validateTodoInput is an alias for validateTodoText", () => {
  expect(validateTodoInput).toBe(validateTodoText);
});
