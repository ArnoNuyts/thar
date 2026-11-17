import { spawnSync } from "node:child_process";

/**
 * Build the Node-targeted WASM package with the workspace `wasm` profile's
 * settings.
 *
 * `wasm-pack` 0.13 always builds Cargo's `release` profile and has no
 * `--profile` flag, so the two size settings (`opt-level = "s"`,
 * `panic = "abort"`) are supplied through Cargo's profile environment
 * variables. Keeping them out of the shared release profile means the native
 * `thar-rs` binary still unwinds and is optimized for speed. `--locked` keeps
 * the dependency graph pinned.
 */
const args = [
  "build",
  "crates/thar-wasm",
  "--release",
  "--target",
  "nodejs",
  "--out-dir",
  "pkg",
  "--locked",
];

const result = spawnSync("wasm-pack", args, {
  stdio: "inherit",
  env: {
    ...process.env,
    CARGO_PROFILE_RELEASE_OPT_LEVEL: "s",
    CARGO_PROFILE_RELEASE_PANIC: "abort",
  },
});

if (result.error) {
  console.error(`wasm-pack failed to start: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
