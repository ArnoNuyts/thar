import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { InvalidLimitError } from "../../logic/limits.ts";
import {
  MUTATION_NAMES,
  MUTATIONS,
  type MutationName,
  isMutationName,
} from "./adapter.ts";
import {
  type ContractBuild,
  CorpusError,
  DEFAULT_CLOCK_LOCAL,
  DEFAULT_CORPUS_DIR,
  buildContract,
} from "./build.ts";
import {
  CandidateCommandError,
  bounded,
  runCandidate,
  selfCommand,
  splitCommand,
} from "./candidate.ts";
import { InvalidClockError } from "./clock.ts";
import { decodeJsonlBytes, formatDiff, compareContracts } from "./compare.ts";
import { verifyGolden } from "./golden.ts";

// Pin the contract to UTC in this process so `clockLocal` names one instant on
// every host. Node applies a `process.env.TZ` change to later Date operations;
// the pinned clock is then built from UTC calendar components.
process.env.TZ = "UTC";

/**
 * CP1 differential contract CLI.
 *
 *   vite-node tools/port/contract.ts                     # JSONL to stdout
 *   vite-node tools/port/contract.ts --out contract.jsonl
 *   vite-node tools/port/contract.ts --check --candidate-file candidate.jsonl
 *   vite-node tools/port/contract.ts --check --candidate "<command>"
 *   vite-node tools/port/contract.ts --check --candidate-self --verify-golden
 *
 * Exit codes: 0 match, 2 mismatch, 1 harness error. Diffs and status go to
 * stderr so stdout stays valid JSONL. See `tools/port/README.md`.
 */

const EXIT_MATCH = 0;
const EXIT_HARNESS_ERROR = 1;
const EXIT_MISMATCH = 2;

interface Options {
  corpusDir: string;
  clockLocal: string;
  out?: string;
  check: boolean;
  candidate?: string;
  candidateFile?: string;
  candidateSelf: boolean;
  verifyGolden: boolean;
  mutate?: MutationName;
  maxDiffs: number;
  help: boolean;
  listMutations: boolean;
}

class HarnessError extends Error {}

/**
 * Translate the errors the corpus, clock and limit code can raise for bad
 * *user* input into harness errors, so the CLI prints one line instead of a
 * stack trace. Unexpected errors still propagate.
 */
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

const usage = `CP1 differential contract harness

Usage: vite-node tools/port/contract.ts [options]

Options:
  --corpus <dir>            Fixture directory (default: testdata/port)
  --clock <yyyy-MM-ddTHH:mm:ss>
                            Pinned wall-clock time, UTC
                            (default: ${DEFAULT_CLOCK_LOCAL})
  --out <file>              Write the oracle contract here instead of stdout
  --check                   Compare a candidate contract with the oracle
  --candidate <command>     Candidate command; spawned with
                            --corpus <dir> --clock <iso> --out <file>
  --candidate-file <file>   Compare with a precomputed JSONL contract
  --candidate-self          Run this harness (vite-node) as the candidate
  --verify-golden           Also compare the contract with
                            testdata/port/expected.json field by field
  --mutate <name>           TEST ONLY: build a deliberately broken contract
  --max-diffs <n>           Print at most n diffs (default: 20, minimum: 1)
  --list-mutations          Print the seeded mutations as JSON and exit
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
    verifyGolden: false,
    maxDiffs: 20,
    help: false,
    listMutations: false,
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
      case "--candidate":
        options.candidate = valueOf(args, index, arg);
        index++;
        break;
      case "--candidate-file":
        options.candidateFile = valueOf(args, index, arg);
        index++;
        break;
      case "--candidate-self":
        options.candidateSelf = true;
        break;
      case "--verify-golden":
        options.verifyGolden = true;
        break;
      case "--mutate": {
        const name = valueOf(args, index, arg);
        if (!isMutationName(name)) {
          throw new HarnessError(
            `Unknown mutation ${JSON.stringify(name)}; expected one of ${MUTATION_NAMES.join(", ")}`,
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
      case "--list-mutations":
        options.listMutations = true;
        break;
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
    `port-contract: ${truncated ? `at least ${total}` : `${total}`} diff(s)` +
      (notes.length > 0 ? ` (showing ${shown}, ${notes.join("; ")})` : "") +
      "\n",
  );
  for (const diff of diffs) {
    process.stderr.write(`  ${formatDiff(diff)}\n`);
  }
};

/** True when two paths name the same file (after resolving links). */
const sameFile = (left: string, right: string): boolean => {
  const leftPath = resolve(left);
  const rightPath = resolve(right);
  if (leftPath === rightPath) return true;
  if (!existsSync(leftPath) || !existsSync(rightPath)) return false;
  try {
    return realpathSync(leftPath) === realpathSync(rightPath);
  } catch {
    return false;
  }
};

const invalidUtf8 = (source: string): number => {
  process.stderr.write(
    `port-contract: candidate output is not valid UTF-8 (${source})\n`,
  );
  return EXIT_MISMATCH;
};

const readCandidateFile = (path: string): Buffer => {
  try {
    return readFileSync(path);
  } catch (error) {
    throw new HarnessError(
      bounded(
        `cannot read candidate file ${path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    );
  }
};

const main = (): number => {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    process.stdout.write(usage);
    return EXIT_MATCH;
  }

  if (options.listMutations) {
    const list = MUTATION_NAMES.map((name) => ({
      name,
      description: MUTATIONS[name].description,
      proof: MUTATIONS[name].proof,
    }));
    process.stdout.write(JSON.stringify(list, null, 2) + "\n");
    return EXIT_MATCH;
  }

  // Test-only hook used by wrappers that cannot append `--mutate` themselves.
  // Resolved after --help/--list-mutations so a stray export cannot break them.
  const envMutation = process.env.THAR_PORT_MUTATION;
  if (options.mutate === undefined && envMutation !== undefined) {
    if (!isMutationName(envMutation)) {
      throw new HarnessError(
        `Unknown THAR_PORT_MUTATION ${JSON.stringify(envMutation)}; expected one of ${MUTATION_NAMES.join(", ")}`,
      );
    }
    options.mutate = envMutation;
  }

  const candidates = [
    options.candidate !== undefined,
    options.candidateFile !== undefined,
    options.candidateSelf,
  ].filter(Boolean).length;

  if (options.check && candidates !== 1) {
    throw new HarnessError(
      "--check requires exactly one of --candidate, --candidate-file or --candidate-self",
    );
  }
  if (!options.check && candidates > 0) {
    throw new HarnessError(
      "--candidate, --candidate-file and --candidate-self require --check",
    );
  }
  if (
    options.out !== undefined &&
    options.candidateFile !== undefined &&
    sameFile(options.out, options.candidateFile)
  ) {
    // `--out` writes the oracle before the check, so comparing against the same
    // path would compare the oracle with itself and always pass.
    throw new HarnessError(
      `--out and --candidate-file both name ${options.out}; ` +
        "the oracle would be compared with itself",
    );
  }

  let build: ContractBuild;
  try {
    build = buildContract({
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

  if (options.out) {
    writeFileSync(options.out, build.jsonl);
  } else if (!options.check && !options.verifyGolden) {
    if (process.stdout.isTTY) {
      process.stderr.write(
        "port-contract: stdout is a terminal; pass --out <file> to keep JSONL readable\n",
      );
    }
    process.stdout.write(build.jsonl);
  }

  const contractBytes = Buffer.byteLength(build.jsonl, "utf8");

  let diffs: ReturnType<typeof compareContracts>["diffs"] = [];
  let omitted = 0;
  let truncated = false;
  let compared = false;

  if (options.verifyGolden) {
    compared = true;
    try {
      diffs = diffs.concat(verifyGolden(build));
    } catch (error) {
      throw new HarnessError(
        bounded(
          `cannot verify against the golden file: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
    }
  }

  if (options.check) {
    compared = true;

    let candidateText: string;
    if (options.candidateFile !== undefined) {
      const decoded = decodeJsonlBytes(
        readCandidateFile(options.candidateFile),
      );
      if (decoded === undefined) {
        return invalidUtf8(options.candidateFile);
      }
      candidateText = decoded;
    } else {
      const tokens = options.candidateSelf
        ? selfCommand(import.meta.url)
        : splitCommand(options.candidate as string);
      const tempDir = mkdtempSync(join(tmpdir(), "thar-port-"));
      try {
        const outFile = join(tempDir, "candidate.jsonl");
        const run = runCandidate(tokens, [
          "--corpus",
          resolve(options.corpusDir),
          "--clock",
          options.clockLocal,
          "--out",
          outFile,
        ]);
        if (!run.ok) {
          // The candidate never produced a contract: that is a harness error,
          // not a mismatch between two contracts.
          process.stderr.write(`port-contract: ${run.detail}\n`);
          return EXIT_HARNESS_ERROR;
        }
        let bytes: Buffer;
        try {
          bytes = readFileSync(outFile);
        } catch {
          process.stderr.write(
            `port-contract: candidate exited 0 but did not write ${outFile}\n`,
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
    }

    const result = compareContracts(
      build.jsonl,
      candidateText,
      options.maxDiffs,
    );
    diffs = diffs.concat(result.diffs);
    omitted = result.omitted;
    truncated = result.truncated;
  }

  if (!compared) {
    process.stderr.write(
      `port-contract: wrote ${build.records.length} fixture record(s)` +
        ` (${contractBytes} bytes)\n`,
    );
    return EXIT_MATCH;
  }

  if (diffs.length > 0 || omitted > 0) {
    reportDiffs(diffs, omitted, truncated);
    return EXIT_MISMATCH;
  }

  const checks: string[] = [];
  if (options.verifyGolden) checks.push("golden");
  if (options.check) checks.push("candidate");
  process.stderr.write(
    `port-contract: match (${checks.join(" + ")}, ` +
      `${build.records.length} fixture record(s), ${contractBytes} bytes)\n`,
  );
  return EXIT_MATCH;
};

try {
  process.exitCode = main();
} catch (error) {
  if (error instanceof HarnessError || error instanceof CandidateCommandError) {
    process.stderr.write(`port-contract: ${bounded(error.message)}\n`);
    process.exitCode = EXIT_HARNESS_ERROR;
  } else {
    throw error;
  }
}
