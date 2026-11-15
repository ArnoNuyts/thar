import { rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Remove the `.gitignore` that `wasm-pack` writes into `crates/thar-wasm/pkg/`.
 *
 * The generated file contains `*` so the build output stays untracked. The
 * repository root already ignores that directory, but npm honours a nested
 * ignore file even when `files` names the directory — the tarball would ship
 * `bin/`, `dist/` and no WASM at all. Deleting it before `npm pack` keeps the
 * published package honest.
 */
rmSync(join("crates", "thar-wasm", "pkg", ".gitignore"), { force: true });
