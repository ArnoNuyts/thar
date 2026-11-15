/**
 * Structural comparison of two JSONL contracts.
 *
 * The comparator is deliberately stricter than "parses to the same JSON":
 *
 * - records must appear in the same order (bytewise fixture order),
 * - object keys must appear in the same order (the schema is part of the
 *   contract), so a subset, superset or reordered field fails,
 * - the candidate file must be UTF-8, LF-only and newline-terminated,
 * - array lengths and every scalar value must match exactly.
 */

export interface ContractDiff {
  /** Fixture the diff belongs to, or `"<corpus>"` for file-level problems. */
  fixture: string;
  /** JSON path inside the record (`todos[3].toString`, `serialized.sha256`). */
  path: string;
  expected: unknown;
  actual: unknown;
}

export interface CompareResult {
  diffs: ContractDiff[];
  /** Diffs omitted from `diffs` because of `maxDiffs`. */
  omitted: number;
  /**
   * True when the walk stopped at the `maxDiffs` cap, so `diffs` is a lower
   * bound rather than the complete set of differences.
   */
  truncated: boolean;
}

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

const isPlainObject = (value: unknown): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const joinPath = (base: string, key: string): string =>
  base === "" ? key : `${base}.${key}`;

const childPath = (base: string, key: number): string => `${base}[${key}]`;

const fixtureNameOf = (value: unknown): string => {
  if (isPlainObject(value) && typeof value.fixture === "string") {
    return value.fixture;
  }
  return "<corpus>";
};

class DiffCollector {
  readonly diffs: ContractDiff[] = [];
  private readonly limit: number;
  omitted = 0;
  /** True when the walk stopped before the input was exhausted. */
  truncated = false;

  constructor(limit: number) {
    // Never retain zero diffs: a cap of 0 must not turn a difference into a
    // match. The CLI rejects 0; this is defence in depth for library callers.
    const cap = Number.isFinite(limit) ? Math.floor(limit) : 1;
    this.limit = Math.max(1, cap);
  }

  /** True once enough diffs were collected; callers stop walking. */
  get full(): boolean {
    return this.diffs.length >= this.limit;
  }

  /** Record that comparison stopped while differences may remain. */
  stop(): void {
    this.truncated = true;
  }

  add(fixture: string, path: string, expected: unknown, actual: unknown): void {
    if (this.diffs.length >= this.limit) {
      this.omitted += 1;
      this.truncated = true;
      return;
    }
    this.diffs.push({ fixture, path, expected, actual });
  }
}

/** Index of the first key that moved, or `undefined` for an identical list. */
const firstKeyDivergence = (
  expectedKeys: string[],
  actualKeys: string[],
): number | undefined => {
  const shared = Math.min(expectedKeys.length, actualKeys.length);
  for (let index = 0; index < shared; index++) {
    if (expectedKeys[index] !== actualKeys[index]) return index;
  }
  return expectedKeys.length === actualKeys.length ? undefined : shared;
};

const compareValues = (
  fixture: string,
  path: string,
  expected: JsonValue,
  actual: JsonValue,
  collector: DiffCollector,
): void => {
  if (collector.full) {
    collector.stop();
    return;
  }

  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      collector.add(fixture, path, expected, actual);
      return;
    }
    if (expected.length !== actual.length) {
      collector.add(fixture, `${path}.length`, expected.length, actual.length);
    }
    const shared = Math.min(expected.length, actual.length);
    for (let index = 0; index < shared; index++) {
      if (collector.full) {
        collector.stop();
        break;
      }
      compareValues(
        fixture,
        childPath(path, index),
        expected[index],
        actual[index],
        collector,
      );
    }
    return;
  }

  if (isPlainObject(expected) && isPlainObject(actual)) {
    const expectedKeys = Object.keys(expected);
    const actualKeys = Object.keys(actual);
    if (expectedKeys.join("\u0000") !== actualKeys.join("\u0000")) {
      const keysPath = path === "" ? "__keys" : `${path}.__keys`;
      collector.add(fixture, keysPath, expectedKeys, actualKeys);
      // Name the first key that moved: the full key list is truncated in the
      // printed diff, so this is what makes a reordered schema diagnosable.
      const divergence = firstKeyDivergence(expectedKeys, actualKeys);
      if (divergence !== undefined) {
        collector.add(
          fixture,
          `${keysPath}[${divergence}]`,
          expectedKeys[divergence] ?? "<missing>",
          actualKeys[divergence] ?? "<missing>",
        );
      }
    }
    for (const key of expectedKeys) {
      if (collector.full) {
        collector.stop();
        return;
      }
      if (!(key in actual)) {
        collector.add(fixture, joinPath(path, key), expected[key], undefined);
        continue;
      }
      compareValues(
        fixture,
        joinPath(path, key),
        expected[key],
        actual[key],
        collector,
      );
    }
    for (const key of actualKeys) {
      if (!(key in expected)) {
        collector.add(fixture, joinPath(path, key), undefined, actual[key]);
      }
    }
    return;
  }

  if (expected !== actual) {
    collector.add(fixture, path, expected, actual);
  }
};

const textDecoder = new TextDecoder("utf-8", { fatal: true });

/** Parse a candidate/oracle JSONL file, recording protocol problems as diffs. */
const parseJsonl = (
  text: string,
  collector: DiffCollector,
  label: string,
): JsonValue[] => {
  if (text.length > 0 && !text.endsWith("\n")) {
    collector.add(
      "<corpus>",
      "<file>",
      "newline-terminated JSONL",
      `${label} has no final LF`,
    );
  }
  if (text.includes("\r")) {
    collector.add(
      "<corpus>",
      "<file>",
      "LF line endings",
      `${label} contains CR`,
    );
  }

  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();

  const records: JsonValue[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line === "") {
      collector.add(
        "<corpus>",
        childPath("records", index),
        "one JSON object",
        "blank line",
      );
      continue;
    }
    try {
      records.push(JSON.parse(line) as JsonValue);
    } catch (error) {
      collector.add(
        "<corpus>",
        childPath("records", index),
        "valid JSON",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return records;
};

export const decodeJsonlBytes = (bytes: Uint8Array): string | undefined => {
  try {
    return textDecoder.decode(bytes);
  } catch {
    return undefined;
  }
};

/**
 * Compare a freshly built oracle contract (expected) with a candidate
 * contract (actual). Returns at most `maxDiffs` reported diffs.
 */
export const compareContracts = (
  expectedText: string,
  actualText: string,
  maxDiffs = 20,
): CompareResult => {
  const collector = new DiffCollector(maxDiffs);
  const expected = parseJsonl(expectedText, collector, "oracle");
  const actual = parseJsonl(actualText, collector, "candidate");

  if (expected.length !== actual.length) {
    collector.add("<corpus>", "records.length", expected.length, actual.length);
  }

  const shared = Math.min(expected.length, actual.length);
  for (let index = 0; index < shared; index++) {
    if (collector.full) {
      collector.stop();
      break;
    }
    const expectedRecord = expected[index];
    const actualRecord = actual[index];
    const expectedFixture = fixtureNameOf(expectedRecord);
    if (expectedFixture !== fixtureNameOf(actualRecord)) {
      collector.add(
        "<corpus>",
        childPath("records", index),
        expectedFixture,
        fixtureNameOf(actualRecord),
      );
      continue;
    }
    compareValues(expectedFixture, "", expectedRecord, actualRecord, collector);
  }

  for (let index = shared; index < actual.length; index++) {
    collector.add(
      "<corpus>",
      childPath("records", index),
      undefined,
      fixtureNameOf(actual[index]),
    );
  }

  return {
    diffs: collector.diffs,
    omitted: collector.omitted,
    truncated: collector.truncated,
  };
};

const MAX_VALUE_CHARS = 120;

const truncate = (text: string): string =>
  text.length <= MAX_VALUE_CHARS
    ? text
    : `${text.slice(0, MAX_VALUE_CHARS)}…(+${text.length - MAX_VALUE_CHARS})`;

/** Render one value for a diff line, truncated to stay readable. */
const renderValue = (value: unknown): string => {
  if (value === undefined) return "<missing>";
  if (Array.isArray(value)) {
    const text = JSON.stringify(value);
    if (text.length <= MAX_VALUE_CHARS) return text;
    // Say how many items there were instead of cutting mid-token, so a long
    // key list still names its first few keys and its length.
    const head = value
      .slice(0, 6)
      .map((item) => JSON.stringify(item))
      .join(", ");
    return truncate(`[${head}, … (${value.length} item(s))]`);
  }
  return truncate(JSON.stringify(value));
};

/** Compare two JSON values and return readable diffs (used by `--verify-golden`). */
export const diffJson = (
  fixture: string,
  path: string,
  expected: unknown,
  actual: unknown,
  maxDiffs = 1_000,
): ContractDiff[] => {
  const collector = new DiffCollector(maxDiffs);
  compareValues(
    fixture,
    path,
    expected as JsonValue,
    actual as JsonValue,
    collector,
  );
  return collector.diffs;
};

export const formatDiff = (diff: ContractDiff): string =>
  `${diff.fixture} ${diff.path}: expected ${renderValue(diff.expected)}, actual ${renderValue(diff.actual)}`;
