import { spawnSync } from "node:child_process";

/**
 * Build the Node-targeted WASM package with the workspace `wasm` profile.
 *
 * `wasm-pack` 0.14+ supports `--profile <name>`, so the size settings live in
 * one place: `[profile.wasm]` in the workspace `Cargo.toml`. CI pins wasm-pack
 * 0.15.1; the release workflow uses the same script. `--locked` keeps the
 * dependency graph pinned.
 */
const args = [
  "build",
  "crates/thar-wasm",
  "--profile",
  "wasm",
  "--target",
  "nodejs",
  "--out-dir",
  "pkg",
  "--locked",
];

const result = spawnSync("wasm-pack", args, { stdio: "inherit" });

if (result.error) {
  console.error(`wasm-pack failed to start: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
