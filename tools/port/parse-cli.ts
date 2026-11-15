import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InvalidLimitError } from "../../logic/limits.ts";
import { CorpusError, DEFAULT_CORPUS_DIR } from "./build.ts";
import { InvalidClockError } from "./clock.ts";
import { bounded, CandidateCommandError } from "./candidate.ts";
import { compareContracts, formatDiff } from "./compare.ts";
import {
  PARSE_MUTATION_NAMES,
  PARSE_MUTATIONS,
  ParseHarnessError as HarnessError,
  type ParseMutationName,
  buildParseContract,
  isParseMutationName,
} from "./parse.ts";

/**
 * CLI for the CP3b2c parse contract. See `parse.ts` for the contract itself.
 *
 * ```sh
 * npm run port:contract:parse        # TS-only: self candidate + mutation proof
 * npm run port:contract:parse:wasm   # the wired THAR_CORE=rust read path
 * ```
 *
 * Exit codes match the CP1, rows and write harnesses: 0 match, 2 mismatch,
 * 1 harness error.
 */

const EXIT_MATCH = 0;
const EXIT_HARNESS_ERROR = 1;
const EXIT_MISMATCH = 2;

/**
 * Small corpus for the self-check: a CRLF file (order), the two leading-date
 * fixtures (both flags), and a tag fixture (array-valued tags).
 */
const SELFTEST_FIXTURES = [
  "crlf.txt",
  "leading-dates-done.txt",
  "leading-dates-done-invalid.txt",
  "tags.txt",
];

interface Options {
  corpusDir: string;
  clockLocal?: string;
  out?: string;
  check: boolean;
  candidateSelf: boolean;
  candidateWasm: boolean;
  mutate?: ParseMutationName;
  maxDiffs: number;
  selftest: boolean;
  help: boolean;
}

const usage = `CP3b2c parse contract

Usage: vite-node tools/port/parse-cli.ts [options]

Options:
  --corpus <dir>            Fixture directory (default: testdata/port)
  --clock <yyyy-MM-ddTHH:mm:ss>
                            Pinned wall-clock time, UTC
  --out <file>              Write the oracle contract here instead of stdout
  --check                   Compare the candidate with the oracle
  --candidate-self          Candidate: oracle todos -> Todo.fromParts
  --candidate-wasm          Candidate: the wired THAR_CORE=rust read path
  --selftest                Prove the factory is lossless, the build is
                            deterministic, and every seeded mutation is caught
  --mutate <name>           TEST ONLY: build the self candidate with a seeded
                            mutation (one of ${PARSE_MUTATION_NAMES.join(", ")})
  --max-diffs <n>           Print at most n diffs (default: 20, minimum: 1)
  --help                    Show this help

Exit codes: 0 match, 2 mismatch, 1 harness error.
`;

const valueOf = (args: string[], index: number, name: string): string => {
  const value = args[index + 1];
  if (value === undefined) throw new HarnessError(`${name} requires a value`);
  return value;
};

const parseArgs = (args: string[]): Options => {
  const options: Options = {
    corpusDir: DEFAULT_CORPUS_DIR,
    check: false,
    candidateSelf: false,
    candidateWasm: false,
    maxDiffs: 20,
    selftest: false,
    help: false,
  };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    switch (arg) {
      case "--corpus":
        options.corpusDir = valueOf(args, index, arg);
        index++;
        break;
      case "--clock":
        options.clockLocal = valueOf(args, index, arg);
        index++;
        break;
      case "--out":
        options.out = valueOf(args, index, arg);
        index++;
        break;
      case "--check":
        options.check = true;
        break;
      case "--candidate-self":
        options.candidateSelf = true;
        break;
      case "--candidate-wasm":
        options.candidateWasm = true;
        break;
      case "--selftest":
        options.selftest = true;
        break;
      case "--mutate": {
        const name = valueOf(args, index, arg);
        if (!isParseMutationName(name)) {
          throw new HarnessError(
            `Unknown mutation ${JSON.stringify(name)}; expected one of ${PARSE_MUTATION_NAMES.join(", ")}`,
          );
        }
        options.mutate = name;
        index++;
        break;
      }
      case "--max-diffs": {
        const value = Number(valueOf(args, index, arg));
        if (!Number.isSafeInteger(value) || value < 1) {
          throw new HarnessError(
            "--max-diffs must be a positive integer (at least 1); " +
              "a cap of 0 would hide every difference",
          );
        }
        options.maxDiffs = value;
        index++;
        break;
      }
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new HarnessError(`Unknown argument ${JSON.stringify(arg)}`);
    }
  }

  return options;
};

/** Translate corpus/clock/limit errors into one bounded harness line. */
const asHarnessError = (error: unknown): unknown => {
  if (error instanceof HarnessError) return error;
  if (
    error instanceof CorpusError ||
    error instanceof InvalidLimitError ||
    error instanceof InvalidClockError
  ) {
    return new HarnessError(bounded(error.message));
  }
  return error;
};

const reportDiffs = (
  diffs: ReturnType<typeof compareContracts>["diffs"],
  omitted: number,
  truncated: boolean,
): void => {
  const shown = diffs.length;
  const total = shown + omitted;
  const notes: string[] = [];
  if (omitted > 0) notes.push(`${omitted} omitted`);
  if (truncated) notes.push("walk stopped at the --max-diffs cap");
  process.stderr.write(
    `port-parse: ${truncated ? `at least ${total}` : `${total}`} diff(s)` +
      (notes.length > 0 ? ` (showing ${shown}, ${notes.join("; ")})` : "") +
      "\n",
  );
  for (const diff of diffs) {
    process.stderr.write(`  ${formatDiff(diff)}\n`);
  }
};

const main = (): number => {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    process.stdout.write(usage);
    return EXIT_MATCH;
  }

  const candidates = [options.candidateSelf, options.candidateWasm].filter(
    Boolean,
  ).length;
  if (options.check && candidates !== 1) {
    throw new HarnessError(
      "--check requires exactly one of --candidate-self or --candidate-wasm",
    );
  }
  if (!options.check && candidates > 0) {
    throw new HarnessError(
      "--candidate-self and --candidate-wasm require --check",
    );
  }
  if (options.mutate !== undefined && !options.candidateSelf) {
    throw new HarnessError("--mutate requires --candidate-self");
  }

  const build = (
    candidate: "oracle" | "self" | "wasm",
    mutation?: ParseMutationName,
  ) =>
    buildParseContract({
      corpusDir: options.corpusDir,
      clockLocal: options.clockLocal,
      candidate,
      mutation,
    });

  let oracle: ReturnType<typeof build>;
  try {
    oracle = build("oracle");
  } catch (error) {
    throw asHarnessError(error);
  }

  if (oracle.records.length === 0) {
    throw new HarnessError(
      `no fixtures found in ${oracle.corpusDir}: expected at least one *.txt file`,
    );
  }

  if (options.selftest && options.mutate === undefined) {
    // The proof does not need the 10 000-todo fixture: a representative slice
    // covers CRLF, both round-trip flags and array-valued tags.
    const selftestDir = mkdtempSync(join(tmpdir(), "thar-parse-selftest-"));
    try {
      const copied = SELFTEST_FIXTURES.filter((fixture) => {
        const source = join(options.corpusDir, fixture);
        if (!existsSync(source)) return false;
        copyFileSync(source, join(selftestDir, fixture));
        return true;
      });
      if (copied.length === 0) {
        throw new HarnessError(
          `--selftest needs at least one of ${SELFTEST_FIXTURES.join(", ")}`,
        );
      }

      const oracleBuild = buildParseContract({
        corpusDir: selftestDir,
        clockLocal: options.clockLocal,
      });
      const baseline = buildParseContract({
        corpusDir: selftestDir,
        clockLocal: options.clockLocal,
        candidate: "self",
      });
      // The factory is lossless: the rebuilt list serializes and reports
      // exactly like the TypeScript reader over this slice.
      const lossless = compareContracts(oracleBuild.jsonl, baseline.jsonl, 1);
      if (lossless.diffs.length > 0 || lossless.omitted > 0) {
        throw new HarnessError(
          "Todo.fromParts is not lossless for the selftest corpus",
        );
      }
      // Determinism: two unmutated builds must be byte-identical.
      const second = buildParseContract({
        corpusDir: selftestDir,
        clockLocal: options.clockLocal,
        candidate: "self",
      });
      if (second.jsonl !== baseline.jsonl) {
        throw new HarnessError("two unmutated runs are not byte-identical");
      }

      for (const mutation of PARSE_MUTATION_NAMES) {
        const mutated = buildParseContract({
          corpusDir: selftestDir,
          clockLocal: options.clockLocal,
          candidate: "self",
          mutation,
        });
        const result = compareContracts(oracleBuild.jsonl, mutated.jsonl, 1);
        if (result.diffs.length === 0 && result.omitted === 0) {
          throw new HarnessError(
            `the comparator did not catch the ${mutation} mutation: ` +
              PARSE_MUTATIONS[mutation],
          );
        }
      }

      process.stderr.write(
        `port-parse: selftest ok (lossless, deterministic, ` +
          `${PARSE_MUTATION_NAMES.length} mutation(s) caught, ` +
          `${oracleBuild.records.length} record(s))\n`,
      );
    } finally {
      rmSync(selftestDir, { recursive: true, force: true });
    }
  }

  if (options.out) {
    writeFileSync(options.out, oracle.jsonl);
  } else if (!options.check) {
    if (process.stdout.isTTY) {
      process.stderr.write(
        "port-parse: stdout is a terminal; pass --out <file> to keep JSONL readable\n",
      );
    }
    process.stdout.write(oracle.jsonl);
  }

  const contractBytes = Buffer.byteLength(oracle.jsonl, "utf8");

  if (!options.check) {
    process.stderr.write(
      `port-parse: wrote ${oracle.records.length} record(s) (${contractBytes} bytes)\n`,
    );
    return EXIT_MATCH;
  }

  const candidate = options.candidateWasm
    ? build("wasm", options.mutate)
    : build("self", options.mutate);

  const result = compareContracts(
    oracle.jsonl,
    candidate.jsonl,
    options.maxDiffs,
  );
  if (result.diffs.length > 0 || result.omitted > 0) {
    reportDiffs(result.diffs, result.omitted, result.truncated);
    return EXIT_MISMATCH;
  }

  process.stderr.write(
    `port-parse: match (${candidate.candidate} candidate, ` +
      `${oracle.records.length} record(s), ${contractBytes} bytes)\n`,
  );
  return EXIT_MATCH;
};

try {
  process.exitCode = main();
} catch (error) {
  if (error instanceof HarnessError || error instanceof CandidateCommandError) {
    process.stderr.write(`port-parse: ${bounded(error.message)}\n`);
    process.exitCode = EXIT_HARNESS_ERROR;
  } else {
    throw error;
  }
}
