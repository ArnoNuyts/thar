import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { build as viteBuild } from "vite";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  type ContractBuild,
  DEFAULT_CORPUS_DIR,
  REPO_ROOT,
  buildContract,
  listFixtures,
} from "../tools/port/build.ts";
import { pinClock } from "../tools/port/clock.ts";
import { compareContracts } from "../tools/port/compare.ts";
import { verifyGolden } from "../tools/port/golden.ts";

/**
 * CP1 contract harness coverage.
 *
 * The contract is built in-process once (plus one deliberate rebuild for the
 * determinism assertion), and the CLI runs as the same plain-Node bundle the
 * self-test uses, so exit codes, diagnostics and the candidate protocol are
 * exercised without paying `vite-node` startup per case. The seeded-bug proof
 * runs as the script CI runs, so a broken mutation check fails `npm test` too.
 */

const RealDate = globalThis.Date;

let contract: ContractBuild;
let harnessPath: string;
let tempRoot: string;
/** Small corpus for CLI cases: exit codes do not need the 10 000-row fixture. */
let tinyCorpus: string;
let oraclePath: string;
let tamperedPath: string;

/** Bundle the harness once: ~0.2 s, then ~0.4 s per spawned run. */
const bundleHarness = async (outDir: string): Promise<string> => {
  await viteBuild({
    configFile: false,
    logLevel: "silent",
    root: REPO_ROOT,
    build: {
      ssr: join(REPO_ROOT, "tools", "port", "contract.ts"),
      outDir,
      emptyOutDir: false,
      target: "node22",
      minify: false,
      rollupOptions: { output: { entryFileNames: "contract.mjs" } },
    },
    ssr: { target: "node", noExternal: true },
  });
  return join(outDir, "contract.mjs");
};

beforeAll(async () => {
  tempRoot = mkdtempSync(join(tmpdir(), "thar-port-test-"));
  contract = buildContract({ corpusDir: DEFAULT_CORPUS_DIR });

  tinyCorpus = join(tempRoot, "corpus");
  mkdirSync(tinyCorpus);
  const tinyFixtures = ["control-nul.txt", "crlf.txt", "tags.txt"];
  for (const fixture of tinyFixtures) {
    copyFileSync(join(DEFAULT_CORPUS_DIR, fixture), join(tinyCorpus, fixture));
  }
  const tinyOracle = buildContract({ corpusDir: tinyCorpus });
  oraclePath = join(tempRoot, "oracle.jsonl");
  writeFileSync(oraclePath, tinyOracle.jsonl);

  tamperedPath = join(tempRoot, "tampered.jsonl");
  const tampered = tinyOracle.jsonl.replace(
    /"serialized":\{"sha256":"[0-9a-f]{64}"/,
    `"serialized":{"sha256":"${"0".repeat(64)}"`,
  );
  expect(tampered).not.toEqual(tinyOracle.jsonl);
  writeFileSync(tamperedPath, tampered);

  harnessPath = await bundleHarness(tempRoot);
}, 300_000);

afterAll(() => {
  globalThis.Date = RealDate;
  rmSync(tempRoot, { recursive: true, force: true });
});

/** Quote one token for a `--candidate` command string. */
const quoteToken = (token: string): string =>
  /^[A-Za-z0-9_./:=+-]+$/.test(token)
    ? token
    : `"${token.replace(/(["\\])/g, "\\$1")}"`;

/** A candidate command that runs `script` with plain Node. */
const nodeCommand = (script: string): string =>
  // `--` ends Node's own option parsing so the harness-appended flags reach
  // the script instead of being rejected as bad Node options.
  [process.execPath, "-e", script, "--"].map(quoteToken).join(" ");

interface RunOptions {
  env?: Record<string, string | undefined>;
}

const runCli = (args: string[], options: RunOptions = {}) => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.THAR_PORT_MUTATION;
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return spawnSync(process.execPath, [harnessPath, ...args], {
    cwd: REPO_ROOT,
    env,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
};

const describeRun = (result: ReturnType<typeof runCli>): string =>
  `status=${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;

/** CLI run against the small corpus (fast: no 10 000-row fixture). */
const runTiny = (args: string[], options: RunOptions = {}) =>
  runCli(["--corpus", tinyCorpus, ...args], options);

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
    // The one intentional rebuild: everything else reuses `contract`.
    const second = buildContract({ corpusDir: DEFAULT_CORPUS_DIR });

    expect(contract.jsonl.length).toBeGreaterThan(1_000_000);
    expect(second.jsonl).toEqual(contract.jsonl);
    expect(second.records).toEqual(contract.records);
  });

  test("pinning the clock twice is idempotent", () => {
    const first = pinClock("2026-11-15T12:00:00");
    const installed = globalThis.Date;

    const second = pinClock("2026-11-15T12:00:00");

    expect(second).toEqual(first);
    // Not a Date subclass of a Date subclass: the constructor is unchanged.
    expect(globalThis.Date).toBe(installed);
    expect(Object.getPrototypeOf(globalThis.Date)).toBe(RealDate);

    const now = new Date();
    expect(now.getTime()).toEqual(first.fixedTime);
    expect(now instanceof globalThis.Date).toBe(true);
    expect(now instanceof RealDate).toBe(true);
    expect(new Date(0).getTime()).toEqual(0);
  });

  test("records are ordered bytewise by fixture name", () => {
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
    expect(verifyGolden(contract)).toEqual([]);
  });

  test("the comparator accepts the oracle and rejects tampered contracts", () => {
    const { jsonl } = contract;
    const clean = compareContracts(jsonl, jsonl);
    expect(clean.diffs).toEqual([]);
    expect(clean.truncated).toBe(false);

    const changed = jsonl.replace(
      /"serialized":\{"sha256":"[0-9a-f]{64}"/,
      `"serialized":{"sha256":"${"0".repeat(64)}"`,
    );
    const changedDiff = compareContracts(jsonl, changed).diffs[0];
    expect(changedDiff?.path).toEqual("serialized.sha256");

    // A zero cap must never hide a difference, even though the CLI rejects 0.
    const zeroCap = compareContracts(jsonl, changed, 0);
    expect(zeroCap.diffs).toHaveLength(1);
    expect(zeroCap.truncated).toBe(true);

    const capped = compareContracts(jsonl, changed, 1);
    expect(capped.diffs).toHaveLength(1);
    expect(capped.truncated).toBe(true);

    const reordered = jsonl.replace(
      '"text":"First todo","state":"todo"',
      '"state":"todo","text":"First todo"',
    );
    const reorderedDiffs = compareContracts(jsonl, reordered).diffs;
    expect(reorderedDiffs[0]?.path).toEqual("todos[0].__keys");
    // The first key that moved is named separately so a long key list stays
    // diagnosable after truncation.
    expect(reorderedDiffs[1]?.path).toEqual("todos[0].__keys[0]");
    expect(reorderedDiffs[1]?.expected).toEqual("text");
    expect(reorderedDiffs[1]?.actual).toEqual("state");

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

describe("port contract CLI", () => {
  test("rejects a zero diff cap and still fails a capped walk", () => {
    const zero = runTiny([
      "--check",
      "--candidate-file",
      oraclePath,
      "--max-diffs",
      "0",
    ]);
    expect(zero.status, describeRun(zero)).toEqual(1);
    expect(zero.stderr).toContain("--max-diffs must be a positive integer");
    expect(zero.stderr).not.toMatch(/\n\s+at /);

    const capped = runTiny([
      "--check",
      "--candidate-file",
      tamperedPath,
      "--max-diffs",
      "1",
    ]);
    expect(capped.status, describeRun(capped)).toEqual(2);
    expect(capped.stderr).toContain("at least 1 diff(s)");
    expect(capped.stderr).toContain("serialized.sha256");
  }, 120_000);

  test("reports bad input as one bounded line, not a stack trace", () => {
    const missing = runCli(["--corpus", join(tempRoot, "absent")]);
    expect(missing.status, describeRun(missing)).toEqual(1);
    expect(missing.stderr).toContain("cannot read the corpus directory");
    expect(missing.stderr).not.toMatch(/\n\s+at /);

    const emptyCorpus = mkdtempSync(join(tempRoot, "empty-"));
    const empty = runCli([
      "--corpus",
      emptyCorpus,
      "--check",
      "--candidate-file",
      oraclePath,
    ]);
    expect(empty.status, describeRun(empty)).toEqual(1);
    expect(empty.stderr).toContain("no fixtures found");

    const unreadable = mkdtempSync(join(tempRoot, "unreadable-"));
    mkdirSync(join(unreadable, "bad.txt"));
    const unreadableRun = runCli(["--corpus", unreadable]);
    expect(unreadableRun.status, describeRun(unreadableRun)).toEqual(1);
    expect(unreadableRun.stderr).toContain("cannot read fixture");
    expect(unreadableRun.stderr).toContain("is a directory");

    const badClock = runCli(["--clock", "2026-02-30T12:00:00"]);
    expect(badClock.status, describeRun(badClock)).toEqual(1);
    expect(badClock.stderr).toContain("Invalid --clock value");
    expect(badClock.stderr).not.toMatch(/\n\s+at /);
  }, 120_000);

  test("a candidate that does not produce a contract exits 1", () => {
    const spawnFailure = runTiny([
      "--check",
      "--candidate",
      "thar-port-command-that-does-not-exist",
    ]);
    expect(spawnFailure.status, describeRun(spawnFailure)).toEqual(1);
    expect(spawnFailure.stderr).toContain("candidate could not run");

    const nonZero = runTiny([
      "--check",
      "--candidate",
      nodeCommand("process.exit(3)"),
    ]);
    expect(nonZero.status, describeRun(nonZero)).toEqual(1);
    expect(nonZero.stderr).toContain("candidate exited with code 3");

    const noOutput = runTiny([
      "--check",
      "--candidate",
      nodeCommand("process.exit(0)"),
    ]);
    expect(noOutput.status, describeRun(noOutput)).toEqual(1);
    expect(noOutput.stderr).toContain("did not write");
  }, 120_000);

  test("invalid UTF-8 is reported for both candidate paths", () => {
    const invalidFile = join(tempRoot, "invalid-utf8.jsonl");
    writeFileSync(invalidFile, Buffer.from([0xff, 0x28, 0x0a]));

    const fromFile = runTiny(["--check", "--candidate-file", invalidFile]);
    expect(fromFile.status, describeRun(fromFile)).toEqual(2);
    expect(fromFile.stderr).toContain("candidate output is not valid UTF-8");
    expect(fromFile.stderr).not.toContain("not valid JSON");

    const fromCommand = runTiny([
      "--check",
      "--candidate",
      nodeCommand(
        "require('node:fs').writeFileSync(require('node:process').argv.at(-1), Buffer.from([0xff, 0x28]))",
      ),
    ]);
    expect(fromCommand.status, describeRun(fromCommand)).toEqual(2);
    expect(fromCommand.stderr).toContain("candidate output is not valid UTF-8");
  }, 120_000);

  test("refuses to compare the oracle with itself", () => {
    const shared = join(tempRoot, "self.jsonl");
    const result = runCli([
      "--out",
      shared,
      "--check",
      "--candidate-file",
      shared,
    ]);

    expect(result.status, describeRun(result)).toEqual(1);
    expect(result.stderr).toContain("compared with itself");
    expect(existsSync(shared)).toBe(false);
  }, 120_000);

  test("--verify-golden alone prints a summary", () => {
    const result = runCli(["--verify-golden"]);

    expect(result.status, describeRun(result)).toEqual(0);
    expect(result.stdout).toEqual("");
    expect(result.stderr).toMatch(
      /port-contract: match \(golden, \d+ fixture record\(s\)/,
    );
  }, 120_000);

  test("the mutation hook never reaches the candidate", () => {
    // The oracle is mutated through the exported hook; the candidate must not
    // inherit it, otherwise both sides mutate and the check would pass.
    const hooked = runTiny(["--check", "--candidate-self"], {
      env: { THAR_PORT_MUTATION: "drop-done-marker" },
    });
    expect(hooked.status, describeRun(hooked)).toEqual(2);
    expect(hooked.stderr).toContain("serialized.sha256");

    const clean = runTiny(["--check", "--candidate-self"]);
    expect(clean.status, describeRun(clean)).toEqual(0);
  }, 120_000);

  test("candidate options require --check", () => {
    const result = runCli([
      "--candidate-self",
      "--out",
      join(tempRoot, "x.jsonl"),
    ]);

    expect(result.status, describeRun(result)).toEqual(1);
    expect(result.stderr).toContain("require --check");
  }, 120_000);
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

    expect(result.status, `${result.stdout}\n${result.stderr}`).toEqual(0);
    // Deprecation noise from Vite/Rolldown is allowed; a harness failure is not.
    expect(result.stderr).not.toContain("port-selftest: FAILED");
    expect(result.stdout).toContain("port-selftest: ok");
    expect(result.stdout).toContain("diff cap:");
    expect(result.stdout).toContain("env hook:");
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
