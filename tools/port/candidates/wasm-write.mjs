#!/usr/bin/env node
/**
 * CP4 write-contract candidate backed by the Rust core compiled to WASM.
 *
 * Protocol (see `tools/port/write.ts`):
 *
 *   node tools/port/candidates/wasm-write.mjs \
 *     --manifest <file> --out <file>
 *
 * The manifest carries one entry per fixture: the **same structured records**
 * the app's adapter sends (`{"todos":[…]}`, including duplicate tag arrays and
 * both round-trip flags). For each entry it calls `serializeFile` once and
 * writes the oracle's record shape:
 *
 * - `{ok:true,text}` → `{fixture, kind:"todos", todoCount, serialized:{…}}`;
 * - `UNSAFE_CONTROL_CHARACTER` → `{fixture, kind:"rejected", lineNumber, codePoint}`,
 *   mapping the envelope's `index` to the TypeScript error's `lineNumber`;
 * - any other rejection is a candidate bug and a loud failure, not a mismatch.
 *
 * The candidate never parses a fixture and never re-derives the DTO: the
 * contract is exactly the boundary the write path uses.
 *
 * Plain Node ESM with no build step, like the CP1 and CP3b candidates. A missing
 * `pkg/` is a loud failure, never a contract mismatch.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = resolve(fileURLToPath(import.meta.url), "..");
const REPO_ROOT = resolve(MODULE_DIR, "../../..");
const PKG_ENTRY = join(REPO_ROOT, "crates", "thar-wasm", "pkg", "thar_wasm.js");

const sha256Hex = (value) => createHash("sha256").update(value).digest("hex");

const fail = (message) => {
  process.stderr.write(`port-write-wasm: ${message}\n`);
  process.exit(1);
};

const parseArgs = (args) => {
  const options = {};
  const known = ["--manifest", "--out"];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!known.includes(arg)) fail(`unknown argument ${JSON.stringify(arg)}`);
    const value = args[index + 1];
    if (value === undefined) fail(`${arg} requires a value`);
    options[arg.slice(2)] = value;
    index++;
  }
  for (const required of ["manifest", "out"]) {
    if (options[required] === undefined) {
      fail("missing --manifest <file> --out <file>");
    }
  }
  return options;
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
    const core = require(PKG_ENTRY);
    if (typeof core.serializeFile !== "function") {
      fail(`${PKG_ENTRY} does not export serializeFile; rebuild the package`);
    }
    return core;
  } catch (error) {
    fail(
      `cannot load ${PKG_ENTRY}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};

const readManifest = (path) => {
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(
      `cannot read manifest ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !Array.isArray(value.entries) ||
    value.entries.some(
      (entry) =>
        typeof entry !== "object" ||
        entry === null ||
        typeof entry.fixture !== "string" ||
        !Array.isArray(entry.todos),
    )
  ) {
    fail(`manifest ${path} does not match the write protocol`);
  }
  return value;
};

/** One contract record for one manifest entry. */
const recordFor = (core, entry) => {
  let envelope;
  try {
    envelope = JSON.parse(
      core.serializeFile(JSON.stringify({ todos: entry.todos })),
    );
  } catch (error) {
    fail(
      `serializeFile failed for ${entry.fixture}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (envelope.ok === true) {
    if (typeof envelope.text !== "string") {
      fail(`serializeFile returned a non-string text for ${entry.fixture}`);
    }
    return {
      fixture: entry.fixture,
      kind: "todos",
      todoCount: entry.todos.length,
      serialized: {
        sha256: sha256Hex(envelope.text),
        bytes: Buffer.byteLength(envelope.text, "utf8"),
      },
    };
  }

  if (envelope.ok !== false) {
    fail(`serializeFile returned an unknown envelope for ${entry.fixture}`);
  }
  const error = envelope.error ?? {};
  if (error.code !== "UNSAFE_CONTROL_CHARACTER") {
    // A request the oracle accepted must not be rejected by the candidate:
    // that is a candidate bug, not a contract mismatch.
    fail(
      `serializeFile rejected ${entry.fixture}: ` +
        `${String(error.name)}/${String(error.code)}`,
    );
  }
  if (!Number.isInteger(error.index) || !Number.isInteger(error.codePoint)) {
    fail(`serializeFile returned a guard error without index/codePoint`);
  }
  return {
    fixture: entry.fixture,
    kind: "rejected",
    // The TypeScript error calls the 1-based line `lineNumber`; the Rust
    // envelope calls it `index`.
    lineNumber: error.index,
    codePoint: error.codePoint,
  };
};

const main = () => {
  const options = parseArgs(process.argv.slice(2));
  const manifest = readManifest(options.manifest);
  const core = loadCore();

  const records = manifest.entries.map((entry) => recordFor(core, entry));
  writeFileSync(
    resolve(options.out),
    records.map((record) => JSON.stringify(record)).join("\n") +
      (records.length > 0 ? "\n" : ""),
  );
};

main();
