import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { InvalidLimitError } from "../../logic/limits.ts";
import {
  CorpusError,
  DEFAULT_CLOCK_LOCAL,
  DEFAULT_CORPUS_DIR,
} from "./build.ts";
import {
  CandidateCommandError,
  bounded,
  runCandidate,
  selfCommand,
  splitCommand,
} from "./candidate.ts";
import { InvalidClockError } from "./clock.ts";
import { compareContracts, decodeJsonlBytes, formatDiff } from "./compare.ts";
import {
  GENERATED_FIXTURE,
  ROWS_MUTATION_NAMES,
  ROWS_MUTATIONS,
  RowsHarnessError as HarnessError,
  type RowsManifest,
  type RowsMutationName,
  buildRowsContract,
  createGeneratedLines,
  createManifest,
  isRowsMutationName,
  rowsRecordLabel,
} from "./rows.ts";

/**
 * CLI for the CP3b live rows contract. See `rows.ts` for the contract itself.
 *
 * ```sh
 * npm run port:contract:rows        # TS-only: candidate protocol + self-check
 * npm run port:contract:rows:wasm   # the WASM candidate (needs crates/thar-wasm/pkg)
 * ```
 *
 * Exit codes match the CP1 harness: 0 match, 2 mismatch, 1 harness error.
 */

const EXIT_MATCH = 0;
const EXIT_HARNESS_ERROR = 1;
const EXIT_MISMATCH = 2;

/** Small corpus for the self-check: enough for every seeded mutation. */
const SELFTEST_FIXTURES = [
  "due-threshold-hidden.txt",
  "tags.txt",
  "unicode.txt",
  "projects-contexts.txt",
  "blank-lines.txt",
  "priorities.txt",
];

/** Todos in the self-check's generated list. */
const SELFTEST_TODO_COUNT = 120;

interface Options {
  corpusDir: string;
  clockLocal: string;
  out?: string;
  manifest?: string;
  check: boolean;
  candidate?: string;
  candidateSelf: boolean;
  mutate?: RowsMutationName;
  maxDiffs: number;
  selftest: boolean;
  help: boolean;
}

const usage = `CP3b live rows contract

Usage: vite-node tools/port/rows-cli.ts [options]

Options:
  --corpus <dir>            Fixture directory (default: testdata/port)
  --clock <yyyy-MM-ddTHH:mm:ss>
                            Pinned wall-clock time, UTC
                            (default: ${DEFAULT_CLOCK_LOCAL})
  --out <file>              Write the oracle contract here instead of stdout
  --check                   Compare a candidate contract with the oracle
  --candidate <command>     Candidate command, spawned with
                            --corpus <dir> --clock <iso> --manifest <file> --out <file>
  --candidate-self          Run this harness (vite-node) as the candidate
  --manifest <file>         CANDIDATE MODE: build from this manifest and write
                            --out; the harness passes it to a candidate
  --selftest                Two runs must be byte-identical and every seeded
                            mutation must be caught
  --mutate <name>           TEST ONLY: build a deliberately broken contract
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
    clockLocal: DEFAULT_CLOCK_LOCAL,
    check: false,
    candidateSelf: false,
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
      case "--manifest":
        options.manifest = valueOf(args, index, arg);
        index++;
        break;
      case "--check":
        options.check = true;
        break;
      case "--candidate":
        options.candidate = valueOf(args, index, arg);
        index++;
        break;
      case "--candidate-self":
        options.candidateSelf = true;
        break;
      case "--selftest":
        options.selftest = true;
        break;
      case "--mutate": {
        const name = valueOf(args, index, arg);
        if (!isRowsMutationName(name)) {
          throw new HarnessError(
            `Unknown mutation ${JSON.stringify(name)}; expected one of ${ROWS_MUTATION_NAMES.join(", ")}`,
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
    error instanceof InvalidClockError ||
    error instanceof InvalidLimitError
  ) {
    return new HarnessError(bounded(error.message));
  }
  return error;
};

/** Read a candidate manifest. */
const readManifest = (path: string): RowsManifest => {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new HarnessError(
      bounded(
        `cannot read manifest ${path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    );
  }

  let value: Partial<RowsManifest>;
  try {
    value = JSON.parse(text) as Partial<RowsManifest>;
  } catch {
    throw new HarnessError(`manifest ${path} is not valid JSON`);
  }

  if (
    typeof value.clockLocal !== "string" ||
    typeof value.today !== "string" ||
    typeof value.readLimits !== "object" ||
    value.readLimits === null ||
    !Array.isArray(value.queries) ||
    !Array.isArray(value.showHidden) ||
    !Array.isArray(value.generated)
  ) {
    throw new HarnessError(`manifest ${path} does not match the rows protocol`);
  }
  return value as RowsManifest;
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
    `port-rows: ${truncated ? `at least ${total}` : `${total}`} diff(s)` +
      (notes.length > 0 ? ` (showing ${shown}, ${notes.join("; ")})` : "") +
      "\n",
  );
  for (const diff of diffs) {
    process.stderr.write(`  ${formatDiff(diff)}\n`);
  }
};

const invalidUtf8 = (source: string): number => {
  process.stderr.write(
    `port-rows: candidate output is not valid UTF-8 (${source})\n`,
  );
  return EXIT_MISMATCH;
};

const main = (): number => {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    process.stdout.write(usage);
    return EXIT_MATCH;
  }

  const candidates = [
    options.candidate !== undefined,
    options.candidateSelf,
  ].filter(Boolean).length;

  if (options.check && candidates !== 1) {
    throw new HarnessError(
      "--check requires exactly one of --candidate or --candidate-self",
    );
  }
  if (!options.check && candidates > 0) {
    throw new HarnessError("--candidate and --candidate-self require --check");
  }

  // Candidate mode: the harness passes the manifest and the output file.
  if (options.manifest !== undefined) {
    if (options.out === undefined) {
      throw new HarnessError("--manifest requires --out");
    }
    const manifest = readManifest(options.manifest);
    const build = buildRowsContract({
      corpusDir: options.corpusDir,
      manifest,
    });
    writeFileSync(options.out, build.jsonl);
    return EXIT_MATCH;
  }

  let build: ReturnType<typeof buildRowsContract>;
  try {
    build = buildRowsContract({
      corpusDir: options.corpusDir,
      clockLocal: options.clockLocal,
      mutation: options.mutate,
    });
  } catch (error) {
    throw asHarnessError(error);
  }

  if (build.records.length === 0) {
    throw new HarnessError(
      `no fixtures found in ${build.corpusDir}: expected at least one *.txt file`,
    );
  }

  if (options.selftest && options.mutate === undefined) {
    // The proof does not need the 10 000-todo fixture: a representative slice
    // keeps `npm run port:contract:rows` fast while still covering the `None`
    // header, thresholds, mixed-case contexts, and multi-todo groups.
    const selftestDir = mkdtempSync(join(tmpdir(), "thar-rows-selftest-"));
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

      const manifest: RowsManifest = {
        ...createManifest(options.clockLocal),
        generated: [
          {
            fixture: GENERATED_FIXTURE,
            lines: createGeneratedLines(SELFTEST_TODO_COUNT),
          },
        ],
      };

      // Determinism: two unmutated builds must be byte-identical.
      const baseline = buildRowsContract({
        corpusDir: selftestDir,
        manifest,
      });
      const second = buildRowsContract({
        corpusDir: selftestDir,
        manifest,
      });
      if (second.jsonl !== baseline.jsonl) {
        throw new HarnessError("two unmutated runs are not byte-identical");
      }

      for (const mutation of ROWS_MUTATION_NAMES) {
        const mutated = buildRowsContract({
          corpusDir: selftestDir,
          manifest,
          mutation,
        });
        const result = compareContracts(baseline.jsonl, mutated.jsonl, 1);
        if (result.diffs.length === 0 && result.omitted === 0) {
          throw new HarnessError(
            `the comparator did not catch the ${mutation} mutation: ` +
              ROWS_MUTATIONS[mutation],
          );
        }
      }

      process.stderr.write(
        `port-rows: selftest ok (deterministic, ${ROWS_MUTATION_NAMES.length} mutation(s) caught)` +
          `\n`,
      );
    } finally {
      rmSync(selftestDir, { recursive: true, force: true });
    }
  }

  if (options.out) {
    writeFileSync(options.out, build.jsonl);
  } else if (!options.check) {
    if (process.stdout.isTTY) {
      process.stderr.write(
        "port-rows: stdout is a terminal; pass --out <file> to keep JSONL readable\n",
      );
    }
    process.stdout.write(build.jsonl);
  }

  const contractBytes = Buffer.byteLength(build.jsonl, "utf8");

  if (!options.check) {
    process.stderr.write(
      `port-rows: wrote ${build.records.length} record(s) (${contractBytes} bytes, ` +
        `collator ${build.collatorLocale})\n`,
    );
    return EXIT_MATCH;
  }

  const tokens = options.candidateSelf
    ? selfCommand(import.meta.url)
    : splitCommand(options.candidate as string);
  const tempDir = mkdtempSync(join(tmpdir(), "thar-rows-"));
  let candidateText: string;
  try {
    const manifestPath = join(tempDir, "manifest.json");
    const outFile = join(tempDir, "candidate.jsonl");
    writeFileSync(manifestPath, JSON.stringify(build.manifest));

    const run = runCandidate(tokens, [
      "--corpus",
      resolve(options.corpusDir),
      "--clock",
      build.clockLocal,
      "--manifest",
      manifestPath,
      "--out",
      outFile,
    ]);
    if (!run.ok) {
      // The candidate never produced a contract: that is a harness error, not
      // a mismatch between two contracts.
      process.stderr.write(`port-rows: ${run.detail}\n`);
      return EXIT_HARNESS_ERROR;
    }

    let bytes: Buffer;
    try {
      bytes = readFileSync(outFile);
    } catch {
      process.stderr.write(
        `port-rows: candidate exited 0 but did not write ${outFile}\n`,
      );
      return EXIT_HARNESS_ERROR;
    }
    const decoded = decodeJsonlBytes(bytes);
    if (decoded === undefined) {
      return invalidUtf8(outFile);
    }
    candidateText = decoded;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  const result = compareContracts(
    build.jsonl,
    candidateText,
    options.maxDiffs,
    {
      recordLabel: rowsRecordLabel,
    },
  );
  if (result.diffs.length > 0 || result.omitted > 0) {
    reportDiffs(result.diffs, result.omitted, result.truncated);
    return EXIT_MISMATCH;
  }

  process.stderr.write(
    `port-rows: match (candidate, ${build.records.length} record(s), ` +
      `${contractBytes} bytes, collator ${build.collatorLocale})\n`,
  );
  return EXIT_MATCH;
};

try {
  process.exitCode = main();
} catch (error) {
  if (error instanceof HarnessError || error instanceof CandidateCommandError) {
    process.stderr.write(`port-rows: ${bounded(error.message)}\n`);
    process.exitCode = EXIT_HARNESS_ERROR;
  } else {
    throw error;
  }
}
