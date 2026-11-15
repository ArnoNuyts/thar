import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { DEFAULT_CORPUS_DIR, listFixtures } from "../tools/port/build.ts";
import { pinClock } from "../tools/port/clock.ts";
import { compareContracts, formatDiff } from "../tools/port/compare.ts";
import {
  GENERATED_FIXTURE,
  ROWS_MUTATION_NAMES,
  type RowsRecord,
  buildRowsContract,
  createGeneratedLines,
  createManifest,
  rowsRecordLabel,
} from "../tools/port/rows.ts";
import {
  defaultCollatorLocale,
  isEnglishCollator,
} from "../utils/collation-locale.ts";
import { extractSearchTerms } from "../utils/search-utils.ts";

/**
 * CP3b rows-contract coverage.
 *
 * The contract is built in-process on a small corpus (plus a short generated
 * list) so `npm test` stays fast; the full-corpus, full-1000-todo run is the
 * `npm run port:contract:rows` CI gate. The seeded mutations prove the
 * comparator catches a wrong row builder or query, not just a wrong candidate.
 */

const RealDate = globalThis.Date;

/**
 * The rows harness pins the en-US collation order (PLAN §13 decision 8). On a
 * host that resolves elsewhere the contract would produce genuine-looking
 * diffs, so these coverage tests skip instead of failing the Node matrix.
 */
const ENGLISH_COLLATOR = isEnglishCollator(defaultCollatorLocale());

let tempRoot: string;
let corpusDir: string;
let manifest: ReturnType<typeof createManifest>;
let baseline: ReturnType<typeof buildRowsContract>;

beforeAll(() => {
  if (!ENGLISH_COLLATOR) return;
  tempRoot = mkdtempSync(join(tmpdir(), "thar-rows-test-"));
  corpusDir = join(tempRoot, "corpus");
  mkdirSync(corpusDir);

  // One rejection fixture, one uncategorised/priority fixture, one with
  // contexts and thresholds, and one Unicode fixture.
  for (const fixture of [
    "control-nul.txt",
    "due-threshold-hidden.txt",
    "tags.txt",
    "unicode.txt",
  ]) {
    copyFileSync(join(DEFAULT_CORPUS_DIR, fixture), join(corpusDir, fixture));
  }

  manifest = {
    ...createManifest("2026-11-15T12:00:00"),
    generated: [
      { fixture: GENERATED_FIXTURE, lines: createGeneratedLines(60) },
    ],
  };
  baseline = buildRowsContract({ corpusDir, manifest });
}, 120_000);

afterAll(() => {
  if (!ENGLISH_COLLATOR) return;
  globalThis.Date = RealDate;
  rmSync(tempRoot, { recursive: true, force: true });
});

const recordsFor = (fixture: string): RowsRecord[] =>
  baseline.records.filter((record) => record.fixture === fixture);

describe.skipIf(!ENGLISH_COLLATOR)("rows contract determinism", () => {
  test("two runs are byte-identical and skip rejection fixtures", () => {
    const second = buildRowsContract({ corpusDir, manifest });

    expect(second.jsonl).toEqual(baseline.jsonl);
    expect(second.records).toEqual(baseline.records);

    const fixtures = new Set(baseline.records.map((record) => record.fixture));
    expect(fixtures.has("control-nul.txt")).toBe(false);
    expect(fixtures.has("tags.txt")).toBe(true);
    expect(fixtures.has(GENERATED_FIXTURE)).toBe(true);
  });

  test("every (fixture, query, showHidden) combination is present once", () => {
    const fixtures = new Set(baseline.records.map((record) => record.fixture));
    expect(baseline.records.length).toBe(
      fixtures.size * manifest.queries.length * manifest.showHidden.length,
    );

    const keys = baseline.records.map(
      (record) =>
        `${record.fixture}\u0000${record.query}\u0000${record.showHidden}`,
    );
    expect(new Set(keys).size).toBe(keys.length);

    // The oracle's own order: fixture → query → showHidden.
    for (const record of baseline.records) {
      expect(record.clockLocal).toEqual(manifest.clockLocal);
      expect(record.terms).toEqual(extractSearchTerms(record.query));
    }
  });
});

describe.skipIf(!ENGLISH_COLLATOR)("rows contract schema", () => {
  test("records use the pinned key order and a fixed row shape", () => {
    for (const record of baseline.records) {
      expect(Object.keys(record)).toEqual([
        "fixture",
        "query",
        "terms",
        "showHidden",
        "clockLocal",
        "todoCount",
        "rows",
        "order",
      ]);

      let todoRows = 0;
      for (const row of record.rows) {
        if (row.type === "context") {
          expect(Object.keys(row)).toEqual([
            "type",
            "contextName",
            "todoCount",
          ]);
          expect(row.contextName.length).toBeGreaterThan(0);
          expect(row.todoCount).toBeGreaterThan(0);
        } else {
          expect(Object.keys(row)).toEqual(["type", "number", "index"]);
          todoRows += 1;
          expect(row.number).toEqual(todoRows);
          expect(row.index).toBeGreaterThanOrEqual(0);
        }
      }

      expect(record.order).toHaveLength(todoRows);
      expect(record.todoCount).toEqual(todoRows);
      expect(record.rows.filter((row) => row.type === "todo")).toHaveLength(
        record.order.length,
      );

      // Every todo row's `index` is the ordered input index, and headers
      // report the number of todo rows in their contiguous group.
      const todoIndexes = record.rows
        .filter((row) => row.type === "todo")
        .map((row) => row.index);
      expect(todoIndexes).toEqual(record.order);

      let counted = 0;
      for (const [index, row] of record.rows.entries()) {
        if (row.type !== "context") continue;
        counted = 0;
        for (
          let next = index + 1;
          next < record.rows.length && record.rows[next].type === "todo";
          next++
        ) {
          counted++;
        }
        expect(row.todoCount).toEqual(counted);
      }
    }
  });

  test("the uncategorised group keeps its `None` header", () => {
    const record = recordsFor("tags.txt").find(
      (entry) => entry.query === "" && !entry.showHidden,
    );
    expect(record).toBeDefined();
    expect(record?.rows.some((row) => row.type === "context")).toBe(true);

    const none = record?.rows.filter(
      (row) => row.type === "context" && row.contextName === "None",
    );
    expect(none?.length).toBeGreaterThan(0);
  });

  test("hidden and threshold todos follow showHidden", () => {
    const hidden = recordsFor("due-threshold-hidden.txt").filter(
      (record) => record.query === "",
    );
    const hiddenOff = hidden.find((record) => !record.showHidden);
    const hiddenOn = hidden.find((record) => record.showHidden);
    expect(hiddenOff).toBeDefined();
    expect(hiddenOn).toBeDefined();
    expect(hiddenOn?.todoCount ?? 0).toBeGreaterThan(hiddenOff?.todoCount ?? 0);
  });

  test("an empty query matches everything and `!!!` has no usable term", () => {
    const empty = recordsFor(GENERATED_FIXTURE).find(
      (record) => record.query === "" && !record.showHidden,
    );
    const bang = recordsFor(GENERATED_FIXTURE).find(
      (record) => record.query === "!!!" && !record.showHidden,
    );

    expect(bang?.terms).toEqual([]);
    expect(bang?.order).toEqual(empty?.order);
  });

  test("the reverse final-sigma queries match the generated probe line", () => {
    // Without a line that JS-lowercases to `aβ́ς.` / `aσ.`, both queries matched
    // nothing and the contract only proved "empty == empty".
    for (const query of ["aΣ.Α", "aβ\u0301Σ."]) {
      const matched = recordsFor(GENERATED_FIXTURE).filter(
        (record) => record.query === query && !record.showHidden,
      );
      expect(matched).toHaveLength(1);
      expect(matched[0]?.terms).toHaveLength(1);
      expect(matched[0]?.order.length).toBeGreaterThan(0);
      expect(matched[0]?.order.length).toBeLessThan(
        // The probe is one line, not the whole list.
        recordsFor(GENERATED_FIXTURE).filter(
          (record) => record.query === "" && !record.showHidden,
        )[0]?.order.length ?? 0,
      );
    }
  });
});

describe.skipIf(!ENGLISH_COLLATOR)("rows contract coverage (F11)", () => {
  /** CP1's rejection fixtures, from `expected.json` (`kind: "error"`). */
  const cp1ErrorFixtures = (): string[] => {
    const expected = JSON.parse(
      readFileSync(join(DEFAULT_CORPUS_DIR, "expected.json"), "utf8"),
    ) as { files: Record<string, { kind?: string }> };
    return Object.entries(expected.files)
      .filter(([, record]) => record.kind === "error")
      .map(([name]) => name)
      .sort();
  };

  test("the skipped set is exactly CP1's error records", () => {
    // A one-query manifest keeps this fast; the set is a property of the corpus,
    // not of the query list.
    const manifest = {
      ...createManifest("2026-11-15T12:00:00"),
      queries: [{ query: "", terms: [] }],
      showHidden: [false],
      generated: [],
    };
    const full = buildRowsContract({ corpusDir: DEFAULT_CORPUS_DIR, manifest });

    const expected = cp1ErrorFixtures();
    expect(full.skipped.slice().sort()).toEqual(expected);
    expect(expected).toHaveLength(8);
    expect(full.fixtures).toHaveLength(
      listFixtures(DEFAULT_CORPUS_DIR).length - expected.length,
    );
    // No fixture is in both sets.
    for (const name of full.skipped) {
      expect(full.fixtures).not.toContain(name);
    }
  });
});

describe.skipIf(!ENGLISH_COLLATOR)("rows contract mutation proof", () => {
  test("every seeded mutation is caught", () => {
    for (const mutation of ROWS_MUTATION_NAMES) {
      const mutated = buildRowsContract({ corpusDir, manifest, mutation });
      const result = compareContracts(baseline.jsonl, mutated.jsonl, 5);

      expect(
        result.diffs.length + result.omitted,
        `${mutation} was not caught`,
      ).toBeGreaterThan(0);
    }
  });

  test("the comparator catches a tampered candidate record", () => {
    const tampered = baseline.jsonl.replace(
      /"todoCount":(\d+)/,
      '"todoCount":99999',
    );
    expect(tampered).not.toEqual(baseline.jsonl);

    const result = compareContracts(baseline.jsonl, tampered, 5);
    expect(result.diffs.length).toBeGreaterThan(0);
    expect(result.diffs[0]?.path).toContain("todoCount");
  }, 60_000);

  test("diffs carry the record coordinates, so identical lines are distinguishable", () => {
    const lines = baseline.jsonl.trimEnd().split("\n");
    const position = lines.findIndex(
      (line) => (JSON.parse(line) as RowsRecord).fixture === GENERATED_FIXTURE,
    );
    expect(position).toBeGreaterThanOrEqual(0);
    const record = JSON.parse(lines[position] as string) as RowsRecord;
    const tampered = [...lines];
    tampered[position] = JSON.stringify({ ...record, todoCount: 99999 });

    const result = compareContracts(
      baseline.jsonl,
      `${tampered.join("\n")}\n`,
      5,
      { recordLabel: rowsRecordLabel },
    );

    expect(result.diffs.length).toBeGreaterThan(0);
    const first = result.diffs[0];
    expect(first?.record).toBe(
      `record ${position} query=${JSON.stringify(record.query)} showHidden=${record.showHidden}`,
    );
    expect(formatDiff(first!)).toContain(`[${first?.record}]`);
    expect(formatDiff(first!)).toContain(GENERATED_FIXTURE);
  }, 60_000);

  test("pinning a different clock changes the contract", () => {
    // 2026-11-15 hides a `t:2026-11-16` todo; a day later the threshold has
    // passed. This proves the clock is part of the measured contract.
    const later = buildRowsContract({
      corpusDir,
      manifest: { ...manifest, clockLocal: "2026-11-16T12:00:00" },
    });
    expect(later.jsonl).not.toEqual(baseline.jsonl);
    pinClock(manifest.clockLocal);
  });
});
