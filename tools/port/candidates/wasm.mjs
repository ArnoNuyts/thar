#!/usr/bin/env node
/**
 * CP1 contract candidate backed by the Rust core compiled to WASM.
 *
 * Protocol (see `tools/port/README.md`, "Candidate protocol"):
 *
 *   node tools/port/candidates/wasm.mjs --corpus <dir> --clock <iso> --out <file>
 *
 * It loads the wasm-pack Node package from `crates/thar-wasm/pkg/`, reads every
 * `*.txt` fixture as raw bytes, decodes them lossily exactly like the Node
 * reader (`Buffer#toString("utf8")`), calls `parseFileWithLimits` once per file,
 * and writes the JSONL contract in the oracle's fixture order and field order.
 *
 * Deliberately plain Node ESM with no build step: the contract must be
 * checkable from a clean checkout after `wasm-pack build` and `npm ci`.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = resolve(fileURLToPath(import.meta.url), "..");
const REPO_ROOT = resolve(MODULE_DIR, "../../..");
const PKG_ENTRY = join(REPO_ROOT, "crates", "thar-wasm", "pkg", "thar_wasm.js");

/** Read limits mirror `logic/limits.ts`; the oracle pins the same defaults. */
const DEFAULT_LIMITS = {
  maxFileBytes: 1024 * 1024,
  maxReadTodos: 10_000,
  maxLineChars: 8_192,
};

const LIMIT_ENV_VARS = {
  maxFileBytes: "THAR_MAX_FILE_BYTES",
  maxReadTodos: "THAR_MAX_READ_TODOS",
  maxLineChars: "THAR_MAX_LINE_CHARS",
};

/** Contract error numeric fields, in the order `tools/port/types.ts` pins. */
const ERROR_NUMERIC_FIELDS = [
  "lineNumber",
  "length",
  "maxLineChars",
  "lineCount",
  "maxReadTodos",
  "actualBytes",
  "maxBytes",
  "codePoint",
];

const CLOCK_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;

const fail = (message) => {
  process.stderr.write(`port-contract-wasm: ${message}\n`);
  process.exit(1);
};

const sha256Hex = (value) => createHash("sha256").update(value).digest("hex");

/** Bytewise (UTF-8) filename order, independent of the host locale. */
const compareFixtureNames = (left, right) =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

const parsePositiveInteger = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  // Never echo the value: environment input may carry control characters.
  if (!/^[0-9]+$/.test(raw)) {
    fail(`invalid ${name}: expected a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(`invalid ${name}: expected a positive integer`);
  }
  return value;
};

const readLimits = () => ({
  maxFileBytes: parsePositiveInteger(
    LIMIT_ENV_VARS.maxFileBytes,
    DEFAULT_LIMITS.maxFileBytes,
  ),
  maxReadTodos: parsePositiveInteger(
    LIMIT_ENV_VARS.maxReadTodos,
    DEFAULT_LIMITS.maxReadTodos,
  ),
  maxLineChars: parsePositiveInteger(
    LIMIT_ENV_VARS.maxLineChars,
    DEFAULT_LIMITS.maxLineChars,
  ),
});

const parseArgs = (args) => {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg !== "--corpus" && arg !== "--clock" && arg !== "--out") {
      fail(`unknown argument ${JSON.stringify(arg)}`);
    }
    const value = args[index + 1];
    if (value === undefined) fail(`${arg} requires a value`);
    options[arg.slice(2)] = value;
    index++;
  }
  for (const required of ["corpus", "clock", "out"]) {
    if (options[required] === undefined) {
      fail(
        `missing --${required}; expected --corpus <dir> --clock <iso> --out <file>`,
      );
    }
  }
  return options;
};

/** The pinned calendar day used by the clock-dependent accessors. */
const todayOf = (clock) => {
  const match = CLOCK_PATTERN.exec(clock);
  if (!match) {
    fail(
      `invalid --clock ${JSON.stringify(clock)}; expected yyyy-MM-ddTHH:mm:ss`,
    );
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
};

const loadCore = () => {
  if (!existsSync(PKG_ENTRY)) {
    fail(
      `missing WASM package ${PKG_ENTRY}; run ` +
        "`wasm-pack build crates/thar-wasm --release --target nodejs --out-dir pkg`",
    );
  }
  // The package is CommonJS with no `type` field, so `require` through
  // `createRequire` loads it from this ESM file without a build step.
  const require = createRequire(import.meta.url);
  try {
    return require(PKG_ENTRY);
  } catch (error) {
    fail(
      `cannot load ${PKG_ENTRY}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};

/** Rebuild the error object in the contract's fixed key order. */
const contractError = (error) => {
  const record = {
    name: typeof error.name === "string" ? error.name : "",
    code: typeof error.code === "string" ? error.code : "",
  };
  for (const field of ERROR_NUMERIC_FIELDS) {
    if (typeof error[field] === "number") record[field] = error[field];
  }
  record.message = typeof error.message === "string" ? error.message : "";
  return record;
};

const recordFor = (fixture, raw, core, clock, today, limits, readLimits) => {
  const sha256 = sha256Hex(raw);
  // `Buffer#toString` decodes lossily (U+FFFD), exactly like the Node reader.
  const text = raw.toString("utf8");

  let envelope;
  try {
    envelope = JSON.parse(
      core.parseFileWithLimits(
        text,
        today,
        limits.maxFileBytes,
        limits.maxReadTodos,
        limits.maxLineChars,
      ),
    );
  } catch (error) {
    fail(
      `parseFileWithLimits failed for ${fixture}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!envelope.ok) {
    return {
      fixture,
      sha256,
      kind: "error",
      readLimits,
      clockLocal: clock,
      error: contractError(envelope.error),
    };
  }

  const todos = envelope.todos;
  // CP1 defines the write shape as `todos.map(toString).join("\n") + "\n"`.
  const serialized = todos.map((todo) => todo.toString).join("\n") + "\n";

  return {
    fixture,
    sha256,
    kind: "todos",
    readLimits,
    clockLocal: clock,
    todoCount: todos.length,
    serialized: {
      sha256: sha256Hex(serialized),
      bytes: Buffer.byteLength(serialized, "utf8"),
    },
    todos,
  };
};

const main = () => {
  const options = parseArgs(process.argv.slice(2));
  const corpusDir = resolve(options.corpus);
  const clock = options.clock;
  const today = todayOf(clock);
  const limits = readLimits();
  const core = loadCore();

  let names;
  try {
    names = readdirSync(corpusDir);
  } catch (error) {
    fail(
      `cannot read the corpus directory ${corpusDir}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const fixtures = names.filter((name) => name.endsWith(".txt"));
  if (fixtures.length === 0) fail(`no fixtures found in ${corpusDir}`);
  fixtures.sort(compareFixtureNames);

  const records = [];
  for (const fixture of fixtures) {
    let raw;
    try {
      raw = readFileSync(join(corpusDir, fixture));
    } catch (error) {
      fail(
        `cannot read fixture ${fixture}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    records.push(
      recordFor(fixture, raw, core, clock, today, limits, { ...limits }),
    );
  }

  writeFileSync(
    resolve(options.out),
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
  );
};

main();
