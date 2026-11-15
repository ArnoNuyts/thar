import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import expectedJson from "../testdata/port/expected.json" with { type: "json" };
import { DEFAULT_CORPUS_DIR } from "../tools/port/build.ts";
import { compareContracts } from "../tools/port/compare.ts";
import {
  GUARD_PROBE_FIXTURES,
  REJECTED_GUARD_PROBE_FIXTURES,
  WRITE_MUTATION_NAMES,
  WRITE_MUTATIONS,
  buildCandidateContract,
  buildWriteContract,
} from "../tools/port/write.ts";

/**
 * CP4 write-contract coverage.
 *
 * The contract is built in-process on a small corpus so `npm test` stays fast;
 * the full-corpus run and the WASM candidate are the
 * `npm run port:contract:write[:wasm]` gates. The seeded mutations prove the
 * comparator catches a changed file, and the guard probes prove the write-time
 * control-character rule is part of the contract instead of an untested corner.
 */

type ExpectedCorpus = {
  files: Record<string, { kind: "todos" | "error" }>;
};

const expected = expectedJson as unknown as ExpectedCorpus;

let tempRoot: string;
let corpusDir: string;
let baseline: ReturnType<typeof buildWriteContract>;

beforeAll(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "thar-write-test-"));
  corpusDir = join(tempRoot, "corpus");
  mkdirSync(corpusDir);

  // A rejection fixture, an ambiguous-dates fixture (two date slots), a tags
  // fixture (the last tag is removable), a Unicode fixture and the empty list.
  for (const fixture of [
    "control-nul.txt",
    "empty.txt",
    "leading-dates-done.txt",
    "tags.txt",
    "unicode.txt",
  ]) {
    copyFileSync(join(DEFAULT_CORPUS_DIR, fixture), join(corpusDir, fixture));
  }

  baseline = buildWriteContract({ corpusDir });
}, 120_000);

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

const recordFor = (fixture: string) => {
  const record = baseline.records.find(
    (candidate) => candidate.fixture === fixture,
  );
  if (record === undefined) throw new Error(`no record for ${fixture}`);
  return record;
};

describe("write contract determinism", () => {
  test("two runs are byte-identical and skip rejection fixtures", () => {
    const second = buildWriteContract({ corpusDir });

    expect(second.jsonl).toEqual(baseline.jsonl);
    expect(second.records).toEqual(baseline.records);
    expect(baseline.skipped).toEqual(["control-nul.txt"]);
    expect(baseline.fixtures).toEqual([
      ...baseline.records.map((r) => r.fixture),
    ]);
  });

  test("the skipped set is exactly CP1's rejection fixtures", () => {
    // The full corpus, so a new unparseable fixture fails here instead of
    // silently shrinking the write contract.
    const full = buildWriteContract();
    const cp1Errors = Object.entries(expected.files)
      .filter(([, file]) => file.kind === "error")
      .map(([fixture]) => fixture)
      .sort((left, right) =>
        Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
      );

    expect(full.skipped).toEqual(cp1Errors);
    // Every parseable fixture plus every guard probe is covered.
    const covered = new Set(full.fixtures);
    for (const [fixture, file] of Object.entries(expected.files)) {
      if (file.kind === "todos")
        expect(covered.has(fixture), fixture).toBe(true);
    }
    for (const fixture of GUARD_PROBE_FIXTURES) {
      expect(covered.has(fixture), fixture).toBe(true);
    }
  });
});

describe("write contract schema", () => {
  test("records use the pinned key order", () => {
    for (const record of baseline.records) {
      if (record.kind === "todos") {
        expect(Object.keys(record)).toEqual([
          "fixture",
          "kind",
          "todoCount",
          "serialized",
        ]);
        expect(Object.keys(record.serialized)).toEqual(["sha256", "bytes"]);
        expect(record.serialized.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(record.serialized.bytes).toBeGreaterThan(0);
      } else {
        expect(Object.keys(record)).toEqual([
          "fixture",
          "kind",
          "lineNumber",
          "codePoint",
        ]);
        expect(record.lineNumber).toBeGreaterThanOrEqual(1);
      }
    }
  });

  test("an empty todo list serializes to one newline, not to nothing", () => {
    const empty = recordFor("empty.txt");
    expect(empty.kind).toBe("todos");
    if (empty.kind !== "todos") return;
    expect(empty.todoCount).toEqual(0);
    expect(empty.serialized.bytes).toEqual(1);
    expect(empty.serialized.sha256).toEqual(
      "01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b",
    );
  });

  test("the guard probes pin the first line and the first code point", () => {
    for (const fixture of REJECTED_GUARD_PROBE_FIXTURES) {
      const record = recordFor(fixture);
      expect(record.kind, fixture).toBe("rejected");
    }

    const nul = recordFor("guard-nul");
    expect(nul).toMatchObject({
      kind: "rejected",
      lineNumber: 2,
      codePoint: 0,
    });
    const esc = recordFor("guard-esc");
    expect(esc).toMatchObject({
      kind: "rejected",
      lineNumber: 1,
      codePoint: 0x1b,
    });
    // Tab stays allowed: the probe is a normal record.
    expect(recordFor("guard-tab").kind).toBe("todos");
  });
});

describe("the structured records are lossless for serialization", () => {
  test("rendering the DTO reproduces the oracle bytes for every fixture", () => {
    // The app sends exactly these records to Rust; if `coreTodoRecord` lost
    // anything (an array tag, a round-trip flag), this diff would catch it.
    const candidate = buildCandidateContract(baseline.manifest);
    expect(candidate).toEqual(baseline.records);
  });
});

describe("seeded writer mutations", () => {
  const mutationFixtures = (name: (typeof WRITE_MUTATION_NAMES)[number]) =>
    buildWriteContract({ corpusDir, mutation: name });

  test("every mutation is caught", () => {
    for (const name of WRITE_MUTATION_NAMES) {
      const mutated = mutationFixtures(name);
      const result = compareContracts(baseline.jsonl, mutated.jsonl, 1);
      const caught = result.diffs.length > 0 || result.omitted > 0;
      expect(caught, `${name}: ${WRITE_MUTATIONS[name].description}`).toBe(
        true,
      );
    }
  });

  test("each mutation is caught on the fixture that carries the shape", () => {
    const fixturesWithDiff = (name: (typeof WRITE_MUTATION_NAMES)[number]) => {
      const result = compareContracts(
        baseline.jsonl,
        mutationFixtures(name).jsonl,
        50,
      );
      return new Set(result.diffs.map((diff) => diff.fixture));
    };

    // The trailing newline disappears from every record.
    expect(fixturesWithDiff("drop-trailing-newline").size).toBeGreaterThan(1);
    const dateFixtures = fixturesWithDiff("swap-date-order");
    expect(dateFixtures.has("leading-dates-done.txt")).toBe(true);
    // Only a completed line with both dates can be swapped.
    expect(dateFixtures.has("tags.txt")).toBe(false);
    expect(fixturesWithDiff("drop-last-tag").has("tags.txt")).toBe(true);
  });
});
