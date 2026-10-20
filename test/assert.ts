import nodeAssert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";

const ok = (value: unknown, message?: string) => {
  if (message === undefined) nodeAssert.ok(value);
  else nodeAssert.ok(value, message);
};

const strictEqual = <T>(actual: T, expected: T, message?: string) => {
  if (message === undefined) nodeAssert.strictEqual(actual, expected);
  else nodeAssert.strictEqual(actual, expected, message);
};

const notStrictEqual = <T>(actual: T, expected: T, message?: string) => {
  if (message === undefined) nodeAssert.notStrictEqual(actual, expected);
  else nodeAssert.notStrictEqual(actual, expected, message);
};

const deepStrictEqual = <T>(actual: T, expected: T, message?: string) => {
  if (message === undefined) nodeAssert.deepStrictEqual(actual, expected);
  else nodeAssert.deepStrictEqual(actual, expected, message);
};

const match = (actual: string, expected: RegExp, message?: string) => {
  if (message === undefined) nodeAssert.match(actual, expected);
  else nodeAssert.match(actual, expected, message);
};

const doesNotMatch = (actual: string, expected: RegExp, message?: string) => {
  if (message === undefined) nodeAssert.doesNotMatch(actual, expected);
  else nodeAssert.doesNotMatch(actual, expected, message);
};

export function assert(
  expression: unknown,
  message?: string,
): asserts expression {
  ok(expression, message);
}

export function assertFalse(expression: unknown, message?: string) {
  strictEqual(expression, false, message);
}

export function assertExists<T>(
  expression: T | null | undefined,
  message?: string,
): asserts expression is T {
  ok(expression !== null && expression !== undefined, message);
}

export function assertEquals<T>(actual: T, expected: T, message?: string) {
  if (isDeepStrictEqual(actual, expected)) return;
  deepStrictEqual(actual, expected, message);
}

export function assertNotEquals<T>(actual: T, expected: T, message?: string) {
  if (!isDeepStrictEqual(actual, expected)) return;
  ok(false, message ?? "Expected values to be different");
}

export function assertStrictEquals<T>(
  actual: T,
  expected: T,
  message?: string,
) {
  strictEqual(actual, expected, message);
}

export function assertNotStrictEquals<T>(
  actual: T,
  expected: T,
  message?: string,
) {
  notStrictEqual(actual, expected, message);
}

export function assertMatch(
  actual: string,
  expected: RegExp,
  message?: string,
) {
  expected.lastIndex = 0;
  match(actual, expected, message);
}

export function assertNotMatch(
  actual: string,
  expected: RegExp,
  message?: string,
) {
  expected.lastIndex = 0;
  doesNotMatch(actual, expected, message);
}

export function assertStringIncludes(
  actual: string,
  expected: string,
  message?: string,
) {
  ok(
    actual.includes(expected),
    message ?? `Expected "${actual}" to include "${expected}"`,
  );
}

export function assertArrayIncludes<T>(
  actual: T[],
  expected: T[],
  message?: string,
) {
  for (const value of expected) {
    ok(
      actual.some((item) => isDeepStrictEqual(item, value)),
      message ?? `Expected array to include ${String(value)}`,
    );
  }
}

export function assertGreater(
  actual: number,
  expected: number,
  message?: string,
) {
  ok(actual > expected, message ?? `Expected ${actual} > ${expected}`);
}

export function assertLess(actual: number, expected: number, message?: string) {
  ok(actual < expected, message ?? `Expected ${actual} < ${expected}`);
}

export function assertInstanceOf<T>(
  actual: unknown,
  expected: new (...args: never[]) => T,
  message?: string,
): asserts actual is T {
  ok(
    actual instanceof expected,
    message ?? `Expected instance of ${expected.name}`,
  );
}

export function assertThrows(
  fn: () => unknown,
  expected?: RegExp | (new (...args: never[]) => Error),
  message?: string,
) {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }

  ok(thrown !== undefined, message ?? "Expected function to throw");
  if (expected instanceof RegExp) {
    expected.lastIndex = 0;
    match(String((thrown as Error)?.message ?? thrown), expected);
  } else if (expected) {
    ok(thrown instanceof expected, message);
  }
  return thrown;
}

export async function assertRejects(
  fn: () => Promise<unknown>,
  expected?: RegExp | (new (...args: never[]) => Error),
  message?: string,
) {
  let thrown: unknown;
  let didThrow = false;
  try {
    await fn();
  } catch (error) {
    didThrow = true;
    thrown = error;
  }

  ok(didThrow, message ?? "Expected function to reject");
  if (expected instanceof RegExp) {
    expected.lastIndex = 0;
    match(String((thrown as Error)?.message ?? thrown), expected);
  } else if (expected) {
    ok(
      thrown instanceof expected,
      message ??
        `Expected rejection to be ${expected.name}, got ${
          (thrown as Error)?.name
        }`,
    );
  }
  return thrown;
}
