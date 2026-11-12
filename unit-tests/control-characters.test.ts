import { expect, test } from "vitest";

import {
  CR_CODE_POINT,
  findUnsafeTodoTextCodePoint,
  isRejectedControlCodePoint,
  LF_CODE_POINT,
  TAB_CODE_POINT,
} from "../logic/control-characters.ts";
import { sanitizeForDisplay } from "../logic/display-safety.ts";
import { getReadLimits } from "../logic/limits.ts";
import { validateTodoFileContent } from "../logic/todo-file-validation.ts";

const formatCodePoint = (codePoint: number) =>
  `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;

const sampleCodePoints = [
  ...Array.from({ length: 0x100 }, (_, codePoint) => codePoint),
  0x2028,
  0x2029,
];

test("isRejectedControlCodePoint: range boundaries are explicit", () => {
  expect(isRejectedControlCodePoint(TAB_CODE_POINT)).toEqual(true);
  expect(isRejectedControlCodePoint(LF_CODE_POINT)).toEqual(true);
  expect(isRejectedControlCodePoint(CR_CODE_POINT)).toEqual(true);
  expect(isRejectedControlCodePoint(0x1f)).toEqual(true);
  expect(isRejectedControlCodePoint(0x20)).toEqual(false);
  expect(isRejectedControlCodePoint(0x7e)).toEqual(false);
  expect(isRejectedControlCodePoint(0x7f)).toEqual(true);
  expect(isRejectedControlCodePoint(0x9f)).toEqual(true);
  expect(isRejectedControlCodePoint(0xa0)).toEqual(false);
  expect(isRejectedControlCodePoint(0x2027)).toEqual(false);
  expect(isRejectedControlCodePoint(0x2028)).toEqual(true);
  expect(isRejectedControlCodePoint(0x2029)).toEqual(true);
  expect(isRejectedControlCodePoint(0x202a)).toEqual(false);
});

test("read and display consumers agree on the rejected control set", () => {
  const limits = getReadLimits({});

  for (const codePoint of sampleCodePoints) {
    const char = String.fromCharCode(codePoint);
    const label = formatCodePoint(codePoint);

    const sanitized = sanitizeForDisplay(char);
    const displayEscaped = sanitized !== char;

    if (codePoint === LF_CODE_POINT) {
      // LF is a record delimiter, not a same-line payload character. Display
      // still escapes it, and the write policy rejects it inside a todo.
      expect(displayEscaped, label).toEqual(true);
      expect(findUnsafeTodoTextCodePoint(`a${char}b`), label).toEqual(
        LF_CODE_POINT,
      );
      continue;
    }

    let readRejected = false;
    try {
      validateTodoFileContent(`a${char}b`, limits);
    } catch {
      readRejected = true;
    }

    if (codePoint === TAB_CODE_POINT) {
      // Tab is the one explicit exception shared by both consumers.
      expect(displayEscaped, `${label} should stay raw`).toEqual(false);
      expect(readRejected, `${label} should be accepted`).toEqual(false);
      expect(findUnsafeTodoTextCodePoint(`a${char}b`), label).toBeUndefined();
    } else {
      expect(displayEscaped, `${label} display`).toEqual(
        isRejectedControlCodePoint(codePoint),
      );
      expect(readRejected, `${label} read`).toEqual(
        isRejectedControlCodePoint(codePoint),
      );
      // The two consumers accept/reject exactly the same set.
      expect(displayEscaped, `${label} agreement`).toEqual(readRejected);
      expect(findUnsafeTodoTextCodePoint(`a${char}b`) !== undefined).toEqual(
        readRejected,
      );
    }
  }
});
