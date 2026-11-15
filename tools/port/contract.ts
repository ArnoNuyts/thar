import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MUTATION_NAMES,
  MUTATIONS,
  type MutationName,
  isMutationName,
} from "./adapter.ts";
import {
  DEFAULT_CLOCK_LOCAL,
  DEFAULT_CORPUS_DIR,
  REPO_ROOT,
  buildContract,
} from "./build.ts";
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
  --max-diffs <n>           Print at most n diffs (default: 20)
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
        if (!Number.isSafeInteger(value) || value < 0) {
          throw new HarnessError("--max-diffs must be a non-negative integer");
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

/**
 * Split a candidate command on whitespace, honouring single and double quotes
 * and backslash escapes. Deliberately not a shell: no pipes, globs, variables
 * or redirects, so the same command works on Linux, macOS and Windows.
 */
export const splitCommand = (command: string): string[] => {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let hasToken = false;

  for (let index = 0; index < command.length; index++) {
    const char = command[index];

    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      } else if (
        char === "\\" &&
        quote === '"' &&
        index + 1 < command.length &&
        (command[index + 1] === '"' || command[index + 1] === "\\")
      ) {
        // Inside double quotes a backslash only escapes `"` and `\`, so
        // Windows paths such as C:\Program Files keep their backslashes.
        current += command[index + 1];
        index++;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      hasToken = true;
      continue;
    }
    if (char === "\\" && index + 1 < command.length) {
      const next = command[index + 1];
      if (/\s/.test(next) || next === '"' || next === "'" || next === "\\") {
        current += next;
        index++;
        hasToken = true;
        continue;
      }
    }
    if (/\s/.test(char)) {
      if (hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }
    current += char;
    hasToken = true;
  }

  if (quote !== undefined) {
    throw new HarnessError("Candidate command has an unterminated quote");
  }
  if (hasToken) tokens.push(current);
  if (tokens.length === 0) {
    throw new HarnessError("Candidate command is empty");
  }
  return tokens;
};

const VITE_NODE_CLI = join(
  REPO_ROOT,
  "node_modules",
  "vite-node",
  "dist",
  "cli.mjs",
);

/** The command that reruns this harness (TS source or bundled entry). */
const selfCommand = (): string[] => {
  const script = fileURLToPath(import.meta.url);
  if (script.endsWith(".ts")) {
    return [process.execPath, VITE_NODE_CLI, script];
  }
  // A Vite/rolldown bundle of this file can rerun itself with plain Node.
  return [process.execPath, script];
};

interface CandidateRun {
  ok: boolean;
  detail: string;
}

const runCandidate = (
  tokens: string[],
  corpusDir: string,
  clockLocal: string,
  outFile: string,
): CandidateRun => {
  const result = spawnSync(
    tokens[0],
    [
      ...tokens.slice(1),
      "--corpus",
      corpusDir,
      "--clock",
      clockLocal,
      "--out",
      outFile,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );

  if (result.error) {
    return {
      ok: false,
      detail: `candidate could not run: ${result.error.message}`,
    };
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim().slice(0, 2_000);
    const signal = result.signal ? ` (signal ${result.signal})` : "";
    return {
      ok: false,
      detail:
        `candidate exited with code ${result.status}${signal}` +
        (stderr ? `: ${stderr}` : ""),
    };
  }
  return { ok: true, detail: "" };
};

const reportDiffs = (
  diffs: ReturnType<typeof compareContracts>["diffs"],
  omitted: number,
): void => {
  process.stderr.write(
    `port-contract: ${diffs.length + omitted} diff(s)` +
      (omitted > 0 ? ` (showing ${diffs.length}, ${omitted} omitted)` : "") +
      "\n",
  );
  for (const diff of diffs) {
    process.stderr.write(`  ${formatDiff(diff)}\n`);
  }
};

const main = (): number => {
  const options = parseArgs(process.argv.slice(2));

  // Test-only hook used by wrappers that cannot append `--mutate` themselves.
  const envMutation = process.env.THAR_PORT_MUTATION;
  if (options.mutate === undefined && envMutation !== undefined) {
    if (!isMutationName(envMutation)) {
      throw new HarnessError(
        `Unknown THAR_PORT_MUTATION ${JSON.stringify(envMutation)}; expected one of ${MUTATION_NAMES.join(", ")}`,
      );
    }
    options.mutate = envMutation;
  }

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

  const build = buildContract({
    corpusDir: options.corpusDir,
    clockLocal: options.clockLocal,
    mutation: options.mutate,
  });

  if (options.out) {
    writeFileSync(options.out, build.jsonl);
  } else if (!options.check && !options.verifyGolden) {
    process.stdout.write(build.jsonl);
  }

  let diffs: ReturnType<typeof compareContracts>["diffs"] = [];
  let omitted = 0;
  let compared = false;

  if (options.verifyGolden) {
    compared = true;
    try {
      diffs = diffs.concat(verifyGolden(build));
    } catch (error) {
      throw new HarnessError(
        `cannot verify against the golden file: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (options.check) {
    compared = true;
    const candidates = [
      options.candidate !== undefined,
      options.candidateFile !== undefined,
      options.candidateSelf,
    ].filter(Boolean).length;
    if (candidates !== 1) {
      throw new HarnessError(
        "--check requires exactly one of --candidate, --candidate-file or --candidate-self",
      );
    }

    let candidateText: string;
    if (options.candidateFile !== undefined) {
      const bytes = readFileSync(options.candidateFile);
      const decoded = decodeJsonlBytes(bytes);
      if (decoded === undefined) {
        reportDiffs(
          [
            {
              fixture: "<corpus>",
              path: "<file>",
              expected: "UTF-8 JSONL",
              actual: "invalid UTF-8",
            },
          ],
          0,
        );
        return EXIT_MISMATCH;
      }
      candidateText = decoded;
    } else {
      const tokens = options.candidateSelf
        ? selfCommand()
        : splitCommand(options.candidate as string);
      const tempDir = mkdtempSync(join(tmpdir(), "thar-port-"));
      try {
        const outFile = join(tempDir, "candidate.jsonl");
        const run = runCandidate(
          tokens,
          resolve(options.corpusDir),
          options.clockLocal,
          outFile,
        );
        if (!run.ok) {
          process.stderr.write(`port-contract: ${run.detail}\n`);
          return EXIT_MISMATCH;
        }
        try {
          candidateText = readFileSync(outFile, "utf8");
        } catch {
          process.stderr.write(
            `port-contract: candidate exited 0 but did not write ${outFile}\n`,
          );
          return EXIT_MISMATCH;
        }
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
  }

  if (!compared) {
    process.stderr.write(
      `port-contract: wrote ${build.records.length} fixture record(s)` +
        ` (${build.jsonl.length} bytes)\n`,
    );
    return EXIT_MATCH;
  }

  if (diffs.length > 0 || omitted > 0) {
    reportDiffs(diffs, omitted);
    return EXIT_MISMATCH;
  }

  process.stderr.write(
    `port-contract: match (${build.records.length} fixture record(s))\n`,
  );
  return EXIT_MATCH;
};

try {
  process.exitCode = main();
} catch (error) {
  if (error instanceof HarnessError) {
    process.stderr.write(`port-contract: ${error.message}\n`);
    process.exitCode = EXIT_HARNESS_ERROR;
  } else {
    throw error;
  }
}
