import { readFileSync } from "node:fs";
import { join } from "node:path";

import { type ContractBuild } from "./build.ts";
import { type ContractDiff, diffJson } from "./compare.ts";
import type { ContractRecord } from "./types.ts";

/**
 * Golden cross-check between the freshly built contract and CP0's
 * `testdata/port/expected.json`.
 *
 * `expected.json` is the reviewed, committed oracle (see
 * `testdata/port/README.md`); the contract is derived from the same production
 * code. Comparing them here means CP0 and CP1 cannot drift: any field that
 * `expected.json` pins must also match the contract, and any fixture that the
 * contract adds must be a corpus fixture.
 */

interface ExpectedFile {
  rawBytes: number;
  kind: "todos" | "error";
  todoCount?: number;
  serialized?: { sha256: string; bytes: number };
  todos?: unknown[];
  samples?: { index: number; todo: unknown }[];
  error?: Record<string, unknown>;
}

interface ExpectedCorpus {
  clockLocal: string;
  readLimits: Record<string, number>;
  files: Record<string, ExpectedFile>;
}

const byName = (records: ContractRecord[]): Map<string, ContractRecord> =>
  new Map(records.map((record) => [record.fixture, record]));

export interface GoldenOptions {
  expectedPath?: string;
}

/** Field-by-field verification of a built contract against `expected.json`. */
export const verifyGolden = (
  build: ContractBuild,
  options: GoldenOptions = {},
): ContractDiff[] => {
  const expectedPath =
    options.expectedPath ?? join(build.corpusDir, "expected.json");
  const expected = JSON.parse(
    readFileSync(expectedPath, "utf8"),
  ) as ExpectedCorpus;

  const diffs: ContractDiff[] = [];
  diffs.push(
    ...diffJson(
      "<corpus>",
      "clockLocal",
      expected.clockLocal,
      build.clockLocal,
    ),
  );
  diffs.push(
    ...diffJson(
      "<corpus>",
      "readLimits",
      expected.readLimits,
      build.readLimits,
    ),
  );

  const records = byName(build.records);
  const expectedFixtures = Object.keys(expected.files);
  const actualFixtures = build.records.map((record) => record.fixture);

  for (const fixture of expectedFixtures) {
    const record = records.get(fixture);
    if (!record) {
      diffs.push({
        fixture,
        path: "<record>",
        expected: "a contract record",
        actual: undefined,
      });
    }
  }
  for (const fixture of actualFixtures) {
    if (!(fixture in expected.files)) {
      diffs.push({
        fixture,
        path: "<record>",
        expected: undefined,
        actual: "a contract record",
      });
    }
  }

  for (const fixture of expectedFixtures) {
    const expectation = expected.files[fixture];
    const record = records.get(fixture);
    if (!record) continue;

    diffs.push(...diffJson(fixture, "kind", expectation.kind, record.kind));

    const raw = readFileSync(join(build.corpusDir, fixture));
    diffs.push(
      ...diffJson(fixture, "rawBytes", expectation.rawBytes, raw.length),
    );
    if (expectation.kind === "todos") {
      if (record.kind !== "todos") continue;
      if (expectation.todoCount !== undefined) {
        diffs.push(
          ...diffJson(
            fixture,
            "todoCount",
            expectation.todoCount,
            record.todoCount,
          ),
        );
      }
      // Self-consistency check, not a golden field: the record's own count
      // must agree with the record's own todo list.
      diffs.push(
        ...diffJson(
          fixture,
          "todoCount === todos.length",
          record.todoCount,
          record.todos.length,
        ),
      );
      if (expectation.serialized) {
        diffs.push(
          ...diffJson(
            fixture,
            "serialized",
            expectation.serialized,
            record.serialized,
          ),
        );
      }
      if (expectation.todos) {
        diffs.push(
          ...diffJson(fixture, "todos", expectation.todos, record.todos),
        );
      }
      for (const sample of expectation.samples ?? []) {
        diffs.push(
          ...diffJson(
            fixture,
            `todos[${sample.index}]`,
            sample.todo,
            record.todos[sample.index],
          ),
        );
      }
    } else if (record.kind === "error") {
      const expectedError = expectation.error ?? {};
      const actualError = record.error as unknown as Record<string, unknown>;
      for (const key of Object.keys(expectedError)) {
        diffs.push(
          ...diffJson(
            fixture,
            `error.${key}`,
            expectedError[key],
            actualError[key],
          ),
        );
      }
      for (const key of Object.keys(actualError)) {
        if (!(key in expectedError)) {
          diffs.push({
            fixture,
            path: `error.${key}`,
            expected: undefined,
            actual: actualError[key],
          });
        }
      }
    }
  }

  return diffs;
};
