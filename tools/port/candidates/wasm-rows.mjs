#!/usr/bin/env node
/**
 * CP3b rows-contract candidate backed by the Rust core compiled to WASM.
 *
 * Protocol (see `tools/port/rows.ts`):
 *
 *   node tools/port/candidates/wasm-rows.mjs \
 *     --corpus <dir> --clock <iso> --manifest <file> --out <file>
 *
 * For every corpus fixture that parses plus the generated lists in the
 * manifest, it:
 *
 * 1. parses the text with the WASM `parseFileWithLimits` (the only crossing
 *    that reads a file);
 * 2. derives one normalized search view per todo from the **WASM parse
 *    output** with JavaScript `toLowerCase` (never from the Rust folding, which
 *    does not exist), so the parse→view gap is covered as well;
 * 3. calls `buildRows` once per (query, showHidden) with the manifest's
 *    host-normalized terms, and writes the oracle's JSONL record shape.
 *
 * Plain Node ESM with no build step, like the CP1 WASM candidate. A missing
 * `pkg/` is a loud failure, never a contract mismatch.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = resolve(fileURLToPath(import.meta.url), "..");
const REPO_ROOT = resolve(MODULE_DIR, "../../..");
const PKG_ENTRY = join(REPO_ROOT, "crates", "thar-wasm", "pkg", "thar_wasm.js");

/** Bytewise (UTF-8) filename order, independent of the host locale. */
const compareNames = (left, right) =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

const fail = (message) => {
  process.stderr.write(`port-rows-wasm: ${message}\n`);
  process.exit(1);
};

const parseArgs = (args) => {
  const options = {};
  const known = ["--corpus", "--clock", "--manifest", "--out"];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!known.includes(arg)) fail(`unknown argument ${JSON.stringify(arg)}`);
    const value = args[index + 1];
    if (value === undefined) fail(`${arg} requires a value`);
    options[arg.slice(2)] = value;
    index++;
  }
  for (const required of ["corpus", "clock", "manifest", "out"]) {
    if (options[required] === undefined) {
      fail(
        "missing --corpus <dir> --clock <iso> --manifest <file> --out <file>",
      );
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
    return require(PKG_ENTRY);
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
    typeof value.clockLocal !== "string" ||
    typeof value.today !== "string" ||
    typeof value.readLimits !== "object" ||
    value.readLimits === null ||
    !Array.isArray(value.queries) ||
    !Array.isArray(value.showHidden) ||
    !Array.isArray(value.generated)
  ) {
    fail(`manifest ${path} does not match the rows protocol`);
  }
  return value;
};

/**
 * The todo fields `buildRows` reads. The two round-trip flags are absent from
 * the CP1 parse records, so they stay at their `false` default; row building
 * does not read them (only serialization does).
 */
const todoRecordOf = (todo) => ({
  text: todo.text,
  state: todo.state,
  priority: todo.priority,
  completionDate: todo.completionDate,
  creationDate: todo.creationDate,
  projects: todo.projects,
  contexts: todo.contexts,
  tags: todo.tags,
});

/** The host owns case folding; it is applied to the WASM parse output. */
const searchViewOf = (todo) => ({
  text: todo.text.toLowerCase(),
  contexts: todo.contexts.map((context) => context.toLowerCase()),
  projects: todo.projects.map((project) => project.toLowerCase()),
});

const parseText = (core, text, manifest, fixture) => {
  const { maxFileBytes, maxReadTodos, maxLineChars } = manifest.readLimits;
  let envelope;
  try {
    envelope = JSON.parse(
      core.parseFileWithLimits(
        text,
        manifest.today,
        maxFileBytes,
        maxReadTodos,
        maxLineChars,
      ),
    );
  } catch (error) {
    fail(
      `parseFileWithLimits failed for ${fixture}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return envelope;
};

/**
 * All row records for one parsed list, in the oracle's fixture → query →
 * showHidden order.
 */
const recordsFor = (core, fixture, todos, manifest) => {
  const payload = {
    today: manifest.today,
    showHidden: false,
    terms: [],
    todos: todos.map(todoRecordOf),
    searchViews: todos.map(searchViewOf),
  };

  const records = [];
  for (const { query, terms } of manifest.queries) {
    for (const showHidden of manifest.showHidden) {
      payload.terms = terms;
      payload.showHidden = showHidden;

      let envelope;
      try {
        envelope = JSON.parse(core.buildRows(JSON.stringify(payload)));
      } catch (error) {
        fail(
          `buildRows failed for ${fixture} / ${JSON.stringify(query)}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      if (!envelope.ok) {
        fail(
          `buildRows rejected ${fixture} / ${JSON.stringify(query)}: ` +
            `${envelope.error.code} ${envelope.error.message}`,
        );
      }

      records.push({
        fixture,
        query,
        terms,
        showHidden,
        clockLocal: manifest.clockLocal,
        todoCount: envelope.order.length,
        rows: envelope.rows,
        order: envelope.order,
      });
    }
  }
  return records;
};

const main = () => {
  const options = parseArgs(process.argv.slice(2));
  const corpusDir = resolve(options.corpus);
  const manifest = readManifest(options.manifest);
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

  /** One input list: a corpus fixture or a generated one. */
  const sources = names
    .filter((name) => name.endsWith(".txt"))
    .map((name) => ({
      name,
      read: () => {
        try {
          // `Buffer#toString` decodes lossily, exactly like the Node reader.
          return readFileSync(join(corpusDir, name)).toString("utf8");
        } catch (error) {
          return fail(
            `cannot read fixture ${name}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      },
    }));

  for (const generated of manifest.generated) {
    sources.push({
      name: generated.fixture,
      read: () => `${generated.lines.join("\n")}\n`,
    });
  }
  sources.sort((left, right) => compareNames(left.name, right.name));

  const records = [];
  for (const source of sources) {
    const envelope = parseText(core, source.read(), manifest, source.name);
    // Rejection fixtures are covered by the CP1 contract, not by the row model.
    if (!envelope.ok) continue;
    records.push(...recordsFor(core, source.name, envelope.todos, manifest));
  }

  if (records.length === 0) fail(`no row records for ${corpusDir}`);

  writeFileSync(
    resolve(options.out),
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
  );
};

main();
