#!/usr/bin/env node
/**
 * CP1 seeded-bug proof.
 *
 * Plain Node, no test runner, so CI can run it with `npm run port:selftest`.
 *
 * The harness normally runs through vite-node (`npx vite-node
 * tools/port/contract.ts`). For the self-test that startup cost is paid a
 * dozen times, so the runner is first bundled once with Vite (an existing
 * dev dependency) into a temp directory; every oracle/candidate process then
 * runs the same source as a ~0.4 s plain-Node command. The assertions and the
 * candidate protocol are identical.
 *
 * 1. two unmutated oracle runs must be byte-identical;
 * 2. `--verify-golden` must pass against `testdata/port/expected.json`;
 * 3. the oracle, used as a candidate through `--check --candidate`, must match;
 * 4. every documented mutation (`--mutate <name>`, see tools/port/README.md)
 *    must make `--check` exit 2 with a diff naming the expected fixture and
 *    field. A mutation that is not detected fails the self-test;
 * 5. `--max-diffs 0` must be a usage error, and a capped walk over a tampered
 *    candidate must still fail;
 * 6. a globally exported `THAR_PORT_MUTATION` must not reach the candidate.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build as viteBuild } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const contractScript = join(here, "contract.ts");
const corpusDir = join(repoRoot, "testdata", "port");

const startedAt = process.hrtime.bigint();
const elapsedMs = () => Number(process.hrtime.bigint() - startedAt) / 1e6;
const formatMs = (ms) => `${ms.toFixed(0)} ms`;

const tempDir = mkdtempSync(join(tmpdir(), "thar-port-selftest-"));
const bundlePath = join(tempDir, "contract.mjs");

/** Run the (bundled) contract harness and collect its output. */
const run = (extraArgs, extraEnv = {}) =>
  new Promise((resolveRun) => {
    // Never inherit the test-only mutation hook by default: unmutated runs must
    // stay unmutated even if the caller exported THAR_PORT_MUTATION. Tests that
    // exercise the hook opt in through `extraEnv`.
    const env = { ...process.env };
    delete env.THAR_PORT_MUTATION;
    Object.assign(env, extraEnv);
    const child = spawn(process.execPath, [bundlePath, ...extraArgs], {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolveRun({ status: null, stdout, stderr, error });
    });
    child.on("close", (status, signal) => {
      resolveRun({ status, signal, stdout, stderr, error: undefined });
    });
  });

const describeRun = (result) =>
  `status=${result.status}${result.error ? ` error=${result.error.message}` : ""}${result.stderr ? `\nstderr:\n${result.stderr}` : ""}`;

/** Quote one token for the `--candidate` command string. */
const quoteToken = (token) =>
  /^[A-Za-z0-9_./:=+-]+$/.test(token)
    ? token
    : `"${token.replace(/(["\\])/g, "\\$1")}"`;

/** Candidate command string: plain Node running the temporary bundle. */
const candidateCommand = (extraArgs = []) =>
  [process.execPath, bundlePath, ...extraArgs].map(quoteToken).join(" ");

try {
  // Bundle the harness once so each of the ~14 spawned runs is fast.
  await viteBuild({
    configFile: false,
    logLevel: "silent",
    root: repoRoot,
    build: {
      ssr: contractScript,
      outDir: tempDir,
      emptyOutDir: false,
      target: "node22",
      minify: false,
      rollupOptions: { output: { entryFileNames: "contract.mjs" } },
    },
    ssr: { target: "node", noExternal: true },
  });
  console.log(
    `ok  bundle: ${readFileSync(bundlePath).length} bytes in ${formatMs(elapsedMs())}`,
  );

  // The mutation table lives in the TypeScript adapter; ask the harness for it
  // so the self-test cannot drift from the documented mutations.
  const mutationsRun = await run(["--list-mutations"]);
  assert.equal(
    mutationsRun.status,
    0,
    `--list-mutations failed: ${describeRun(mutationsRun)}`,
  );
  const mutations = JSON.parse(mutationsRun.stdout);
  assert.ok(Array.isArray(mutations) && mutations.length >= 5);
  const mutationNames = mutations.map((mutation) => mutation.name);
  for (const required of [
    "drop-done-marker",
    "accept-invalid-date",
    "collapse-duplicate-tags",
    "ignore-hidden",
    "reorder-tags",
  ]) {
    assert.ok(
      mutationNames.includes(required),
      `missing required mutation ${required}`,
    );
  }

  // 1. Determinism: two unmutated runs are byte-identical.
  const firstPath = join(tempDir, "oracle-1.jsonl");
  const secondPath = join(tempDir, "oracle-2.jsonl");
  const firstRun = await run(["--corpus", corpusDir, "--out", firstPath]);
  assert.equal(
    firstRun.status,
    0,
    `first oracle run failed: ${describeRun(firstRun)}`,
  );
  const secondRun = await run(["--corpus", corpusDir, "--out", secondPath]);
  assert.equal(
    secondRun.status,
    0,
    `second oracle run failed: ${describeRun(secondRun)}`,
  );

  const first = readFileSync(firstPath);
  const second = readFileSync(secondPath);
  assert.ok(first.length > 0, "oracle contract is empty");
  assert.ok(
    first.equals(second),
    "two unmutated oracle runs are not byte-identical",
  );
  const fixtureCount = first.toString("utf8").trimEnd().split("\n").length;
  console.log(
    `ok  determinism: 2 runs byte-identical (${fixtureCount} fixtures, ${first.length} bytes)`,
  );

  // 2-3. Golden verification and the unmutated candidate pass.
  const fullCheck = await run([
    "--corpus",
    corpusDir,
    "--check",
    "--candidate",
    candidateCommand(),
    "--verify-golden",
  ]);
  assert.equal(
    fullCheck.status,
    0,
    `golden + unmutated candidate should pass: ${describeRun(fullCheck)}`,
  );
  console.log("ok  golden: contract matches testdata/port/expected.json");
  console.log("ok  candidate protocol: unmutated oracle matches");

  // 5. A zero diff cap is a usage error, and a capped walk still fails.
  const zeroCap = await run([
    "--corpus",
    corpusDir,
    "--check",
    "--candidate-file",
    firstPath,
    "--max-diffs",
    "0",
  ]);
  assert.equal(
    zeroCap.status,
    1,
    `--max-diffs 0 must be a usage error: ${describeRun(zeroCap)}`,
  );
  assert.match(zeroCap.stderr, /--max-diffs must be a positive integer/);

  const tamperedPath = join(tempDir, "tampered.jsonl");
  const tampered = first
    .toString("utf8")
    .replace(/("serialized":\{"sha256":")[0-9a-f]{64}/, `$1${"0".repeat(64)}`);
  writeFileSync(tamperedPath, tampered);
  assert.notEqual(tampered, first.toString("utf8"), "tamper did not apply");
  const capped = await run([
    "--corpus",
    corpusDir,
    "--check",
    "--candidate-file",
    tamperedPath,
    "--max-diffs",
    "1",
  ]);
  assert.equal(
    capped.status,
    2,
    `a capped tampered candidate must fail: ${describeRun(capped)}`,
  );
  assert.match(capped.stderr, /port-contract: at least 1 diff\(s\)/);
  assert.match(capped.stderr, /serialized\.sha256/);
  console.log(
    "ok  diff cap: --max-diffs 0 is rejected, capped diffs still fail",
  );

  // 6. A globally exported mutation hook must not reach the candidate.
  const hooked = await run(
    ["--corpus", corpusDir, "--check", "--candidate-self"],
    { THAR_PORT_MUTATION: "drop-done-marker" },
  );
  assert.equal(
    hooked.status,
    2,
    `the mutation hook must not leak into the candidate: ${describeRun(hooked)}`,
  );
  assert.match(hooked.stderr, /serialized\.sha256/);
  console.log(
    "ok  env hook: THAR_PORT_MUTATION is stripped from the candidate environment",
  );

  // 4. Every mutation must be detected, on the documented fixture and field.
  for (const mutation of mutations) {
    const check = await run([
      "--corpus",
      corpusDir,
      "--check",
      "--candidate",
      candidateCommand(["--mutate", mutation.name]),
    ]);

    assert.equal(
      check.status,
      2,
      `mutation ${mutation.name} was not detected (exit ${check.status}): ${describeRun(check)}`,
    );

    const expectedLine = `${mutation.proof.fixture} ${mutation.proof.path}:`;
    assert.ok(
      check.stderr.includes(expectedLine),
      `mutation ${mutation.name} did not report ${JSON.stringify(expectedLine)}\nstderr:\n${check.stderr}`,
    );

    const diffCount = Number(
      /port-contract: (?:at least )?(\d+) diff\(s\)/.exec(check.stderr)?.[1] ??
        0,
    );
    assert.ok(diffCount > 0, `mutation ${mutation.name} reported no diffs`);

    console.log(
      `ok  mutation ${mutation.name}: caught on ${mutation.proof.fixture} ${mutation.proof.path} (${diffCount} diffs)`,
    );
  }

  const summary = {
    fixtures: fixtureCount,
    bytes: first.length,
    mutations: mutations.map((mutation) => ({
      name: mutation.name,
      fixture: mutation.proof.fixture,
      path: mutation.proof.path,
    })),
    elapsedMs: Math.round(elapsedMs()),
  };
  console.log(
    `port-selftest: ok (${mutations.length} mutations caught) in ${formatMs(summary.elapsedMs)}`,
  );

  // Machine-readable summary for the PR body / CI logs.
  if (process.env.THAR_PORT_SELFTEST_JSON) {
    console.log(JSON.stringify(summary));
  }
} catch (error) {
  console.error(
    `port-selftest: FAILED after ${formatMs(elapsedMs())}\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  process.exitCode = 1;
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
