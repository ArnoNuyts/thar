# Update mechanism research

_Status: implemented for npm installs (Phases 1 and 2). SEA/binary
self-update remains out of scope._
_Date: 2026-11-12. Package versions and APIs verified at that date._

## Implemented

- Compile-time `__APP_VERSION__`, `--version`/`-v`, `--no-update-check`, and
  `todotui update [--check] [--yes]` are parsed before the TUI starts.
- A cached npm-registry check runs after first paint, with a 24 h TTL, 1.5 s
  timeout, TTY/CI/lifecycle gating, jitter, and a one-hour negative cache.
- The footer shows `↑ v<latest> · u update`; `u` or a click opens the update
  modal. A one-time toast per version is tracked in `lastNotified`.
- The modal can skip a version, or run the detected package-manager update
  **after Ink exits**. Ephemeral/dev/SEA installs only get the manual command.
- Binary/SEA download-and-replace is intentionally not implemented.

## TL;DR

Ship a **small custom checker** rather than `update-notifier`:

1. **Phase 1 (do this first, ~0.5–1 day):** compile-time version, `--version`,
   cached npm-registry check (24 h, 1.5 s timeout, silent on failure), and a
   **persistent, non-blocking footer badge** plus a one-time toast —
   `↑ v0.5.0 · press u`. Never auto-open a modal, never print from a
   background task.
2. **Phase 2 (~1–2 days):** `todotui update` / `u` that detects how the app was
   installed and runs the matching package-manager command **on exit** (or
   restarts after success). Explicit user action only. Never `sudo`.
3. **Phase 3 (~2–3 days):** self-update for the SEA binaries via GitHub
   releases, with SHA-256 verification, atomic replace, and a Windows
   replace-after-exit helper. This is where most of the edge cases live.

`update-notifier` and friends are a poor fit for a full-screen Ink app: they
print raw text to stderr and are built for CLIs that terminate quickly. The
check itself is ~80 lines; the UI integration is the real work.

Before publishing, there are also release-pipeline bugs to fix — notably that
**every GitHub release is currently marked `--prerelease`** (so
`/releases/latest` returns 404, verified) and the **macOS SEA binary is not
codesigned** (Node's documented SEA build requires `codesign --sign -`).

## Where the project stands

| Fact                                                                | Implication                                                                                                                     |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `@arnoarnoarno/thar@0.4.0`, `"private": true`                       | Cannot publish until removed.                                                                                                   |
| Published name is `@arnoarnoarno/thar`                              | Scope must be claimed before the first publish.                                                                                 |
| Distribution: npm (planned) **and** SEA binaries on GitHub releases | Two install kinds, two update paths.                                                                                            |
| Long-running Ink TUI, `patchConsole: true`                          | Background code must not `console.log`/write stderr; surface state through React.                                               |
| No `bin` field and no shebang yet                                   | npm install has no executable entry point today.                                                                                |
| `engines.node: >=26.12.0`, build target `esnext`                    | Very few npm users are on Node 26 yet; npm warns `EBADENGINE`. Consider `>=22` and `build.target: "node22"` for the npm bundle. |
| GitHub release workflow always uses `--prerelease`                  | `GET /releases/latest` 404s; npm-registry-based checks are more reliable.                                                       |
| No checksums in releases; macOS not codesigned                      | Required before binary self-update, and for macOS usability.                                                                    |
| `Runtime.args[0]` is treated as the todo filename                   | `todotui --version` would create a file named `--version` today.                                                                |
| No `README` yet                                                     | Needed for npm and for documenting update/opt-out behavior.                                                                     |

## Options

### A. Do nothing

Users run `npm outdated -g` themselves. Zero cost, but binary users have no
signal at all and npm users rarely check. Acceptable only as a temporary state.

### B. Off-the-shelf notifier

| Package                           | Latest (2026-11-12) | What it does                                                                                        | Fit                                                                                                                                                                        |
| --------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `update-notifier`                 | 7.3.1               | Cached check (1 day) in an unref'ed child process, configstore cache, pretty boxed message; 11 deps | Check logic is reusable, but it writes to stderr and pulls in `boxen`, `configstore`, `is-installed-globally`, etc. Overkill; bypassing `.notify()` leaves an awkward API. |
| `simple-update-notifier`          | 2.0.0               | 1 dep (`semver`), daily cache, prints banner                                                        | Prints its own banner; not Ink-aware; last major release 2021.                                                                                                             |
| `tiny-update-notifier`            | 2.0.2               | Minimal check + print                                                                               | Same caveat: output, not state.                                                                                                                                            |
| `latest-version` / `package-json` | 9.0.0 / 10.0.1      | Registry fetch with `.npmrc`/auth/proxy handling                                                    | Good building blocks, but `package-json` pulls `ky` + auth chain. Useful only if private-registry support matters.                                                         |
| `@oclif/plugin-update`            | 5.0.10              | Full tar-based self-update for oclif CLIs                                                           | Requires adopting oclif wholesale. Not applicable.                                                                                                                         |
| `npm-check-updates`               | 23.1.1              | Updates dependency ranges in a project                                                              | Wrong problem.                                                                                                                                                             |

All of them share the main drawback: they own the _presentation_. For an Ink
app we want the opposite — a boolean/version in React state, rendered by our
own components. The registry request is trivial; skip the dependency.

### C. Custom check + in-app notice (recommended)

- Fetch `https://registry.npmjs.org/%40arnoarnoarno%2Fthar/latest` (single manifest, ~1–3 KB)
  with `Accept: application/json` and a `User-Agent`.
- Compare with `semver.gt(latest, current)` (or a ~30-line comparator if you
  want zero new deps; `semver` is 0-dep and battle-tested).
- Cache result for 24 h; run the check after first paint, with a 1–1.5 s
  timeout, and fail silently.
- Gate it: only in a TTY, not in CI, not under npm lifecycle/test, and
  disable with `--no-update-check`, `TODOTUI_NO_UPDATE_CHECK=1`, or the
  de-facto `NO_UPDATE_NOTIFIER=1`.
- Render a persistent badge, one-time toast, and an on-demand modal.

This is the best cost/quality tradeoff and fits the existing
`Runtime`/context/test architecture. See "Proposed design" below.

### D. Self-update for npm installs

Feasible, but **never silently**. Detect the install method, show the exact
command, and let the user confirm. Running `npm i -g` while Ink owns the
terminal is the main pitfall: either run it after `instance.unmount()`, or log
to a file and show progress in the UI.

Command per install kind:

| Install kind | Update command                              | Notes                                                 |
| ------------ | ------------------------------------------- | ----------------------------------------------------- |
| npm global   | `npm install -g @arnoarnoarno/thar@latest`  | Canonical. May fail `EACCES` if prefix is root-owned. |
| pnpm global  | `pnpm add -g @arnoarnoarno/thar@latest`     | Don't use npm here; it creates a second copy.         |
| yarn global  | `yarn global add @arnoarnoarno/thar@latest` | Yarn v1 vs berry differ; consider instructions only.  |
| bun global   | `bun add -g @arnoarnoarno/thar@latest`      |                                                       |
| Volta        | `volta install @arnoarnoarno/thar@latest`   |                                                       |
| `npx`        | `npx @arnoarnoarno/thar@latest`             | Can't hot-swap; just tell the user.                   |
| `pnpm dlx`   | `pnpm dlx @arnoarnoarno/thar@latest`        | Same.                                                 |
| `bunx`       | `bunx @arnoarnoarno/thar@latest`            | Same.                                                 |
| Homebrew     | `brew upgrade todotui`                      | Only if a tap exists.                                 |
| Scoop        | `scoop update todotui`                      | Only if a manifest exists.                            |
| Dev checkout | refuse                                      | Suggest `git pull && npm i`.                          |

Detection order (only on demand, not at startup):

1. `isSea()` from `node:sea` → binary path (Phase 3).
2. Path heuristics on `process.argv[1]` / `import.meta.url`:
   `/_npx/`, `/dlx/`, `/.bun/install/cache/` → ephemeral installs.
3. Environment markers: `VOLTA_HOME`, `PNPM_HOME`, `BUN_INSTALL`,
   `HOMEBREW_PREFIX`, `SCOOP`, `MISE_DATA_DIR`, `ASDF_DATA_DIR`.
4. Compare the real script path with `npm root -g` / `pnpm root -g`
   (async spawn; ~200–500 ms, so only after the user asks).
5. Otherwise: unknown → show the generic `npm i -g` instruction rather than
   guessing.

Restart options:

- **Update on exit (simplest):** set `pendingUpdate`, let the user quit
  normally, run the install with normal stdio after Ink unmounts, print the
  result, exit. No terminal hand-off problems, no half-updated UI.
- **Update now + restart:** run detached with stdout/stderr to a log file,
  show a spinner in the badge, then `instance.unmount()` (restores terminal),
  spawn the new process with inherited stdio, and exit. Re-exec is easy for
  npm installs (`node dist/main.js ...`) and for SEA (`process.execPath`).
- **Never** run the installer while Ink is mounted with inherited stdio; its
  output will corrupt the rendered frame.

Failure handling: read the log tail, surface `EACCES`/network errors in the
modal, and show the manual command. Do not retry in a loop.

### E. Self-update for SEA binaries

This is doable and is what users of a single-file CLI expect, but it has the
most platform-specific sharp edges. Recommended design:

1. Use the **npm registry as version source** (one source of truth for both
   install kinds, no GitHub rate limit, no prerelease API weirdness).
2. Download the asset for the running platform/arch from
   `https://github.com/ArnoNuyts/thar/releases/download/v<version>/todotui-<os>-<arch>[.exe]`.
   Extend the existing matrix to cover `linux-arm64` and `macos-x64`; the
   current matrix has only `linux-x64`, `windows-x64`, `macos-arm64`.
3. Verify a `SHA256SUMS` asset (generate it in the release workflow); cap the
   download size; delete the temp file on any failure.
4. Replace:
   - **Linux/macOS:** download into the _same directory_ as the running
     binary (avoids cross-device rename), `chmod 755`, then `rename()` over the
     target. The running inode stays valid.
   - **Windows:** a running `.exe` cannot be overwritten, but it _can_ be
     renamed. Try `rename(todotui.exe, todotui.exe.old)` then
     `rename(new, todotui.exe)`. If that fails (AV lock), write a tiny `.cmd`
     helper that waits for the PID to exit, moves the files, optionally
     restarts, and deletes itself; launch it detached and quit. On next
     startup, best-effort delete `*.old` and restore it if the main binary is
     missing.
5. **macOS specifics:** Node's SEA docs require `codesign --sign - <binary>`
   after building; the release workflow does not do this today. Downloaded
   files via `fetch` are not quarantined (unlike browser downloads), but
   Gatekeeper still requires a valid signature on arm64. Notarization needs an
   Apple Developer account; for now, ad-hoc signing is the minimum.
6. If the install directory is not writable, fall back to printing the release
   URL; do not attempt elevation.

### F. Let a package manager own updates

Worth doing later, in rough order of value:

- **Homebrew tap** (`brew install ArnoNuyts/thar/todotui`) — the natural
  macOS path; `brew upgrade` handles updates and signatures/notarization
  expectations. Can be auto-bumped from the release workflow.
- **Scoop** bucket for Windows; **Winget** after that.
- **AUR** / **nixpkgs** if there is demand.
- A `curl | sh` installer with `todotui update` is possible but adds a second
  update mechanism to maintain; prefer package managers.

When these exist, the in-app checker should detect the installation and
suggest the package-manager command instead of self-updating.

## Proposed design (Phase 1 + 2)

### Version source

Use a compile-time define so the version works in both the npm bundle and the
SEA binary (where `package.json` is not present):

```ts
// vite.config.ts and vite.sea.config.ts
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  // ...
});
```

```ts
// types/globals.d.ts
declare const __APP_VERSION__: string;
```

`vitest` also applies `define`, so tests see the same constant. Add a release
check that the git tag matches `package.json` — otherwise binary asset URLs 404.

### CLI surface

Parse before rendering (today everything is treated as a filename):

```ts
const args = Runtime.args;
const version = args.includes("--version") || args.includes("-v");
if (version) {
  process.stdout.write(`todotui ${__APP_VERSION__}\n`);
  process.exit(0);
}

const noUpdateCheck =
  args.includes("--no-update-check") ||
  process.env.TODOTUI_NO_UPDATE_CHECK === "1" ||
  process.env.NO_UPDATE_NOTIFIER === "1";

const subcommand = args[0] === "update" ? "update" : undefined;
const filename = (subcommand ? args[1] : args[0]) || "todo.txt";
```

Suggested surface:

```
todotui                      interactive TUI
todotui <file>               interactive TUI on <file>
todotui --version | -v       print version, no TUI
todotui update [--check]     check/install updates, no TUI
todotui --no-update-check    skip the background check
```

`update` becomes a reserved filename; `./update` still works. Document it.

### Files and responsibilities

| File                          | Responsibility                                                 |
| ----------------------------- | -------------------------------------------------------------- |
| `logic/version.ts`            | `parseVersion`, `isNewer`, formatting; pure and unit-testable. |
| `logic/update-cache.ts`       | Cache read/write, TTL, corruption-tolerant, atomic write.      |
| `logic/update-check.ts`       | Registry fetch, gating, timeout, result validation; no React.  |
| `logic/install-method.ts`     | Detect npm/pnpm/yarn/bun/volta/npx/brew/sea; command mapping.  |
| `logic/self-update.ts`        | Runs the pending package-manager update after Ink exits.       |
| `logic/pending-update.ts`     | Process-scoped hand-off from the TUI to the post-exit updater. |
| `logic/update-badge.ts`       | Pure footer label formatting/truncation.                       |
| `contexts/update-context.tsx` | Status, cache, toast, install detection and update actions.    |
| `components/UpdateBadge.tsx`  | Non-blocking footer badge.                                     |
| `components/UpdateModal.tsx`  | On-demand details and actions.                                 |

### Check flow

```
startup
  ├─ parse flags; if --version/update → print & exit
  ├─ render Ink app
  └─ useEffect: after ~2–3 s idle (unref timer)
       ├─ skip if disabled / !TTY / CI / npm lifecycle / dev? (dev optional)
       ├─ read cache; if checkedAt < 24 h → use cached latest
       └─ else GET registry/%40arnoarnoarno%2Fthar/latest (timeout 1.5 s)
            ├─ 200 → validate semver, write cache atomically, update state
            └─ error/timeout → silent; optionally negative-cache 1 h
```

Registry details:

- URL: `https://registry.npmjs.org/%40arnoarnoarno%2Fthar/latest` (the manifest behind the
  `latest` dist-tag). The registry does **not** return an `ETag` for this
  endpoint (verified), so don't build conditional-request logic; use TTL.
- Honor `TODOTUI_REGISTRY` and, if present, `npm_config_registry`.
- Don't spawn `npm view` — it costs hundreds of ms and another Node process.
- Jitter the check by 0–5 s so a release doesn't produce a synchronized spike.
- Prereleases: only compare against `latest`; if the running version is a
  prerelease, optionally use the `next` dist-tag.

Cache (state, not config):

| Platform | Path                                                          |
| -------- | ------------------------------------------------------------- |
| Linux    | `${XDG_STATE_HOME:-~/.local/state}/todotui/update-check.json` |
| macOS    | `~/Library/Application Support/todotui/update-check.json`     |
| Windows  | `%LOCALAPPDATA%\todotui\update-check.json`                    |

```json
{
  "checkedAt": 1794521279000,
  "latest": "0.5.0",
  "lastNotified": "0.5.0",
  "skipped": "0.4.9"
}
```

Write via temp file + `rename`; ignore read-only HOME and malformed JSON.
Never let cache I/O throw into the UI.

### UI: non-blocking

Use the existing footer rather than a modal:

- Right side of `ActionBar` (where the toaster currently renders):
  `↑ v0.5.0 · u update`.
- Priority: the transient 2 s toast wins while it is visible; the persistent
  badge shows immediately afterwards. The toast is emitted once per version
  (`lastNotified`).
- `u` opens `UpdateModal` only on explicit keypress; Esc closes it. No focus
  stealing, no auto-open, no blocking.
- Narrow terminals: degrade to `↑ v0.5.0`, then `↑`. Mouse support: reuse the
  `ActionBar` click-segment pattern.
- Modal actions: _Update now_, _Later_, _Skip this version_, plus the release
  notes link (`https://github.com/ArnoNuyts/thar/releases/tag/vX.Y.Z`).
  _Update now_ records a pending install, exits the TUI, and runs the package
  manager with inherited stdio.
- If the install kind is ephemeral (`npx`/`dlx`/`bunx`), replace “Update” with
  the exact `npx @arnoarnoarno/thar@latest` command and a copy hint; no self-update.

### Update execution

```ts
// after Ink has unmounted, so the installer owns the terminal
const child = spawn(command, args, {
  stdio: ["ignore", logFd, logFd],
  windowsHide: true,
});
const code = await exitCode(child, 120_000);
if (code !== 0) return showFailure(tail(logFile));
restart();
```

- On Windows, invoke `npm.cmd` (or `cmd /d /s /c`) — `spawn("npm")` without a
  shell fails.
- Fixed argument arrays, never interpolate user input.
- Keep the old binary/package until success; on failure, leave the current
  install untouched and print the manual command.
- Detect `EACCES` and explicitly tell the user not to `sudo npm i -g` unless
  they own the prefix; suggest a user prefix instead.
- Lock/serialize updates (a lock file or in-process flag) so two instances
  don't race, especially on Windows.

### Security and privacy

- HTTPS only, fixed host, response size cap, JSON validation, short timeout.
- Binary updates: SHA-256 manifest, temp-file + atomic rename, no execution of
  partially written files.
- Publish with `npm publish --provenance` from GitHub Actions (trusted
  publishing / OIDC); enable 2FA on the npm account; avoid long-lived tokens.
- No telemetry, no install ID, no unique query parameters. The check is a
  plain `GET` for a public manifest; disclose it in the README and offer the
  opt-outs. Companies care about this.
- Auto-update is opt-in via an explicit keypress. Silent auto-update of a
  binary is a supply-chain decision, not just a UX one.

## Publishing checklist (separate from updates, but blocking)

- Remove `"private": true`; claim `todotui` now (currently unclaimed).
- Add `description`, `license`, `repository`, `homepage`, `bugs`, `keywords`,
  `author`, `README.md`.
- Add a real entry point:
  ```json
  "bin": { "todotui": "./bin/todotui.js" },
  "files": ["bin", "dist", "README.md", "LICENSE"]
  ```
  with `bin/todotui.js`:
  ```js
  #!/usr/bin/env node
  import "../dist/main.js";
  ```
- Build the npm bundle in `prepublishOnly` (or CI) and verify with
  `npm pack --dry-run`; don't publish TS sources.
- Reconsider `engines.node: ">=26.12.0"` and `build.target: "esnext"` for the
  npm artifact; `>=22`/`node22` reaches far more users. Binaries can stay
  modern.
- Version/tag parity check in CI; publish stable with `--tag latest`,
  prereleases with `--tag next`.
- Release workflow fixes:
  - Remove `--prerelease` for stable releases (or accept that
    `/releases/latest` stays unusable and always use the npm version).
  - Add `SHA256SUMS`.
  - `codesign --sign -` the macOS binary.
  - Add `linux-arm64` / `macos-x64` if you intend to support them.
  - Optionally attach `.tar.gz` archives to preserve the executable bit.
- Consider a Homebrew tap and Scoop manifest after the npm release is stable.

## Effort estimate

| Phase | Scope                                                      | Estimate  |
| ----- | ---------------------------------------------------------- | --------- |
| 1     | version + flags + cached check + badge/toast + tests       | 0.5–1 day |
| 2     | install detection + `todotui update` + exit/restart flow   | 1–2 days  |
| 3     | SEA self-update + checksums + Windows helper + mac signing | 2–3 days  |
| 4     | Homebrew/Scoop/Winget + docs                               | ongoing   |

## Test plan

- Unit: version parsing/comparison (prerelease, build metadata, `v` prefix),
  TTL boundaries, corrupt/missing cache, gating (CI/TTY/env/flags), registry
  response validation, install-method detection, asset-name mapping, checksum
  verification.
- Integration: a local `node:http` mock registry; fake `HOME`/`XDG_STATE_HOME`;
  inject `fetch`/`Runtime` (add `Runtime.fetch` if you want the same
  indirection as the rest of the runtime layer).
- Ink: render the app with a forced update state and assert badge text,
  truncation on narrow widths, `u` opens the modal, Esc dismisses, and the
  toast doesn't reappear for the same version.
- Manual: `npm pack`, install into a temp prefix
  (`npm i -g --prefix /tmp/... ./todotui-0.4.0.tgz`), then exercise the update
  path against a second local tarball; on Windows, test the replace helper.

## Anti-patterns to avoid

- `npm view` at startup (slow, spawns Node, and can hit the network).
- Blocking the render with a fetch; no timeout on network calls.
- Checking on every launch (rate limits, offline noise, startup cost).
- Printing update text with `console.log`/`stderr` while Ink is mounted.
- Running `npm i -g` with inherited stdio while the TUI is active.
- Silent binary replacement without integrity verification.
- Using GitHub's unauthenticated API on every launch (60 req/h/IP; shared
  NATs exhaust it). The npm registry is the better version source.
- Assuming `latest` npm and the newest GitHub release are always in sync; make
  the updater fall back to “open release page” if the asset 404s.

## Open questions

1. Should the npm artifact support Node 22/24, or is Node 26 acceptable?
   This decides whether npm is a real channel or just a wrapper for binaries.
2. Do you want self-update for npm installs at all, or instructions only?
   Instructions are dramatically safer and still solve 90% of the problem.
3. Is there an Apple Developer account for signing/notarizing macOS binaries?
4. Which extra channels matter (Homebrew tap, Scoop, AUR, nixpkgs)?
5. Should `u` be the shortcut, or would you rather keep the footer purely
   informational and put the action in the existing menu (`x`)?

## Sources

- npm registry API: <https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md>
- `update-notifier`: <https://github.com/yeoman/update-notifier>
- `simple-update-notifier`: <https://github.com/alexbrazier/simple-update-notifier>
- `latest-version`: <https://github.com/sindresorhus/latest-version>
- `@oclif/plugin-update`: <https://github.com/oclif/plugin-update>
- Node.js single executable applications (codesign step):
  <https://nodejs.org/api/single-executable-applications.html>
- npm provenance: <https://docs.npmjs.com/generating-provenance-statements>
- GitHub releases API: <https://docs.github.com/rest/releases/releases>
- Semver spec: <https://semver.org/>
