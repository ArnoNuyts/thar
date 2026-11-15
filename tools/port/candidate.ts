import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { REPO_ROOT } from "./build.ts";

/**
 * Shared candidate protocol for the differential harnesses (CP1 `contract.ts`
 * and CP3b `rows.ts`).
 *
 * A candidate is any command that receives the harness arguments appended to
 * its own tokens, writes its JSONL contract to the `--out` file, and exits 0.
 * It is spawned without a shell, with a bounded timeout, and without the
 * test-only mutation hook, so a globally exported hook cannot mutate the
 * oracle and the candidate at once.
 */

/** Longest free-form message printed for a harness error. */
const MAX_ERROR_CHARS = 400;

/** A `--candidate` string the tokenizer rejects. */
export class CandidateCommandError extends Error {}

/** Keep a message printable even if it embeds untrusted text. */
export const bounded = (text: string): string =>
  text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text;

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
    throw new CandidateCommandError(
      "Candidate command has an unterminated quote",
    );
  }
  if (hasToken) tokens.push(current);
  if (tokens.length === 0) {
    throw new CandidateCommandError("Candidate command is empty");
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

/**
 * The command that reruns `moduleUrl` as the candidate.
 *
 * From the TypeScript source (`tools/port/*.ts`) that is `vite-node`; a
 * Vite/rolldown bundle of the module can rerun itself with plain Node.
 */
export const selfCommand = (moduleUrl: string): string[] => {
  const script = fileURLToPath(moduleUrl);
  if (script.endsWith(".ts")) {
    return [process.execPath, VITE_NODE_CLI, script];
  }
  return [process.execPath, script];
};

export interface CandidateRun {
  ok: boolean;
  detail: string;
}

/**
 * Environment for the spawned candidate: inherited, minus the test-only
 * mutation hook. Otherwise a globally exported `THAR_PORT_MUTATION` would
 * mutate the oracle *and* the candidate, and a wrong candidate would pass.
 */
const candidateEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  delete env.THAR_PORT_MUTATION;
  delete env.THAR_ROWS_MUTATION;
  return env;
};

/**
 * Run a candidate with `extraArgs` appended, capturing nothing on success.
 *
 * stdout is ignored and stderr is only shown (first 2 000 characters) when the
 * candidate fails. A candidate that cannot be spawned, exits non-zero, or times
 * out is a harness error, not a contract mismatch; the caller decides how to
 * report it.
 */
export const runCandidate = (
  tokens: string[],
  extraArgs: string[],
): CandidateRun => {
  const result = spawnSync(tokens[0], [...tokens.slice(1), ...extraArgs], {
    cwd: process.cwd(),
    env: candidateEnv(),
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });

  if (result.error) {
    return {
      ok: false,
      detail: `candidate could not run: ${bounded(result.error.message)}`,
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
