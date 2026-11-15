import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";

import {
  DEFAULT_CORPUS_DIR,
  REPO_ROOT,
  buildContract,
  listFixtures,
} from "../tools/port/build.ts";
import { compareContracts } from "../tools/port/compare.ts";
import { verifyGolden } from "../tools/port/golden.ts";

/**
 * CP1 contract harness coverage.
 *
 * The contract itself is built in-process twice (determinism + schema), and
 * the seeded-bug proof runs as the same plain-Node script CI uses, so a broken
 * mutation check fails `npm test` too.
 */

const RealDate = globalThis.Date;

afterAll(() => {
  globalThis.Date = RealDate;
});

const build = () => buildContract({ corpusDir: DEFAULT_CORPUS_DIR });

const TODO_KEYS = [
  "text",
  "state",
  "priority",
  "completionDate",
  "creationDate",
  "projects",
  "contexts",
  "tags",
  "isDone",
  "isHidden",
  "isVisibleInOverview",
  "isOverdue",
  "toString",
  "hash",
];

const TODOS_RECORD_KEYS = [
  "fixture",
  "sha256",
  "kind",
  "readLimits",
  "clockLocal",
  "todoCount",
  "serialized",
  "todos",
];

const ERROR_RECORD_KEYS = [
  "fixture",
  "sha256",
  "kind",
  "readLimits",
  "clockLocal",
  "error",
];

const NUMERIC_ERROR_FIELDS = [
  "lineNumber",
  "length",
  "maxLineChars",
  "lineCount",
  "maxReadTodos",
  "actualBytes",
  "maxBytes",
  "codePoint",
];

const SHA256 = /^[0-9a-f]{64}$/;

describe("port contract determinism", () => {
  test("two in-process builds are byte-identical", () => {
    const first = build();
    const second = build();

    expect(first.jsonl.length).toBeGreaterThan(1_000_000);
    expect(second.jsonl).toEqual(first.jsonl);
    expect(second.records).toEqual(first.records);
  });

  test("records are ordered bytewise by fixture name", () => {
    const contract = build();
    const fixtures = contract.records.map((record) => record.fixture);

    expect(fixtures).toEqual(listFixtures(DEFAULT_CORPUS_DIR));
    expect(fixtures).toEqual(
      [...fixtures].sort((left, right) =>
        Buffer.compare(Buffer.from(left), Buffer.from(right)),
      ),
    );
    expect(fixtures.length).toBeGreaterThanOrEqual(20);
  });
});

describe("port contract schema", () => {
  test("every record uses the documented key order and value types", () => {
    const contract = build();

    for (const record of contract.records) {
      expect(record.sha256, record.fixture).toMatch(SHA256);
      expect(Object.keys(record.readLimits)).toEqual([
        "maxFileBytes",
        "maxReadTodos",
        "maxLineChars",
      ]);
      expect(record.readLimits).toEqual(contract.readLimits);
      expect(record.clockLocal).toEqual(contract.clockLocal);

      if (record.kind === "todos") {
        expect(Object.keys(record), record.fixture).toEqual(TODOS_RECORD_KEYS);
        expect(Object.keys(record.serialized)).toEqual(["sha256", "bytes"]);
        expect(record.serialized.sha256).toMatch(SHA256);
        expect(record.todoCount).toEqual(record.todos.length);

        for (const [index, todo] of record.todos.entries()) {
          const where = `${record.fixture} todos[${index}]`;
          expect(Object.keys(todo), where).toEqual(TODO_KEYS);
          expect(todo.state === "todo" || todo.state === "done").toBe(true);
          expect(todo.isDone).toEqual(todo.state === "done");
          expect(todo.hash, where).toEqual(todo.toString);
          for (const [key, value] of todo.tags) {
            expect(typeof key, where).toEqual("string");
            if (Array.isArray(value)) {
              expect(value.length).toBeGreaterThan(1);
              for (const item of value) expect(typeof item).toEqual("string");
            } else {
              expect(typeof value).toEqual("string");
            }
          }
        }
      } else {
        expect(Object.keys(record), record.fixture).toEqual(ERROR_RECORD_KEYS);
        const keys = Object.keys(record.error);
        expect(keys[0]).toEqual("name");
        expect(keys[1]).toEqual("code");
        expect(keys.at(-1)).toEqual("message");
        expect(record.error.code).not.toEqual("");
        expect(record.error.message.length).toBeGreaterThan(0);
        for (const key of keys.slice(2, -1)) {
          expect(NUMERIC_ERROR_FIELDS, key).toContain(key);
          expect(
            typeof (record.error as unknown as Record<string, unknown>)[key],
          ).toEqual("number");
        }
      }
    }
  });

  test("includes every parsed todo, including all 10 000 generated rows", () => {
    const contract = build();
    const large = contract.records.find(
      (record) => record.fixture === "large-10000.txt",
    );

    expect(large?.kind).toEqual("todos");
    if (large && large.kind === "todos") {
      expect(large.todos).toHaveLength(10_000);
      expect(large.todoCount).toEqual(10_000);
    }
  });
});

describe("port contract golden file", () => {
  test("matches testdata/port/expected.json field by field", () => {
    expect(verifyGolden(build())).toEqual([]);
  });

  test("the comparator accepts the oracle and rejects tampered contracts", () => {
    const { jsonl } = build();
    expect(compareContracts(jsonl, jsonl).diffs).toEqual([]);

    const changed = jsonl.replace(
      /"serialized":\{"sha256":"[0-9a-f]{64}"/,
      '"serialized":{"sha256":"' + "0".repeat(64) + '"',
    );
    const changedDiff = compareContracts(jsonl, changed).diffs[0];
    expect(changedDiff?.path).toEqual("serialized.sha256");

    const reordered = jsonl.replace(
      '"text":"First todo","state":"todo"',
      '"state":"todo","text":"First todo"',
    );
    expect(compareContracts(jsonl, reordered).diffs[0]?.path).toEqual(
      "todos[0].__keys",
    );

    const extraRecord = `${jsonl}${jsonl.split("\n")[0]}\n`;
    const extraDiffs = compareContracts(jsonl, extraRecord, 5).diffs;
    expect(extraDiffs.some((diff) => diff.path === "records.length")).toBe(
      true,
    );

    const missingRecord = `${jsonl.split("\n").slice(1).join("\n")}`;
    expect(
      compareContracts(jsonl, missingRecord, 5).diffs.some(
        (diff) => diff.path === "records.length",
      ),
    ).toBe(true);

    expect(
      compareContracts(jsonl, jsonl.replace(/\n/g, "\r\n"), 5).diffs.length,
    ).toBeGreaterThan(0);
  });
});

describe("port self-test", () => {
  test("catches every seeded mutation", () => {
    const result = spawnSync(
      process.execPath,
      [join(REPO_ROOT, "tools", "port", "self-test.mjs")],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        timeout: 240_000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );

    expect(result.stderr, result.stderr).toEqual("");
    expect(result.status, `${result.stdout}\n${result.stderr}`).toEqual(0);
    expect(result.stdout).toContain("port-selftest: ok");
    for (const mutation of [
      "drop-done-marker",
      "accept-invalid-date",
      "collapse-duplicate-tags",
      "ignore-hidden",
      "reorder-tags",
    ]) {
      expect(result.stdout).toContain(`mutation ${mutation}: caught on`);
    }
  }, 300_000);
});
