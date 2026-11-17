# Thar Rust port — implementation plan

- **Branch:** `feature/rust-port` (long-lived integration branch)
- **Status:** Plan + checkpoint ladder. CP0 (corpus, baseline), CP1 (contract
  harness + candidate protocol) and CP2 (workspace, `thar-core`, the WASM batch
  surface, the read-only `THAR_SHADOW` check) are in. CP2b closes CP2's
  WASM/contract half; the seven-day real-file dogfood and the decisions CP3
  depends on are still open. CP3a adds the remaining pure domain (recurrence,
  setters, sort/filter/search, rows, navigation) and pins it to the TypeScript
  oracle without wiring it in. CP3b1 adds the Rust row builder, the WASM
  `build_rows` boundary and a live rows contract with perf evidence, still
  without wiring `THAR_CORE=rust` (that is CP3b2). CP3b2c wires the parse half:
  `THAR_CORE=rust` now reads the file with `parse_file` and rebuilds every todo
  through `Todo.fromParts`, with the TypeScript reader as the fallback. CP4 adds
  the `serialize_file` export, the byte-compared dual write and the data-safety
  matrix; `THAR_CORE` stays opt-in and `ts` is still the default. See §4, §5 and
  §9.1 for what exists today.
- **Date:** 2026-11-15
- **Related:** [`scripts/benchmark-list.tsx`](../../scripts/benchmark-list.tsx),
  [`docs/update-mechanism.md`](../update-mechanism.md), [`AGENTS.md`](../../AGENTS.md)
- **Target PR base:** `feature/rust-port` for every checkpoint and port PR.
  The branch is protected from direct pushes, so all work lands by PR. Release
  line work still goes through `release/next`; the port branch is downstream
  and merges into a release line only when a checkpoint is explicitly
  shippable.

## 1. Summary

Port Thar to Rust in two tracks:

1. **Core first, still shipping Ink.** Move the pure `todo.txt` domain
   (parse, serialize, dates, recurrence, limits, sort/filter/index/search) into
   a Rust crate compiled to WebAssembly and loaded by the existing TypeScript
   app behind the current interfaces.
2. **Then replace the renderer.** Build a native ratatui TUI on the same core,
   behind a separate binary/flag, and cut over when it reaches behavioural
   parity.

This is deliberately not a big-bang rewrite. The TypeScript app remains the
oracle for the domain rules and the fallback for the UI until the Rust TUI has
proved itself. Work advances through the reversible checkpoints in §5; no
checkpoint changes behaviour and implementation at the same time.

**Why Rust rather than Go:** both would remove Ink's render cost, but Rust is
the only option that satisfies all three constraints together — a small core
that compiles to WASM for incremental adoption, a mature in-process Node path
(napi-rs if ever needed), and a mouse-capable TUI library (ratatui). Go's WASM
floor is ~1.9 MB and its Node-addon story is a cgo/FFI or sidecar workaround.
See §12 for the rejected options.

## 2. Why: measured baseline

All numbers below were measured on this machine with the app's own benchmark
(`npx vite-node scripts/benchmark-list.tsx`, 120×40 fake terminal, arrow keys,
200 keys, median of 3 runs) unless noted.

> **CP0 updated these numbers.** [`baseline.md`](./baseline.md) §6 re-measures
> every row on the same machine and is the authoritative pre-port baseline for
> later checkpoints. Where the two differ (3 000-todo keypress, Ink/React at
> 3 000, Node startup, the memory row), gate on `baseline.md`, not on the prose
> figures below.

| Path                                                     |  50 todos | 3 000 todos |            Share of keypress |
| -------------------------------------------------------- | --------: | ----------: | ---------------------------: |
| Wall p50 per key                                         |   22.1 ms |     29.9 ms |                            — |
| Ink output generation                                    |   16.4 ms |     23.5 ms |                        ~75 % |
| React commit (dev build; ~0 in prod)                     |    2.5 ms |      3.8 ms |                        ~12 % |
| Todos parsed / sorted / filtered                         |   0.25 ms |     58.9 ms | ~1 % at 3 k, 0 on navigation |
| Todo calls during one key (`isOverdue` ×3, `getHash` ×1) | ~0.007 ms |   ~0.008 ms |                  **~0.03 %** |

Additional facts:

- Per-key time is **flat from 3 k to 10 k todos**; the path is O(viewport).
- Per-key time scales linearly with **visible rows** (10 rows 18.4 ms, 40 rows
  31.8 ms, 80 rows 59.3 ms).
- A release-mode ratatui 0.30.2 spike rendering the same 40×120 list measured
  **0.39 ms p50 / 0.41 ms p95** (selection moves) and **0.41 ms p50** (full
  viewport scroll) using `TestBackend`, including cloning 300 list items per
  frame.
- Startup on this machine: `node dist/main.js --help` **~2.0 s**, dominated by
  `import("date-fns")` (~1.5 s), then Ink (~0.4–0.5 s), then Node (~0.1 s).
  A release Rust binary that prints nothing starts in **~1.0 ms**.
- `import("ink") + import("react")` peaks at **~89 MB RSS** before app state.

**Conclusion:** the Todo model is not the bottleneck. The renderer is. The
core port is for correctness, portability and the WASM path; the TUI port is
what delivers the speed-up. [`baseline.md`](./baseline.md) is the CP0
measurement of this conclusion, including a headline table, the startup split
and the RSS breakdown.

### Performance targets

| Metric (release build, 120×40, 40 rows) |                        Baseline |                     Target |
| --------------------------------------- | ------------------------------: | -------------------------: |
| Keypress CPU                            |                        16–24 ms |                 **≤ 1 ms** |
| Keypress end-to-end, local terminal     |                        22–30 ms | **≤ 3 ms p50, ≤ 8 ms p95** |
| Keypress end-to-end, SSH                |                        30–50 ms |            **≤ 10 ms p50** |
| Startup, warm cache                     |                         0.2–2 s |                **≤ 20 ms** |
| Load 10 000 todos                       |                           56 ms |                **≤ 10 ms** |
| Search keystroke, 10 000 todos          | 317 ms (27 ms once sorted once) |                 **≤ 5 ms** |
| Resident memory                         |                          90 MB+ |                **≤ 20 MB** |
| Core WASM (raw / gzip)                  |                               — |    **≤ 250 KB / ≤ 100 KB** |
| Release binary per target               |        207 KB JS + node_modules |                **≤ 10 MB** |

Targets are gates for Phases 3, 4 and 7; record hardware and terminal in every
benchmark report.

## 3. Goals and non-goals

### Goals

- G1 Remove Ink's per-frame cost from interactive latency.
- G2 Keep the existing npm install path working during the whole migration.
- G3 Make the domain rules testable independently of React and the terminal.
- G4 Reuse one domain implementation in the TUI, the Node/WASM adapter and
  (optionally) a browser build.
- G5 Preserve `todo.txt` semantics exactly: round-trip, invalid-date handling,
  duplicate tags, limits, recurrence, hidden/threshold behaviour.
- G6 Preserve mouse behaviour: wheel, click, shift-click range, double-click,
  clickable footer, modal controls.
- G7 Reduce startup and memory by an order of magnitude.

### Non-goals

- Changing the `todo.txt` format or inventing a new storage format.
- A browser product in Phase 1–7 (Ratzilla is an optional follow-up).
- Rewriting the 92-file Vitest suite up front; it stays as the behavioural
  oracle until the Rust tests replace it.
- Removing Node/npm distribution before Phase 7.
- Porting Ink itself or keeping React in the Rust build.

## 4. Architecture

The tree below is the target layout. CP2 has landed the workspace,
`thar-core` and the real `thar-wasm` batch surface (CP2a/CP2b);
`thar-tui`, `thar-cli` and `thar-testdata` are still deferred to Phases 4–6.

```text
Cargo.toml                  workspace
rust-toolchain.toml         pinned toolchain + wasm target
crates/
  thar-core/                pure domain (no I/O, no clock, no unsafe)
  thar-wasm/                wasm-bindgen batch surface for Node
  thar-tui/                 (Phase 4) ratatui app + input + views
  thar-cli/                 (Phase 6) binary, file sync, update, clipboard
  thar-testdata/            (Phase 1) shared fixtures/golden files (optional)
docs/rust-port/PLAN.md      this file
```

`thar-core` is dependency-free (dev-dependencies only: `serde`, `serde_json`,
`sha2` for the corpus tests). `thar-wasm` is a `cdylib`/`rlib` with
`wasm-bindgen`. Both crates `#![forbid(unsafe_code)]` and
`#![deny(missing_docs)]`.

### `thar-core`

Responsibilities:

- `Todo` model and immutable setters (mirroring `logic/todo.ts`).
- `todo.txt` prefix scan, tag/project/context parsing, serialization.
- Date-tag validation and formatting (strict `YYYY-MM-DD`, years 1–9999).
- Recurrence planning.
- Limits and typed errors (`limits.ts`, `todo-input.ts`,
  `todo-file-validation.ts`).
- Sort / hidden filter / search filter / contiguous-context index
  (`Todos.ts`, `indexes.ts`).
- Pure selection helpers from `navigation.ts` (row stepping, range rows,
  scroll offset) where they do not depend on React.

Rules:

- No filesystem, process, network or ambient time.
- `today: TodoDate` / `now` is a parameter. The host derives the local
  calendar day, matching current `startOfDay(new Date())` semantics.
- No panics on user data; return typed errors.
- `#![forbid(unsafe_code)]`.
- Prefer an internal `TodoDate { year: u16, month: u8, day: u8 }` with strict
  validation over a date-time crate. This keeps WASM small and avoids
  timezone drift.
- IDs are `u64` (`TodoId`) assigned at parse/load order. The TS adapter maps
  them to the existing `symbol` IDs during the incremental phase.
- `parse`/`serialize` must preserve lines that the current implementation
  preserves, including invalid/ambiguous leading dates and duplicate tags
  (array-valued tags).

### `thar-wasm`

Coarse, batch-oriented boundary. One call per file load or search, not one
call per row/field:

```rust
parse_file(text: &str, today: &str) -> String;   // JSON envelope, default limits
parse_file_with_limits(text, today, max_file_bytes: f64,
                       max_read_todos: f64, max_line_chars: f64) -> String;
build_rows(input: &str) -> String;               // todos + views + terms -> rows
core_version() -> String;
```

Both parse calls return either `{"ok":true,"todos":[…]}` or
`{"ok":false,"error":{…}}`; a record is the CP1/`expected.json` field set in
that order, followed by the CP3b2c read-path fields `datesInText`,
`completionDateInText` and `id` (the CP1 contract's candidate projects the
fourteen CP1 fields only). The whole-file write shape is derived as CP1 defines it
(`todos.map(toString).join("\n") + "\n"`), so there is no second crossing.
`build_rows` (CP3b1) takes one structured request — the todo fields (including
the two round-trip flags), `searchViews` (one host-normalized search view per
todo, aligned by index), the normalized `terms`, `showHidden` and `today` — and
returns `{"ok":true,"rows":[…],"order":[…]}`; `apply_command` still arrives
with CP3b2.

Strings cross the boundary once per batch. Avoid per-row string getters; they
would erase the benefit and add marshalling overhead.

The TS adapter exposes the same functions as today's `Todo`/`Todos` API, so
components do not change in Phases 1–3.

### `thar-tui` (Phase 4+)

- `App` state: todos, rows, cursor, range selection, focus, search, modal
  stack, toaster, update badge.
- `Command` enum + keymap table; commands are pure functions over `App`.
- Views: list, context headers, search bar, action bar, hidden indicator,
  scrollbar, modals (11), calendar, suggestion overlay, confirm dialog.
- Widgets: `ratatui` `List`/`Table`/`Paragraph`/`Clear`, `ratatui-textarea`
  for multi-line editing, `tui-input` for single-line/search, `tui-popup` for
  draggable modals, click regions from `ratatui-interact` (or a small local
  hit-test registry).
- Input: crossterm events; raw mode, alternate screen, mouse capture,
  bracketed paste, focus; restore all modes through a panic hook.
- Mouse: row hit-testing from `y - search_rows - list_top`; wheel scroll;
  350 ms double-click window; shift-click range; footer/update click; modal
  button hit regions.
- Rendering: only the visible slice; no full-list widget construction per
  frame; cache formatted row lines and invalidate on todo/day/selection
  changes.

### `thar-cli` (Phase 6)

- CLI parsing and `--help`/`--version`/`--no-update-check`/`thar update`.
- Reader/writer with limits and atomic replace; `done.txt` append.
- File watcher with the existing 500 ms reload debounce and 50 ms save
  debounce; write/read loop suppression.
- Clipboard command fallbacks (`pbcopy`, `clip`, `wl-copy`/`xclip`, etc.).
- Update check/cache and install-method detection (port
  `docs/update-mechanism.md` behaviour).
- Windows UTF-8 console handling.

## 5. Safe porting checkpoints

`feature/rust-port` is a long-lived branch. Advance it with small checkpoint
PRs, each independently reversible. The rule is:

> **No checkpoint may change behaviour and implementation at the same time.**
> A pure port is allowed; a new feature is not.

A checkpoint is complete only when its gate passes and its baseline is
recorded. Do not start the next checkpoint while one is red.

| CP  | Change                                                   | User risk                            | Gate (must be able to fail)                                              | Rollback                   |
| --- | -------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------ | -------------------------- |
| 0   | Characterization tests, corpus, benchmark baseline       | None (tests only)                    | `npm test` + `npm run check`; corpus covers every rule in §7             | revert commit              |
| 1   | TS-only differential harness + seeded-bug proof          | None (dev tool)                      | Harness exits non-zero on a deliberately mutated parser; runs in Node CI | remove tool                |
| 2   | First crate: `thar-core` + `thar-wasm`, read-only shadow | None (TS output still used)          | Zero mismatches over corpus + dogfood; WASM size budget; TS fallback     | delete crate; workflow off |
| 3   | Rust core opt-in for the read path (`THAR_CORE=rust`)    | Low (memory only)                    | Byte-identical rows/serialization; no fallback errors; perf no worse     | `THAR_CORE=ts`             |
| 4   | Rust core opt-in for writes, byte-compared               | Medium                               | Temp file + byte compare with TS + abort on mismatch; crash/atomic tests | `THAR_CORE=ts`             |
| 5   | Rust core becomes the default in the Node app            | Medium                               | One release cycle, zero data-loss reports; opt-out documented            | flip default               |
| 6   | Read-only Rust TUI as a separate `thar-rs` binary        | None (separate binary; cannot write) | PTY + mouse + perf parity; write attempts rejected                       | do not ship binary         |
| 7   | TUI writes behind `--write`                              | Medium                               | Data-safety suite, byte compare, backup; read-only default               | `--read-only` / use Ink    |
| 8   | Cutover: Rust TUI becomes `thar`; remove Ink             | High                                 | §14 definition of done; release targets; rollback rehearsal              | previous release tag       |

### CP0 — Freeze current behaviour (no app changes)

- Add `testdata/port/` with real-world-shaped and synthetic `todo.txt` files:
  CRLF/LF, no trailing newline, blank lines, invalid dates (year 0000, month
  13, day 32, year 10000), duplicate tags, array tags, Unicode/emoji,
  control characters, 8 192-char lines, 10 000-todo files, recurrence, hidden
  and threshold cases, completed lines with dates in text.
- Add characterization tests that assert **exact serialized bytes** and every
  parsed field, not just "looks right". Reuse the existing Vitest suite; do
  not duplicate tests without a reason.
- Record a baseline in `docs/rust-port/baseline.md`:
  `npm run bench:list -- --todos=50` and `--todos=3000`, `node dist/main.js
  --help` timing, RSS, and the machine/terminal used.
- Gate: `npm test` and `npm run check`; a reviewer confirms the corpus covers
  every rule in §7.
- No crates. No production code.

### CP1 — Differential harness (TypeScript only)

- Add a small Node tool (`tools/port/snapshot.mjs` or similar) that runs the
  current TS implementation over every corpus file and writes a deterministic
  JSONL contract: input hash, parsed fields, serialized bytes.
- Add the second half of the contract now (a candidate runner interface) and
  prove it detects a deliberately mutated parser. The harness must exit
  non-zero on any diff.
- Run it in the Node CI. No Rust is required for this checkpoint.
- Gate: seeded mutation is caught; repeated runs are byte-identical; the
  harness is fast enough for every PR (< 30 s on the corpus).
- Rollback: delete the tool and its CI step.

### CP2 — First crate, read-only shadow (no behaviour change)

- Add the Cargo workspace, `thar-core`, `thar-wasm`, and `rust-toolchain.toml`.
- Install `.github/workflows/rust.yml` from the validated commands in §9.1 and
  make the Rust job green before writing domain code.
- Implement parse/serialize in `thar-core`; run the CP1 contract against it.
- Add `THAR_SHADOW=1` (dev only): the app still uses TS for everything, but
  parses with Rust after load and records mismatches (case IDs and hashes, not
  todo content) to a bounded cache file.
- Gate: zero mismatches over the corpus and seven days of real files; WASM
  ≤ 250 KB raw / ≤ 100 KB gzip; TS fallback works if WASM fails to load.
- Rollback: delete the crate and the Rust workflow; nothing user-visible
  changed.
- Recorded gaps after the CP2a review (do not silently drop):
  - `expected.json` has no `isPassedThreshold` field. The Rust parity test
    pins the value for every committed `t:` todo until CP1/CP2b adds the field
    to `unit-tests/port-corpus.test.ts`.
  - `FILE_TOO_LARGE` / `TOO_MANY_LINES` / `LINE_TOO_LONG` are generated
    TypeScript-side only; the Rust corpus cannot pin them until CP2b decides
    whether to commit those fixtures.
  - A corpus fixture for JS-whitespace/`U+FEFF` trimming and the 8 192-unit
    astral boundary is a CP0 follow-up. Rust unit tests cover both today.

#### CP2b — WASM batch API, contract candidate, adapter, shadow

- `thar-wasm` now exports the real batch surface: `parseFile(text, today)` and
  `parseFileWithLimits(text, today, maxFileBytes, maxReadTodos, maxLineChars)`
  return the CP1 JSON envelope, plus `coreVersion()`. The limit parameters are
  `f64` (a JavaScript `Number`) and are clamped, so a limit above 4 GiB does not
  wrap and a `BigInt` round-trip is not needed. The `recordCount` scaffold is
  gone. JSON is written by hand (no `serde`), so field order is part of the code
  and the module stays far inside the size budget.
- `tools/port/candidates/wasm.mjs` is a plain-Node candidate over the built
  package: raw bytes, lossy UTF-8 decode, `node:crypto` hashes, production read
  limits from the environment, and the CP1 error record shape.
- `logic/core-wasm.ts` is the dev-only adapter (`parseFileWithCore`) and the
  `THAR_SHADOW=1` check. It loads the package with `createRequire` and a
  module-relative runtime path; there is no `process.cwd()` candidate, so the
  build, the test matrix and `npm run check` never require Rust or a built
  `pkg/`, and an unrelated working directory cannot shadow the checkout's
  package. `THAR_CORE_WASM` is a **dev-only escape hatch** for pointing the
  adapter at another build, and it is resolved with `path.resolve`, so a
  _relative_ value is still relative to `process.cwd()`. The working directory
  therefore only decides where an explicitly named package lives — it can never
  cause a package to be picked up implicitly. Any failure degrades to
  "TypeScript only" with at most one debug line that never quotes the input.
- The shadow check passes the effective `ReadLimits` of the load to
  `parseFileWithLimits`, so a `THAR_MAX_*` override cannot produce a spurious
  `FILE_TOO_LARGE`/`LINE_TOO_LONG` rejection.
- Shadow records are content-free: counts, todo indexes, 16-hex-digit SHA-256
  digests of the serialized lines, and the serialized-file digests. A todo line
  _is_ its own `hash`, so raw lines are never written. The log is
  `<cache>/thar/shadow.log` (`THAR_SHADOW_LOG` overrides), capped at 64 KiB by
  truncating the file before an append would exceed it. One record is appended
  per load that differs, not once per process; only the `console.warn` summary
  is once per process.
- `THAR_CORE=ts|rust` is read but inert at CP2: both values keep the TypeScript
  implementation as the source of truth, and a test pins that. CP3 is the switch.
- Evidence at landing: 0 contract diffs over 28 fixtures / 3 432 008 contract
  bytes (including `large-10000.txt`, `bom.txt`, `invalid-utf8.txt`);
  WASM 49 568 bytes raw / 22 200 bytes gzip after wasm-opt; `npm test` and
  `npm run check` green with and without `pkg/`; shadow smoke over the whole
  corpus with 0 mismatches and no log file created.
- Still open for the CP2 gate: seven days of real files with `THAR_SHADOW=1`,
  then a review of the bounded cache file. The recorded gaps above (no
  `isPassedThreshold` in `expected.json`, no committed limit-error fixtures)
  stay open — CP2b deliberately does not add `testdata/port/**` fixtures.

### CP3 — Rust read path opt-in

- `THAR_CORE=rust` uses Rust for parse + sort/filter/index/search and row
  building. Writes still go through the TS serializer.
- Address the CP2a perf TODOs before this checkpoint ships: the prefix scanner
  allocates two `Vec`s per line (12.7 ms per 10 000-line parse; intended fix:
  fixed `[Option<&str>; 2]` plus an invalid-date flag) and tag lookup is a
  linear scan (O(tags²) per todo across the predicates; intended fix:
  insertion-ordered key→index map).
- Keep the immutable setters encapsulated (`fn(self) -> Self` builders, no
  public mutable fields) so the `dates_in_text` / `completion_date_in_text`
  round-trip flags cannot be desynchronized from `text`.
- On any WASM init/parse error: log once, fall back to TS, keep running.
  Never surface a raw Rust error in the TUI.
- Gate: corpus and randomized lists produce byte-identical rows and
  `getHash()` values; `npm test` passes with the flag; no latency/memory
  regression at 50/3 k/10 k.
- Rollback: `THAR_CORE=ts` (and make `ts` the default again).

#### CP3a — domain port (no behaviour change, no wiring)

- `thar-core` now owns recurrence planning, the immutable setters and
  `toggle_state`, sort / hidden filter / search, the contiguous-context row
  model, and the pure navigation helpers. The setters are `fn(self) -> Self`
  builders in the merged module, so they clone on write and cannot mutate a
  borrowed todo; `Clone` deep-copies the project/context lists and tag arrays.
- `tests/domain-expectations.json` pins the port against the TypeScript
  oracle: per corpus fixture the sorted/visible indexes, the row encoding, the
  per-todo normalized search view, and the search results for a fixed query
  list replayed from host-normalized terms, plus a deterministic 1 000-todo
  list, the collation probe, the search-case table (sigma and astral-dot
  shapes) and the recurrence/setter/toggle cases. The Rust tests read it and
  never regenerate it; `tests/generate-domain-expectations.ts` documents how it
  was produced.
- **Collation:** no host input is needed. Context names are scanned with
  `[\w.\-]+` (`A-Za-z0-9_.-`), and for that alphabet the ICU default order is
  `_ - . 0..9` then case-insensitive letters with lowercase before uppercase
  for the same primary weight, plus the ICU prefix rule. `thar-core` implements
  that comparator directly; the committed probe covers every single character
  and 485 strings. Priority comparison uses the same order restricted to
  `A`..`Z`. The oracle's order depends on the host locale/ICU version, so the
  expectations record Node and ICU and would need regeneration if the ICU
  default order changed. CI and development run `en-US`; the locale assumption
  is open decision 8 in §13.
- **Case folding and search terms are host-provided.** `String.prototype.toLowerCase`
  applies the Unicode `Final_Sigma` rule (skipping `Case_Ignorable` on both
  sides) and `extractSearchTerms` is a JavaScript regex pipeline; Rust's
  Unicode version can trail the host's. `thar-core` therefore takes
  `SearchView`s (already lowercased text/contexts/projects) and
  already-normalized terms instead of folding or splitting them. CP3b's
  adapter computes one view per todo on load or mutation; only the terms change
  per keystroke. The committed search cases cover the internal-final-sigma
  shapes that a naive per-character fold gets wrong.
- `reconcileNavState` is deliberately not ported: it keys its cache on object
  identity, which has no portable equivalent; the host knows whether the list
  changed and composes the pure helpers instead.

#### CP3b1 — row builder + live rows contract (no wiring)

- `thar-core::build_rows` composes the existing pieces without duplicating
  them: `sort_by_importance` → the visibility filter (unless hidden todos are shown)
  → the `filter_by_search` predicate → `create_rows`. It returns `Rows`: the
  `Row` list plus the ordered input indexes behind the todo rows, so the host
  maps rows back without a second pass. Empty terms match everything; a view
  count that is not aligned with the todos is a typed `RowError`.
- `Todo::from_parts`/`TodoParts` rebuild a todo from already-parsed fields
  (including the two round-trip flags); re-serializing would collapse duplicate
  tag arrays and cannot recover the flags.
- `thar-wasm` exports `buildRows(input)` over a JSON `TodoRecord` DTO:
  `{today, showHidden, terms, todos, searchViews}` →
  `{"ok":true,"rows":[…],"order":[…]}`. Fields are validated while decoding
  (a hand-written JSON reader, no new dependency), invalid input is a typed
  `{"ok":false,error:{…}}` envelope, and nothing panics. The boundary stays
  coarse: one call per build.
- `tools/port/rows.ts` + `rows-cli.ts` is the live contract: the TS pipeline
  (oracle) versus `parseFile` + `buildRows` (candidate) over every parseable
  fixture plus a generated 1 000-todo list, for 12 fixed queries and both
  `showHidden` values. Evidence: **504 records / 4 450 270 bytes, 0 diffs**
  after CP3b2b added the final-sigma probe line; the self-check proves two runs
  are byte-identical and catches four seeded row-builder/query mutations. The
  candidate derives its search views from the WASM parse output, closing the
  parse→view gap; the terms come from the host in a manifest, so the core never
  folds case. The skipped-fixture set is narrowed to the validation error family
  and asserted against CP1's eight error records.
- CP3a follow-ups in this checkpoint: a no-fold test (`filter_by_search` never
  lowercases), the reverse final-sigma search cases, and the empty-terms
  contract.
- Perf at 10 000 todos (release WASM, Node, 120×40, whole-list build as
  `createIndexes`). Two benchmarks exist and they do **not** measure the same
  scope, so neither is a general "N×" claim:
  - `tools/port/bench-rows.ts` (the rows contract's own generated list, the full
    stateless call including the 2.5 MB request): WASM **82–89 ms p50 / 86–106
    ms p95** against TS **525–535 / 542–592 ms** on this machine. That gap is
    dominated by the generated list's many distinct mixed-case contexts, where
    the TS `localeCompare` sort is the cost.
  - `scripts/bench-rows.ts` (the app-shaped adapter path through
    `buildRowsWithCore`, warm records/views cache): WASM **66–74 / 69–82 ms**
    (plus a cold-input variant at **77–87 / 85–110 ms**) against TS **82–85 / 85–130 ms**. With the app's list shape the TS sort is much cheaper, so the
    Rust row build is only modestly ahead — and cold marshalling can be at
    parity.

  Both are well short of the **≤ 5 ms** per-keystroke target: that target is a
  future optimization goal, not a current claim. The core alone is 7.9/8.6 ms
  (sort 5.6 ms), so the marshalling dominates: the request is decoded on every
  keystroke. CP3b2b records these numbers only; the stateful handle and
  precomputed collation ranks stay deferred, and the numbers live in
  `tools/port/README.md`, not silently accepted. WASM size after the row
  surface and the round-trip flags: **81 831 bytes raw / 35 986 bytes gzip**
  (budget 250 KB / 100 KB).

- Deferred: the stateful cache, host/computed sort ranks (with their own
  optimization phase), and the opaque programme-supplied name fields.
- CP3b2b connects the export: the adapter sends `searchViews` (the name the
  merged decoder requires), sends the two round-trip flags, logs the typed
  rejection `code`, gates an empty Rust result against the TS pipeline, and
  falls back on a non-en-US host collation (PLAN §13 decision 8). A real-package
  test in `unit-tests/core-wasm.test.ts` runs in the wasm CI job and skips
  cleanly when `crates/thar-wasm/pkg/` is absent. No user behaviour changes:
  `THAR_CORE` remains opt-in and `ts` stays the default.

#### CP3b2c — parse wired (`THAR_CORE=rust` reads with Rust)

The flag now covers the whole read path: `readTodosFromFile` parses the decoded
file with one `parseFileWithLimits` call and rebuilds the list from the parsed
records. `ts`/unset is byte-identical to before: no package load, no extra
parse, no log.

- **Exact reconstruction.** `Todo.fromParts(parts: TodoParts)` rebuilds a todo
  from typed fields without re-parsing `text`, including array-valued tags
  (`beta:one beta:two`) and both round-trip flags. The adapter validates the
  wire shape in `parseRecordToTodoParts` (priority letter, exact `YYYY-MM-DD`
  calendar dates, ordered tag pairs, state/`isDone` agreement, `hash ===
  toString`) and returns `undefined` on anything unexpected.
- **Envelope additions.** `parse_file` records append `datesInText`,
  `completionDateInText` and the 0-based load-order `id`. Re-parsing the line
  cannot recover the flags (12 of the 13 flag-bearing corpus lines are
  ambiguous from the serialized bytes alone), and an id makes a reordered
  envelope detectable without a second parse. The CP1 contract is frozen:
  `tools/port/candidates/wasm.mjs` projects exactly the 14 CP1 fields, so the
  `wasm` contract stays byte-identical.
- **Error mapping.** A Rust `ok:false` is mapped back to the same
  `TodoFileValidationError` subclass by code, and the regenerated TypeScript
  message must equal the Rust one (so the numeric fields are proven before the
  error is thrown). An unmappable rejection falls back to the TypeScript
  validator, which throws the true error; invalid data is never accepted.
- **Fallback policy.** Missing package/export, malformed envelope, a thrown
  error, a record count that differs from the file's non-blank line count, a
  load id that is not its position, a record that does not rebuild
  byte-identically, and an unprovable rejection all keep the TypeScript result
  after one bounded, content-free debug line. `THAR_SHADOW` is superseded in
  rust mode: the read path already parsed with Rust, so it does not parse twice.
- **Runtime grouping guard.** A byte round-trip cannot see `projects`/`contexts`
  (they are body fields, not tags), so the adapter re-derives both name sets
  from `record.text` with the constructor's `PROJECT_REGEX`/`CONTEXT_REGEX` and
  rejects a record whose sets differ. Without this, a package built from another
  commit could silently change `createIndexes` grouping.
- **WASM size** after the parse surface: **84 632 bytes raw / 37 292 bytes
  gzip** (+443 / +138 over CP4; budget 250 KB / 100 KB).
- **Contract evidence.** `tools/port/parse.ts` + `parse-cli.ts`: **28 records /
  3 931 057 bytes, 0 diffs** for both the self candidate and the wired WASM
  candidate (20 parseable fixtures including `large-10000.txt`, plus CP1's eight
  rejection fixtures compared as `kind: "error"`). The self-check proves the
  factory is lossless and deterministic and catches four seeded reconstruction
  bugs (`drop-last-tag`, `swap-dates`, `lose-round-trip-flags`,
  `reverse-records`).
- **Tests.** `unit-tests/todo-from-parts.test.ts` replays every one of the
  10 185 parseable corpus lines through the production projection and factory
  (byte-identical `toString`, identical fields, duplicate tags, both flags,
  invalid leading dates, a body-less date). `unit-tests/core-wasm.test.ts` adds
  the read-path matrix: rust vs ts over CRLF/blank/empty/no-newline/invalid-UTF-8
  files, instance mutability and ids, each error mapping, every fallback (count,
  order, bad date, missing flags, non-round-trip, unmappable/stale rejection,
  malformed envelope, missing package, one bounded content-free log), `ts` mode
  never loading the package, and the real `pkg/` parse + error parity that runs
  in the wasm CI job. Full suite green with and without `pkg/`.
- **Still `ts` by default.** CP5 flips the default, deletes the dual-write
  compare and the runtime shadow path, and packages the WASM artifact.

### CP4 — Rust write path opt-in, byte-compared

- `THAR_CORE=rust` serializes to a temp file in the same directory, reads it
  back, and compares **byte-for-byte** with the TS serializer output.
- Only on exact equality: fsync + rename over `todo.txt` (POSIX), or the
  Windows replace path. Preserve file mode. On any mismatch or error: keep the
  old file, fall back to TS, and show a bounded diagnostic.
- Add crash tests: kill the process before/after rename, full disk, read-only
  file, concurrent external edit.
- Gate: no partial/zero-length files, no content change on failure, and the
  corpus round-trips exactly. Run against copies of real files first.
- Rollback: `THAR_CORE=ts`; the dual-serialization code is removed at CP5.

#### CP4 — implemented (opt-in, default is still `ts`)

The checkpoint is complete on `feature/rust-port`. `THAR_CORE=ts`/unset still
loads no package and does no second serialization, but every mode now performs
one extra best-effort `fsync` per save before the rename (measured ~0.4 ms →
~4 ms on a warm local file, hidden by the 50 ms save debounce).

- **Export.** `thar-wasm` adds `serializeFile(input)`:
  `{"todos":[TodoRecord…]}` → `{"ok":true,"text":"…"}` or
  `{"ok":false,"error":{…}}`. The record DTO is the one `buildRows` already
  takes (moved to `crates/thar-wasm/src/record.rs`), so tags stay array-valued
  and both round-trip flags cross the boundary. Each record is rebuilt with
  `Todo::from_parts`, so nothing is re-parsed and no unwrap can see wire data.
- **Exact write shape.** Per-record `Display`/`to_string()`, joined with `"\n"`, plus
  **one trailing `"\n"`**. Zero todos is not a special case: the TypeScript
  oracle is `[].join("\n") + "\n"`, which is `"\n"`, so an empty todo list
  writes a one-byte file, not an empty one. `empty.txt` pins that in the write
  contract (bytes 1, sha256 `01ba4719…`).
- **The write-time guard runs in Rust.** Before any text is returned, the lines
  are scanned in order for the first rejected control code point
  (`0x00–0x1F`, `0x7F–0x9F`, `U+2028`, `U+2029`; tab allowed). The rejection is
  the only `ok:false` envelope with class `TodoControlCharacterError` and code
  `UNSAFE_CONTROL_CHARACTER` (deliberately not the read path's
  `CONTROL_CHARACTER`), carrying `index` (1-based line) and `codePoint`. Its
  message is `CoreError::ControlCharacter`'s `Display`, byte-identical to
  `TodoControlCharacterError`'s. Because the TypeScript guard already accepted
  these lines, a Rust-only rejection is a package divergence: the adapter reports
  its code once and keeps the TypeScript text instead of blocking the save. Any
  malformed or unexpected rejection falls back the same way.
- **Dual write, one write.** `writeTodosToFile` always computes the oracle text
  with `serializeTodosForWrite`. In `rust` mode it also asks
  `serializeTodosWithCore` and compares the two with
  `Buffer.from(rust).equals(Buffer.from(ts))` — a byte compare, not a string
  compare. The TypeScript bytes are what is written in every mode: equality
  proves the Rust serializer agrees, and the gate is a verification step rather
  than a second writer. A mismatch logs one bounded, content-free line (byte
  lengths and the first differing byte); an adapter failure (`undefined`) and
  every rejection keep the TypeScript text. The chosen text is validated
  (`validateTodoFileContent` + `maxFileBytes`) and written **once**, so
  `done.txt` appends exactly once.
- **Byte compare before the write, not a temp-file read-back.** The plan said
  "write a temp file, read it back, compare". Comparing the two in-memory
  strings decides the same question strictly earlier (nothing touches the disk
  on a mismatch) and the writer then writes exactly the compared buffer plus the
  atomic replace below. A read-back would add I/O and a second decode without
  strengthening the guarantee; the on-disk bytes are still pinned by the tests
  and the write contract.
- **Atomic replace + durability.** `Runtime.writeTextFile` keeps temp + rename
  with the target's mode preserved, and now `fsync`s the temp file before the
  rename. The flush is **best effort**: a filesystem that cannot `fsync` a
  regular file must not fail a save. Directory `fsync` (which would also persist
  the rename) is deliberately not done — it is not portably available and is
  deferred with the rest of the durability work. Windows uses the same path
  (Node's `rename` is the platform replace); it is best effort there too.
  The append (`done.txt`) and exclusive-create paths are unchanged.
- **Data-safety matrix** (`unit-tests/todo-file-write-safety.test.ts`, real
  `fs`, temp dirs, no sleeps):

  | Case                                                                                    | Result                                                                                                                                          |
  | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
  | crash before rename (child process, `NODE_ENV=test` + `THAR_WRITE_CRASH=before-rename`) | target is the old file; the leftover temp is inert and the next save succeeds                                                                   |
  | injected write failure (`ENOSPC`)                                                       | error propagates, target byte-identical, no temp file left                                                                                      |
  | injected rename failure (`EIO`)                                                         | error propagates, target byte-identical, temp removed                                                                                           |
  | read-only directory                                                                     | `EACCES` propagates, target and siblings untouched, no temp                                                                                     |
  | read-only file in a writable directory                                                  | POSIX: replaced (rename checks the directory), mode 0444 preserved — existing behaviour, Windows refuses with `EPERM` and the file stays intact |
  | concurrent external edit                                                                | never read-modify-write (`readTextFile` is not called); the external content is replaced whole, never spliced                                   |
  | Rust text differs                                                                       | TypeScript bytes on disk, one bounded log, no throw                                                                                             |
  | Rust envelope broken/absent/throwing                                                    | TypeScript bytes, one bounded log                                                                                                               |
  | Rust `UNSAFE_CONTROL_CHARACTER`                                                         | `TodoControlCharacterError` with the same name/code/line/code point/message, nothing written                                                    |

- **Contract evidence.** `tools/port/write.ts` + `write-cli.ts` +
  `candidates/wasm-write.mjs`: the production writer (oracle) versus
  `serializeFile` fed the app's own `coreTodoRecord` DTOs. **23 records / 3 566
  bytes, 0 diffs** over 20 parseable fixtures plus 3 guard probes, and 3 seeded
  mutations (dropped trailing newline, swapped date pair, dropped last tag) are
  all caught. The self-candidate also proves the DTO is **lossless for
  serialization**: rendering the same records reproduces the oracle bytes for
  every fixture. The skipped set is exactly CP1's eight rejection fixtures.
- **WASM size** after the write surface: **84 189 bytes raw / 37 190 bytes
  gzip** (budget 250 KB / 100 KB; +2 358 / +1 204 bytes over CP3b2b).
- **Locales.** The row builder still falls back to TypeScript off an
  `en-US`-equivalent collator (PLAN §13 decision 8). Writing does not sort, so
  the locale guard does not apply to it: the write path is byte-compared
  regardless of locale.
- **Deferred.** Stateful handles (decode once per list), host/computed
  collation ranks, request-decoding allocation work, directory `fsync`, stale
  `.tmp` cleanup, and `apply_command` all stay out of CP4. CP5 flips the default
  (`THAR_CORE=rust`) and deletes the dual-serialization code once a release cycle
  reports no data loss.

### CP5 — Rust core default

- Default `THAR_CORE=rust` in the Node app; keep `ts` as an escape hatch for
  one release.
- Keep the offline differential harness in CI forever; remove runtime shadow
  and dual-write paths.
- Gate: one full release cycle with zero data-loss reports; release notes name
  the opt-out.
- Rollback: flip the default back to `ts` in one commit.

#### CP5 — implemented (the Rust core is the default)

`feature/rust-port` now runs the Rust core by default in the Node app, and the
published npm package contains the WASM that makes that possible. `THAR_CORE`
is read once per path, so the whole switch is one function and one commit to
revert.

- **Default flip.** `getCoreMode()` returns `"rust"` for `rust`, an unset
  variable and an empty value; `"ts"` when `THAR_CORE=ts` is set explicitly.
  The value is trimmed and case-folded, so `TS` and `" ts"` still opt out. An
  unrecognized value (a typo such as `THAR_CORE=wasm`) keeps the
  Rust default and logs one bounded line that names neither the value nor any
  file content: silently falling back to the old core on a typo would hide the
  mistake, and defaulting to Rust is what the release notes say happens. All
  three wired paths read the same function: parse (`readTodosFromFile`), rows
  (`useNavigationState`) and the byte-compared write (`writeTodosToFile`).
- **Escape hatch.** `THAR_CORE=ts` returns before any package load, has no
  adapter, no second serialization and no diagnostic line, and is covered by
  tests that assert a deliberately broken `THAR_CORE_WASM` is never required.
- **Fallback stays total.** A missing, unbuildable or broken package, an absent
  export, a malformed envelope, a rejected `today`, a non-en-US host collator,
  a record that does not rebuild byte-identically, and any thrown error all
  keep the TypeScript result after **one** bounded, content-free `console.debug`
  line. Nothing throws into the TUI, and a proven read rejection is still the
  same `TodoFileValidationError` subclass with the same message.
- **Dual write kept (documented deviation).** The PLAN's CP5 line said to
  delete the dual-write path; this checkpoint keeps it deliberately. The
  TypeScript serializer is still the writer and the Rust text is byte-compared
  against it, so a package that ever disagrees writes the oracle bytes and logs
  once. CP8 removes the TypeScript writer (and with it this belt), not CP5.
- **Runtime shadow removed.** `THAR_SHADOW=1`, its bounded cache log, its path
  resolution and its tests are gone: nothing production depended on them, the
  durable oracle is the offline harness below, and a runtime differential check
  would have parsed every file twice in the default configuration. The offline
  harness (`npm run port:contract*`) stays in CI permanently.
- **Packaging.** `package.json` ships `crates/thar-wasm/pkg/**` next to
  `dist/main.js`, so `bin/thar.js` resolves the package through the existing
  module-relative loader (`resolve(MODULE_DIR, "..")`) with no new candidate and
  no cwd lookup. `prepack` runs `npm run build:wasm && npm run build`;
  `build:wasm` runs `wasm-pack build crates/thar-wasm --release --target nodejs
  --out-dir pkg --locked`, and a small `scripts/clean-wasm-pkg.mjs` deletes the
  `*` `.gitignore` wasm-pack writes into `pkg/` (npm honours nested ignore files
  even when `files` names the directory, which silently shipped a tarball with
  no WASM). `npm run build` still works without Rust; a source checkout without
  `pkg/` falls back to TypeScript with one debug line. Only packing/publishing
  needs the Rust toolchain.
- **Tarball.** `npm pack` on this checkpoint is **107 943 bytes** (12 files),
  up **41 679 bytes** from the 66 264-byte TypeScript-only tarball:
  `thar_wasm_bg.wasm` 84 632 bytes, `thar_wasm.js` 11 571, the two `.d.ts`
  files and the nested `pkg/package.json` + `LICENSE`. The GIF is not shipped.
- **CI.** `package-smoke` installs Rust + wasm-pack + binaryen, packs the real
  tarball, runs the **full** `npm test` suite against the packed `pkg/` (the
  shipped configuration), asserts `crates/thar-wasm/pkg/thar_wasm.js` and
  `thar_wasm_bg.wasm` are inside the tarball, installs it into a temp project,
  runs `thar --version`/`--help` in the default mode and with `THAR_CORE=ts`,
  and requires the packaged module to load and answer `coreVersion()` +
  `parseFile()`. `version-guard` got the same toolchain because
  `npm pack --dry-run` runs `prepack`; the release `publish` job installs Rust
  and wasm-pack, packs a tarball first, and fails loudly if the WASM is missing
  before `npm publish`.
- **Tests.** The full suite is green **with and without** `crates/thar-wasm/pkg/`
  (922 passed with the package and the six real-package tests skipped without
  it). Tests that pin the TypeScript oracle set `THAR_CORE=ts` explicitly:
  the corpus characterization suite and the escape-hatch suites. New
  default-mode coverage: `getCoreMode()` for unset/`rust`/`ts`/empty/unknown
  (one log, no value echoed), a fake-package default-mode read with no
  diagnostic, the unset-default dual write, the default row builder in the hook,
  and the adapter forwarding the effective `ReadLimits`.
- **Evidence.**
  - `npm run port:contract:check`: 28 fixture records / 3 432 008 bytes, match;
    `port:selftest` catches all 5 seeded mutations.
  - `npm run port:contract:rows` (self and WASM): 504 records / 4 450 270
    bytes, 0 diffs, 4 mutations caught; `port:contract:write`: 23 records / 3 566
    bytes, 0 diffs, 3 mutations + 3 guard probes; `port:contract:parse`: 28
    records / 3 931 057 bytes, 0 diffs, 4 mutations caught.
  - `cargo fmt --check`, `cargo clippy --locked -D warnings`, `cargo test
    --locked --workspace --all-features` (140 + 32 + 13 + 3 + 41 + 9 tests)
    green.
  - WASM **84 632 bytes raw / 37 292 bytes gzip** after wasm-opt (budget
    250 KB / 100 KB).
  - `npm run check`, `npm test` and `npm run doctor -- --scope changed`
    (score 100) green; `npm run build` green with and without `pkg/`.
  - Default-mode proof from the packed build: a probe package wrapping the real
    `crates/thar-wasm/pkg` recorded `parseFileWithLimits` on load, `buildRows`
    on each list build and `serializeFile` on the save in a pseudo-TTY run with
    `THAR_CORE` unset, and the completed todo was written to disk; the same run
    logged no `thar core:` line. (The exact call counts depend on session
    length; the property is that all three paths reach Rust.) `THAR_CORE=ts`
    runs load nothing.
  - `docs/rust-port/assets/cp5-rust-default.gif` (436 173 bytes): default
    startup with priorities/contexts/projects/due/threshold/hidden/completed
    rows, a `work` search, completing a todo, then `cat` showing the written
    line.
- **What CP8 removes.** The TypeScript reader/pipeline/serializer and the
  `THAR_CORE` switch, `logic/core-wasm.ts`, the dual write, Ink/React/date-fns,
  and the npm WASM subpath (the Rust TUI becomes the package). Until then the
  offline contracts and the TypeScript corpus stay as the oracle.

### CP6 — Read-only Rust TUI (separate binary)

- `thar-rs` opens the file read-only. It cannot write: no write API is linked
  into the read-only build, and attempts are rejected explicitly.
- Port list rendering, navigation, search, action bar, scrollbar, toaster,
  terminal lifecycle, mouse wheel/click/shift-click/double-click.
- Gate: PTY tests (Linux/macOS), mouse parity, terminal restore on panic,
  p50/p95 targets from §2. Ship it as a separate binary; do not change `thar`.
- Rollback: stop shipping the binary; the Ink app is untouched.

**Landed.** CP6 is implemented as a second binary, `thar-rs`, in the existing
workspace; the Ink app, `bin/thar.js` and the npm entry point are untouched.

- `crates/thar-tui` holds the app state (`App`), the owned row model
  (`ListModel`, rebuilt only when the query/hidden flag/day/todo list changes),
  navigation and scroll-padding, search normalization, the keyboard and SGR
  mouse keymap, the shared layout/hit-test geometry, the theme, and the view.
- `crates/thar-cli` holds the binary: `cli.rs` (`-f/--file`, `-h/--help`,
  `-v/--version`, `--no-update-check`; `update` is rejected with a bounded
  message), `file.rs` (read-only loader, no create path), `terminal.rs` (raw
  mode, alternate screen, mouse capture, bracketed paste, a restore-on-panic
  hook, and the draw/event loop) and `main.rs`.
- Read-only proof: no write API is linked; mutating keys answer with one
  bounded toast; a missing file is reported and is not created; a directory
  argument fails cleanly. `tests/pty/main.rs` asserts a real PTY session leaves
  the file bytes, mtime and directory entries untouched; `tests/read_only.rs`
  covers the non-TTY startup paths, and `tests/no_write.rs` scans both
  `thar-cli/src` and `thar-tui/src` for write-capable APIs.
- PTY evidence (`crates/thar-cli/tests/pty`, `portable-pty` + `vt100` as
  dev-dependencies only; 100×30, `TERM=xterm-256color`, polling waits and no
  fixed sleeps):
  - initial screen: todo text, `"None"`/`home`/`work` context headers, the
    action-bar labels from `layout::ACTION_ITEMS`, `READ-ONLY`, and no
    missing-file note for a present file;
  - keys: Down/Up, Ctrl+Down/Up across context groups, Home/End, `/` focus,
    a live query, the no-results state, Enter keeping the filter, Escape
    clearing it, `H` showing `[HIDDEN TODOS VISIBLE]` plus the previously
    hidden rows, and `q` exiting 0;
  - mouse: SGR wheel up/down scrolls without moving the cursor, left click
    selects a row, shift-click (button 4) extends the range across three rows,
    and a double-click inside 350 ms shows the read-only toast;
  - lifecycle: Ctrl+C exits 0 and the raw stream contains the
    leave-alternate-screen, disable-mouse, disable-bracketed-paste and
    show-cursor sequences; a debug build with `THAR_TUI_PANIC=1` exits non-zero
    with the panic message emitted after the same restore sequences (the
    trigger is compiled out of release builds);
  - a missing file in an empty directory renders an empty list and creates
    nothing.
- CI: `.github/workflows/rust.yml` gains a `pty` job matrixed over
  `ubuntu-latest` and `macos-latest` (`cargo test -p thar-cli --test pty`) and a
  `windows` job that runs `cargo check -p thar-cli --all-targets`. The PTY
  target is `#![cfg(unix)]`, so the Windows job compiles the dependency tree
  and the other targets without pretending portable-pty can run there.
- `docs/rust-port/assets/cp6-tui.png` is a real frame captured from the PTY at
  100×30 and rendered from the parsed `vt100` cells (background, colours, text
  runs). The generator is the `#[ignore]`d `cp6_screenshot` test in
  `tests/pty/screenshot.rs`; it is never part of CI.

**Still open at CP6.** The §2 p50/p95 targets are not measured by this
checkpoint, so no benchmark or performance claim is made here, and the one-week
read-only navigation dogfood has not happened yet. The view-styling parity pass
(colours, scrollbar, empty/load-error states) is part of this checkpoint and is
covered by `crates/thar-tui/tests/golden.rs`. Writes and the 11 modals are CP7;
distribution and cutover are CP8.

### CP7 — TUI writes opt-in

- Add `--write`; the default remains read-only. Before the first write, keep a
  `todo.txt.bak` (mode 0600) or a timestamped backup; document how to disable
  backups.
- Save atomically (temp + fsync + rename), byte-compare against the current
  file shape, and refuse to overwrite on an unexpected read-only/error state.
- Port editing, all 11 modals, calendar, suggestions, undo/redo, archive,
  clipboard, multi-select.
- Gate: full data-safety suite, crash/kill tests, one week of dogfood,
  byte-identical files for no-op edits.
- Rollback: `--read-only`/omit `--write`; use the Ink app.

#### CP7 — foundation implemented (write mode, save safety, undo/redo)

The first CP7 slice lands the parts every screen depends on. It is deliberately
a pure infrastructure step: the list gains toggle, hidden-tag, priority and
undo/redo commands, while the modal screens arrive in parallel workstreams.

- **`--write` is opt-in.** `thar-rs` stays read-only by default, keeps the CP6
  `READ-ONLY` badge, and rejects every write command with the same bounded
  toast. `--write` enables saving and the new commands, shows a green `WRITE`
  badge, and creates a missing `todo.txt` (the Ink startup behaviour). The
  event loop flushes a pending save on `q` instead of dropping the last
  keystroke inside the 50 ms debounce.
- **New crate `thar-store`.** All write-capable APIs live here so the CP6
  scan of `thar-cli/src` and `thar-tui/src` still proves the read-only path:
  - `atomic::write_atomic` writes a sibling temp file, syncs it, preserves the
    target mode, and renames over the target; the temp is removed on error.
  - `save::SaveGuard` remembers the bytes the session last read or wrote and
    refuses to save when the file changed on disk (an external edit or delete),
    leaving the target byte-identical.
  - `backup` keeps one `todo.txt.bak` with mode `0600` before the first save;
    an existing backup is never overwritten, and `--no-backup` disables it.
  - `done::append_done` is the archive append; `clipboard` is the
    `pbcopy`/`clip`/`wl-copy`/`xclip` port.
- **Stable ids.** `TodoId` no longer doubles as the load-order index: create,
  delete and paste shift the vector, so `App::index_of` now looks the id up and
  every new todo gets a monotonic id from the session allocator. This was the
  CP6 invariant that could not survive CP7.
- **Undo/redo.** `thar-tui::history` snapshots the whole list per mutation, one
  step per command (matching `todo-context.tsx`), clears both stacks on a load,
  and is exposed through `z`/`Z`. Snapshots store `Rc<Todo>` handles, so a
  mutation replaces only the touched todo and shares the rest with history.
  Recurring toggles append their next instance.
- **Command seam.** The list keymap reports the new intents, `App` owns the
  mutation and the debounce (`SAVE_DEBOUNCE = 50 ms`), and `Effect` carries the
  host-only work (archive, clipboard) back to the event loop. `input::apply`
  stays pure.
- **Modal host.** `thar-tui::modal` owns one active screen, the centred
  geometry (`3 + body + 2` chrome), the `Action` vocabulary (create, text,
  delete, toggle, dates, priority, recurrence, tags, undo/redo, view, copy,
  paste, archive) and one exhaustive registry (`modal/registry.rs`) for every
  screen id. `view/overlay.rs` draws whatever the stack holds. A screen the
  host cannot build (the update screen without a model) shows one bounded
  message; `Confirm` is opened with its request instead of by id.
- **Tests and evidence.** `thar-store` 11 unit tests (atomic replace + mode,
  backup-once, external-edit refusal, deleted-target refusal, append, ensure);
  `thar-tui` app/history tests (stable ids, one-step group, undo/redo,
  recurrence copy, debounce); PTY tests for toggle + backup, undo restoring the
  original bytes, and a read-only run creating nothing; the ignored
  `cp7_write_screenshot` generator produced
  `docs/rust-port/assets/cp7-write.png` from a real 100x30 PTY.
  `cargo fmt`, `cargo clippy -D warnings`, and
  `cargo test --workspace --all-features` are green.
- **Deliberately not here.** The eleven modal screens, the calendar, the text
  editor and suggestions, the command menus, archive/copy/paste UI, and the
  watcher/reload loop arrive in the parallel CP7 PRs. No performance work was
  done, per the checkpoint instruction.

### CP8 — Cutover

- Make `thar` the Rust TUI, publish as npm `next` first, then `latest` after a
  week without data-safety reports.
- Remove Ink/React/date-fns only after one release cycle; keep the last Node
  release tag and the TS corpus as the archived oracle.
- Gate: §14 definition of done, install tests on npm/Homebrew/Scoop, rollback
  rehearsal on each platform.
- Rollback: re-point `latest` at the last Node release; keep the tag.

### Branch hygiene and parallel security work

`feature/rust-port` is **downstream** of the release lines. Security releases
must never wait for the port.

- **Direction:** merge `release/next` (and any hotfix commit that exists only
  on `main`) **into** `feature/rust-port`. Because the port branch is protected
  from direct pushes, do that sync through a PR from a small sync branch (or
  from `release/next` when it is a pure fast-forwardable merge). Never merge
  the port branch into a release line until a checkpoint is explicitly
  shippable.
- **Security first:** fix and release on `release/next`/`main` as usual. Once
  the security release is tagged, open the sync PR into the port branch
  immediately — do not wait for the next checkpoint or a weekly sync — and
  re-run the port gates.
- **Routine sync:** forward-merge `release/next` before starting each
  checkpoint and at least every two weeks. Weekly is a convenience, not a
  release gate. If `main` and `release/next` diverge, merge the line that
  contains the fix; usually `release/next` after the back-merge.
- **Never rebase** the shared branch. Resolve conflicts toward the security
  fix and re-run the corpus if a conflict touches `logic/`.
- **Both implementations:** when a fix changes shared behaviour, apply it to
  TS and (once it exists) Rust, and add a corpus case. If the port has already
  replaced the file, port the fix into Rust and record it in
  [`SECURITY-SYNC.md`](SECURITY-SYNC.md). Pure UI fixes stay TS-only until
  CP6, then must be ported before CP8.
- **Prefer small landings:** CP0 and CP1 touch no behaviour and land on
  `feature/rust-port` as small PRs. Land CP2 (shadow, off by default) and
  CP3/CP4 (opt-in flags) once their gates pass, instead of holding all nine
  checkpoints in one PR. The forward-merge rule above applies unchanged.
- **Protected branch:** `feature/rust-port` requires a PR, dismisses stale
  approvals, requires conversation resolution, blocks force pushes and
  deletions, and applies to admins too. Do not try to push to it directly;
  open a PR.
- One checkpoint per PR (one commit on the branch), with the gate result in
  the commit message. Tag `rust-port/cpN` after each gate.
- Keep `npm test` green at every commit. If a checkpoint cannot finish in a
  week, split it; do not let a red intermediate state live on the branch.
- Stop conditions: any serialization byte mismatch, any data-loss report, or
  corpus coverage below 100 % of §7 blocks the next checkpoint.

## 6. Work breakdown by phase

Estimates are for one experienced developer; parallelisable across two.

### Phase 0 — Freeze and safety harness (CP0–CP1)

Deliverables:

- [x] This plan and the checkpoint ladder (§5).
- [x] `testdata/port/` corpus and exact-byte characterization tests.
- [x] `docs/rust-port/baseline.md` with benchmark/startup/memory baselines.
- [x] TS-only differential harness with a seeded-bug proof.
- [x] Node CI job that runs the harness.

The Cargo workspace was deliberately deferred out of Phase 0; CP2a landed it
with `thar-core` and CP2b added the real WASM batch surface (§4). CP1's harness
landed with CP2b's base and the WASM candidate now runs against it in the Rust
workflow.

Exit criteria: the harness catches a seeded parser mutation, the corpus covers
every rule in §7, and `npm test` + `npm run check` are green.

### Phase 1 — Domain core (2–3 weeks)

Checkpoints: CP2 (first crate, read-only shadow) through CP3 (read path opt-in).

Port, in this order:

1. `patterns.ts`, `dates.ts`, `control-characters.ts`, `display-safety.ts`.
2. `logic/todo.ts` (prefix scan, parse, serialize, immutable setters,
   recurrence hook).
3. `recurrence.ts`, `limits.ts`, `todo-input.ts`, `todo-file-validation.ts`.
4. `Todos.ts` sort/filter + `indexes.ts` grouping.

Deliverables:

- `thar-core` API with `Todo`, `TagMap`, `TodoDate`, `Priority`, `State`,
  `Limits`, `CoreError`.
- Reuse the CP0 corpus in `testdata/port/` (add cases discovered while
  porting; do not create a second corpus).
- Reuse the CP1 differential harness: run the corpus through the existing TS
  implementation (`vite-node`) and the Rust crate; compare parsed fields and
  serialized lines byte-for-byte.
- `proptest` for parse→serialize→parse stability.
- `cargo-fuzz` target for `parse_line`; no panic accepted.

Exit criteria: 100 % corpus parity; 10 000 random lines with no panic; no
clippy warnings; fuzz target clean for 10 minutes in CI (nightly/manual).

### Phase 2 — Index/search + WASM adapter (1–2 weeks)

Checkpoints: CP2–CP3.

- Implement `build_rows(todos, query, show_hidden, today)` exactly matching
  current ordering: state, first context (None first), overdue, priority,
  stable order; contiguous-context headers with the `"None"` header preserved.
- Sort keys are precomputed once per todo (this is also the fix for the
  current per-comparison `isOverdue` cost).
- Batch mutations (`toggle`, `set_due`, `set_priority`, …) and recurrence
  instances.
- `thar-wasm` exports; `wasm-pack --target nodejs`; TS adapter package.
- Feature flag `THAR_CORE=ts|rust`; default `ts` until parity is green.

Exit criteria: parity for sort/filter/search/index over the corpus and
randomised lists; WASM ≤ 250 KB raw / ≤ 100 KB gzip; no UI changes required;
TS fallback still passes the full Vitest suite.

### Phase 3 — Production validation (1 week)

Checkpoints: CP3–CP4.

- Run the Rust core in development builds for a week of dogfooding.
- Round-trip real `todo.txt` files in a temp directory; compare every save.
- Map Rust errors to the current bounded display messages.
- Add benchmarks to CI as non-gating reports initially.
- Decide go/no-go for the TUI phase.

Exit criteria: no data loss or unexplained diff; no latency regression; the
team is comfortable making the Rust core the default for the next release.

### Phase 4 — ratatui shell (2–3 weeks)

Checkpoint: CP6 (separate `thar-rs` binary, read-only).

- [x] `thar-cli` binary that opens a file and renders a read-only list.
- [x] Terminal lifecycle + panic hook + mouse capture + bracketed paste.
- [x] Virtual list, context headers, selection, scroll padding.
- [x] Search input and filtering; action bar; hidden indicator; toaster.
- [x] Mouse wheel/click/shift-click/double-click.
- [x] `--version`, `--help`, `--no-update-check` parity.
- [x] Ship as `thar-rs`, not the default.
- [x] View-styling parity pass (scrollbar, per-tag colours, empty and
      load-error states) — pinned by the `thar-tui` golden frames.
- [ ] §2 p50/p95 measured on a real PTY.
- [ ] Read-only navigation dogfooded for a week.

Exit criteria: perf targets met on a real PTY; mouse parity checklist complete;
read-only navigation dogfooded for a week.

**Landed at CP6.** The binary, the read-only loader, the terminal session and
the event loop are in `crates/thar-cli`; the state, rows, navigation, search,
input, layout and view are in `crates/thar-tui`. `cargo test -p thar-tui`,
`cargo test -p thar-cli` and the workspace suite are green, and the macOS PTY
job runs the same integration test Linux does. The gate evidence is the PTY
suite described in CP6 (real 100×30 PTY: initial frame, keyboard, search,
hidden view, SGR mouse wheel/click/shift-click/double-click, Ctrl+C and panic
restore, missing file) plus the `docs/rust-port/assets/cp6-tui.png` frame
captured from that PTY. Windows is compile-only (`cargo check --all-targets`)
because portable-pty is Unix-focused.

Nothing in the Ink app changed: `thar` still starts the TypeScript UI, and the
rollback is to stop shipping `thar-rs`.

### Phase 5 — Editing, commands, modals (2–3 weeks)

Checkpoint: CP7 (`--write`, opt-in).

- Text editing (`ratatui-textarea`), cursor, validation, caps.
- 11 modals: create, edit, todo menu, multi-select menu, due, threshold,
  recurrence, priority, add project, add context, update.
- Calendar, suggestion overlay/tag sources, multi-select range commands.
- Toggle/undo/redo/history, archive, clipboard copy/paste, hidden view.
- Golden UI snapshots with `TestBackend` at fixed sizes.

Exit criteria: feature parity checklist (§7) complete; no known data-safety
issues; mouse and keyboard parity signed off.

### Phase 6 — System integration (1–2 weeks)

Checkpoints: CP7–CP8.

- File sync: load/save, atomic replace, read-only recovery, watcher and
  debounces, `done.txt` append.
- Limits/errors, Windows code page, install-method detection, update check,
  `thar update`, self-update policy.
- Clipboard fallbacks.
- PTY integration tests for input, mouse sequences, resize, paste.

Exit criteria: full parity suite green; one release candidate dogfooded;
rollback plan rehearsed.

### Phase 7 — Distribution and cutover (1–2 weeks)

Checkpoint: CP8.

- CI release matrix: linux x64/arm64 (gnu + musl), macOS x64/arm64, Windows
  x64. Build, strip, checksum, archive.
- macOS codesign + notarize; Windows optional signing; GitHub release assets.
- npm packaging: root package + per-platform `optionalDependencies` (esbuild
  pattern) or a checksummed postinstall download; keep `npx` working.
- Homebrew/Scoop manifests; update mechanism for native installs.
- Make the Rust TUI the default; keep the last Node release tag and a rollback
  path. Remove Ink/React/date-fns only after a full release cycle.

Exit criteria: installs work from npm, Homebrew and Scoop; self-update tested
on all platforms; memory/startup/latency targets verified on released
binaries; rollback documented and tested.

## 7. Feature parity checklist

| TypeScript today                                                                                                                                                                                                                                                                      | Rust destination                                                     | Phase |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----- |
| `logic/todo.ts`                                                                                                                                                                                                                                                                       | `thar-core::model`                                                   | 1     |
| `logic/dates.ts`, `patterns.ts`, `recurrence.ts`                                                                                                                                                                                                                                      | `thar-core::{date, parse, recurrence}`                               | 1     |
| `logic/limits.ts`, `todo-input.ts`, `todo-file-validation.ts`, `control-characters.ts`, `display-safety.ts`                                                                                                                                                                           | `thar-core::{limits, input, validation, display}`                    | 1     |
| `logic/Todos.ts` (sort/filter)                                                                                                                                                                                                                                                        | `thar-core::query`                                                   | 1–2   |
| `logic/indexes.ts`                                                                                                                                                                                                                                                                    | `thar-core::rows`                                                    | 2     |
| `logic/navigation.ts` (pure helpers)                                                                                                                                                                                                                                                  | `thar-core::nav`                                                     | 2     |
| `logic/todo-file-helpers.ts`, `todo-file-repository.ts`                                                                                                                                                                                                                               | `thar-cli::file`                                                     | 6     |
| `logic/cli.ts`, `install-method.ts`, `package.ts`, `version.ts`                                                                                                                                                                                                                       | `thar-cli::cli`                                                      | 6     |
| `logic/update-check.ts`, `update-cache.ts`, `update-cli.ts`, `self-update.ts`, `pending-update.ts`, `update-badge.ts`                                                                                                                                                                 | `thar-cli::update`                                                   | 6     |
| `logic/clipboard.ts`                                                                                                                                                                                                                                                                  | `thar-cli::clipboard`                                                | 6     |
| `contexts/*` (8 providers)                                                                                                                                                                                                                                                            | `thar-tui::app` state                                                | 4–5   |
| `hooks/useInput.ts`, `useMouseInput.ts`, `useFocusedInput.ts`                                                                                                                                                                                                                         | `thar-tui::input`                                                    | 4     |
| `hooks/useNavigationState.ts`                                                                                                                                                                                                                                                         | `thar-tui::list_state`                                               | 4     |
| `hooks/useTodoCommands.ts`, `useTodoFileSync.ts`, `useTagSources.ts`, `useTodayKey.ts`, `useSuggestionInput.ts`                                                                                                                                                                       | `thar-tui::commands` / `thar-cli`                                    | 4–6   |
| `components/TodoList.tsx`, `TodoListScrollbar.tsx`, `ActionBar.tsx`, `HiddenIndicator.tsx`, `SearchInput.tsx`, `SuggestionOverlay.tsx`, `Toaster`                                                                                                                                     | `thar-tui::view::*`                                                  | 4     |
| `components/Modal.tsx`, `ConfirmModal`, `CreateTodoModal`, `EditTodoModal`, `TodoMenu`, `SetDateModal`, `SetPriorityModal`, `SetRecurrenceModal`, `AddTagContextModal`, `UpdateModal`, `Calendar`, `ControlledTextInput`, `SuggestionInput`, `ModalTodoInput`, `Button`, `SelectList` | `thar-tui::view::modals` + widgets                                   | 5     |
| `unit-tests/**` (92 files)                                                                                                                                                                                                                                                            | Rust unit/property/golden + differential harness; TS stays as oracle | 1–6   |

Subtle rules that must be covered by fixtures:

- The uncategorized `"None"` context header is part of the row model, not a
  display detail; row indexes and mouse coordinates depend on it.
- Completed lines keep invalid/ambiguous leading dates in `text` and set
  `_completionDateInText` so serialization does not duplicate them.
- Duplicate tag keys become arrays; `due` as an array is not overdue.
- `parseDateTag` rejects year 0000 and invalid calendar days.
- `MAX_TODOS = 10 000`, 1 MiB file, 8 192 read line chars, 2 000 edit chars,
  100 paste items.
- Sort order and stability, overdue computed once per todo per day.
- Missing/malformed threshold does not hide; missing/malformed due is not
  overdue.
- Recurrence plans use the completion time, not the due date, and produce a
  new open todo with the next due date.
- Saves are debounced 50 ms; reloads 500 ms; a failed load makes the session
  read-only until a later read succeeds.

## 8. Testing strategy

1. **Unit tests** in every crate; `cargo test --workspace`.
2. **Golden corpus + differential tests** for domain parity (Phases 1–3).
3. **Property tests** (`proptest`): parse/serialize round-trip, tag
   preservation, date validation, idempotent setters.
4. **Fuzzing** (`cargo-fuzz`): parser and tag scanner; no panics, no
   unbounded allocation.
5. **Snapshot rendering** (`insta` + ratatui `TestBackend`): 80×24, 120×40,
   200×60; focus/overdue/selection/modals. Compare cell buffers, not ANSI
   strings, so colour-capability differences do not break tests.
6. **PTY integration** (`expectrl` or `portable-pty`): real key/mouse escape
   sequences, resize, bracketed paste, Ctrl-C, terminal restore on panic.
   Linux + macOS in CI; Windows smoke.
7. **End-to-end benchmarks**: reuse the existing todo generator, protocol and
   percentiles; record wall/CPU p50/p95, output bytes and render counts.
8. **Data-safety tests**: read-only mode, atomic replace, crash mid-write,
   concurrent external edits, `done.txt` append.

CI must run 1–2, 5–6 and a fast subset of 7 on every PR. Fuzzing runs nightly
or on demand until the parser is stable.

## 9. CI/CD

### 9.1 Status: installed and active

The Rust workflow is installed at
[`.github/workflows/rust.yml`](../../.github/workflows/rust.yml); it is the only
copy, so it cannot drift from a draft. It is path-filtered (`Cargo.toml`,
`Cargo.lock`, `rust-toolchain.toml`, `crates/**`, `testdata/port/**`, the
workflow itself) so the Node pipeline is unaffected. CP2a ran it green with the
`thar-core` + `thar-wasm` scaffold; CP2b adds the CP1 contract run.

Jobs:

- **test** (ubuntu): `cargo fmt --all --check`, `cargo clippy --locked
  --workspace --all-targets --all-features -- -D warnings`, `cargo test
  --locked --workspace --all-features`. The row-perf measurement in
  `crates/thar-core/tests/rows_perf.rs` is `#[ignore]`d: it is a manual
  release-mode report, not a CI gate.
- **pty** (ubuntu + macos matrix, `fail-fast: false`): `cargo test --locked
  -p thar-cli --test pty`. This is CP6's real-terminal gate: it spawns
  `thar-rs` on a portable-pty pair and asserts keyboard, search, hidden view
  and SGR mouse behaviour, Ctrl+C/panic restore and the missing-file contract
  against a `vt100`-parsed screen. The `test` job runs the same target on
  Ubuntu; macOS is added because the kernel PTY, termios and mouse decoding
  differ. `portable-pty` and `vt100` are dev-dependencies only.
- **windows** (windows-latest): `cargo check --locked -p thar-cli
  --all-targets`. portable-pty is Unix-focused, so Windows compiles the crate,
  the binary and every test target but runs no PTY test; the PTY test target is
  `#![cfg(unix)]` and therefore empty there.
- **wasm** (ubuntu):
  - installs Rust 1.99.1 + `wasm32-unknown-unknown` (`dtolnay/rust-toolchain`);
  - caches with `Swatinem/rust-cache@v2` (key `wasm`);
  - installs `wasm-pack` via `taiki-e/install-action@wasm-pack`;
  - installs `binaryen` (`wasm-opt`) from apt, which wasm-pack prefers over its
    bundled optimizer;
  - runs `wasm-pack build crates/thar-wasm --release --target nodejs
    --out-dir pkg --locked`;
  - enforces the size budget: **≤ 250 KB raw, ≤ 100 KB gzip**;
  - runs a Node smoke test (`parseFile` ok/rejected envelopes, `coreVersion`)
    against the built package;
  - runs the CP1 contract against the WASM candidate (`npm ci` then
    `npm run port:contract:wasm`) after the package is built;
  - runs the CP3b1 rows contract against the WASM candidate
    (`npm run port:contract:rows:wasm`), including the generated 1 000-todo
    list; the TS-only half runs in the Node `port-contract` job;
  - runs the CP4 write contract against the WASM candidate
    (`npm run port:contract:write:wasm`) and the adapter plus data-safety suites
    against the package it just built (which includes the real-package corpus
    round-trip); the TS-only half runs in the Node `port-contract` job;
  - uploads `pkg/**` and `wasm-size.txt` as the `thar-wasm` artifact
    (14 days).

`--locked` fails the build when `Cargo.lock` is stale; `cargo fmt` has no such
flag because it does not resolve dependencies.

`crates/thar-wasm/LICENSE` is a symlink to the repository `LICENSE`, so
wasm-pack finds the license text and ships it in `pkg/` without a duplicate
copy to maintain.

Since CP5 the WASM is a shipped artifact, so the Node workflow packs it too:
**`package-smoke`** installs Rust 1.99.1 + wasm-pack + binaryen, runs
`npm pack` (which triggers `prepack` → `build:wasm` → `vite build`), asserts the
tarball contains `crates/thar-wasm/pkg/thar_wasm.js` and
`crates/thar-wasm/pkg/thar_wasm_bg.wasm`, installs the tarball into a temporary
project, runs `thar --version`/`--help` both in the default mode and with
`THAR_CORE=ts`, and requires the packaged module to load and answer
`coreVersion()` and `parseFile()`. **`version-guard`** gets the same Rust setup
because `npm pack --dry-run` also runs `prepack`. The release workflow's
`publish` job installs Rust + wasm-pack, packs the tarball it is about to
publish, and fails if either WASM file is missing.

Why a size gate: the incremental path only makes sense if the core stays
small enough to ship inside the npm package or fetch cheaply. The real CP2b
batch core measures 49 568 bytes raw / 22 200 bytes gzip after wasm-opt, so the
Phase 2 target (≤ 100 KB raw / ≤ 40 KB gzip) is already met; the workflow keeps
the 250 KB / 100 KB ceiling until the CP3 row and command surface lands, then
tightens the constants and the README together. After CP3b2b it is 81 831 /
35 986, after CP4's write surface 84 189 / 37 190, and after CP3b2c's parse
surface 84 632 / 37 292.

### 9.2 Add in later phases

- **Native matrix**: linux x64/arm64 (gnu/musl), macOS x64/arm64, Windows
  x64. Native tests + build on each PR after Phase 4.
- **PTY tests**: installed for Linux and macOS at CP6 (§9.1); the Windows
  smoke stays compile-only until a ConPTY runner exists.
- **Release workflow**: tag-driven, builds binaries + WASM, checksums,
  codesigns/notarizes, publishes GitHub release and npm packages.
- **Supply chain**: `cargo-deny` (licenses/advisories) and `cargo-audit`
  weekly; pin third-party actions by SHA once the workflow stabilises (the
  existing CI uses version tags, so follow the repo convention for now).
- **PR size reporting**: comment raw/gzip WASM size and the benchmark delta
  (non-gating until targets are stable).

### 9.3 Distribution plan (Phase 7)

- Rust binaries:
  `thar-{linux,macos,windows}-{x64,arm64}` archives with `.sha256`.
- npm: root package with `optionalDependencies` per platform, or a
  checksummed `postinstall` download. Keep `bin/thar.js` as a thin launcher so
  `npx @arnoarnoarno/thar` keeps working.
- Homebrew tap and Scoop bucket as today.
- Keep the last Node release tag (`v0.6.x` or the last before cutover) for
  rollback; publish Rust builds under the `next` dist-tag first.

## 10. Risks and mitigations

| Risk                                                  | Impact   | Mitigation                                                                                                                                                                                 |
| ----------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Silent data loss or altered lines                     | Critical | Differential harness, atomic writes, read-only mode, real-file dogfood, rollback tag                                                                                                       |
| Domain drift (dates, duplicate tags, `"None"` header) | High     | Fixtures for every known edge case; TS as oracle; property/fuzz tests                                                                                                                      |
| ratatui 0.30 is 0.x                                   | Medium   | Pin versions; upgrade deliberately; keep view code behind a thin layer                                                                                                                     |
| Native distribution complexity                        | Medium   | Start with GitHub releases + npm optional deps; codesign macOS; keep Node fallback                                                                                                         |
| Terminal/mouse differences                            | Medium   | PTY tests in Linux/macOS; Windows smoke; test tmux/SSH; document toggling mouse capture                                                                                                    |
| Scope creep in the TUI                                | High     | Phase gates and parity checklist; no new features until cutover                                                                                                                            |
| Contributor velocity (Rust + borrow checker)          | Medium   | Keep modules small; pair; document architecture; use `cargo` workspace conventions                                                                                                         |
| WASM boundary overhead                                | Low      | Coarse batch API; benchmark core calls at 50/3 k/10 k; never per-row FFI                                                                                                                   |
| CI flakiness / slow Rust builds                       | Low      | `rust-cache`, single fmt/clippy/test job, path filters, `lto` only in release                                                                                                              |
| Toolchain churn (1.99.1 pin)                          | Low      | Bump `rust-toolchain.toml` and the CI action together in one PR                                                                                                                            |
| Long-lived branch drift                               | Medium   | Forward-merge `release/next` after every security release and before each checkpoint; land completed checkpoints on `feature/rust-port`; tag each green CP; never rebase the shared branch |
| Partial port lives forever                            | High     | Every checkpoint has a gate and a removal plan; CP5/CP8 explicitly delete dual paths                                                                                                       |

## 11. Rollout and rollback

- Security releases always originate from `main`/`release/next`, never from
  `feature/rust-port`. The port is never a blocker for a security release.
- CP0–CP4: `THAR_CORE=ts` remains the default; `rust` is opt-in in
  development. No user-visible change; every checkpoint is reversible with an
  environment flag.
- CP5: the Rust core becomes the Node app's default; `THAR_CORE=ts` is the
  one-release opt-out, and reverting is the one-line default flip. The WASM
  ships in the npm tarball, so no download or platform matrix is involved.
- CP6: ship `thar-rs` alongside the Ink app and keep it read-only by default.
  The Node package still installs the Ink app.
- CP7–CP8: switch the default only after the release candidate passes the
  parity suite and a one-week dogfood. Publish as `next` first; promote to
  `latest` after a week without data-safety reports.
- Rollback: flip the default back to Ink, keep the last Node release
  installed by pinning the previous version; the Rust binary remains
  available. Never delete the old release tag.

## 12. Rejected options

- **Rust core only, keep Ink forever.** Fixes correctness/portability but not
  the 16–24 ms/frame cost. Accepted only as Phases 1–3.
- **Go full rewrite.** Bubble Tea v2/tview would also remove Ink's cost and is
  faster to write, but Go cannot provide the small WASM core (~1.9 MB
  floor, TinyGo stdlib limits) or a clean in-process Node path (cgo/FFI or
  sidecar). Revisit if the WASM requirement is dropped.
- **Native addon first (napi-rs).** Adds per-platform binaries to the npm
  package in the first step. WASM gets the core into users' hands with no
  build matrix; napi-rs remains a later option if the boundary shows up in
  profiles.
- **Node worker thread for the core.** Adds structured-clone and lifecycle
  complexity without removing the renderer bottleneck.
- **Keep React and swap the Ink renderer.** Not supported; Ink's ANSI
  tokenize/diff is the cost.

## 13. Open decisions

1. **npm packaging:** `optionalDependencies` (esbuild pattern) vs a
   checksummed `postinstall` download. Decide in Phase 7, after binary sizes
   are known.
2. **Date representation:** internal `TodoDate` vs `time::Date`. Recommendation:
   internal strict date type, because only `YYYY-MM-DD` is needed and WASM
   size matters.
3. **ID model:** `u64` from the core vs a TS-side symbol map during CP2–CP5.
   Recommendation: map in the adapter; migrate the UI to numeric IDs at CP6.
4. **Editor widget:** `ratatui-textarea` vs a small custom line editor.
   Recommendation: start with `ratatui-textarea`; replace only if its feature
   set fights the modal UX.
5. **Toolchain policy:** pin 1.99.1 when the first crate lands at CP2; bump on
   a monthly cadence and keep `rust-toolchain.toml` and the CI action in sync.
6. **Post-cutover TypeScript:** keep the TS suite in-tree as a frozen oracle
   for one release, then archive it under `docs/` or delete it. Decide in
   Phase 7.
7. **Browser build:** optional Ratzilla demo after Phase 7; do not let it
   block the native port.
8. **Context collation locale:** `thar-core` implements the en-US ICU order for
   the `[A-Za-z0-9_.-]` context alphabet; the TypeScript oracle calls
   `localeCompare`, whose order depends on the host default locale.
   **Decided at CP3b2b:** the Rust sort stays en-US ICU, and the locale
   assumption is made explicit instead of implicit:
   - the rows harness refuses to run unless the host default collator is
     en-US-equivalent, so `LANG=da_DK.UTF-8` is a readable harness error rather
     than genuine-looking diffs;
   - `THAR_CORE=rust` falls back to TypeScript, with one bounded debug line,
     when the host default collator is not en-US;
   - CI and development run en-US.

   Host-computed collation ranks across the boundary remain a **future option**,
   explicitly deferred with the optimization work (stateful handle, precomputed
   ranks); nothing in CP3b2b changes the Rust comparator. Risk if the guard were
   removed: a developer or user on another locale would see a different context
   order between the TS and Rust paths.

## 14. Definition of done

- All §7 parity items implemented and covered by tests.
- Performance targets in §2 met on released binaries on Linux, macOS and
  Windows.
- Mouse and keyboard interaction parity signed off, including SSH/tmux.
- No data-loss reports during a full release cycle.
- npm, Homebrew and Scoop installs work; self-update is tested.
- The Ink implementation is removed from the default path; the last Node
  release remains available for rollback.

## 15. References

- Ratatui 0.30.2: <https://ratatui.rs/> · mouse backends:
  <https://ratatui.rs/concepts/backends/> · mouse widget example:
  <https://ratatui.rs/examples/widgets/custom_widget>
- `ratatui-textarea`: <https://github.com/ratatui/ratatui-textarea>
- `tui-widgets` / `tui-popup`: <https://github.com/ratatui/tui-widgets>
- `ratatui-interact`: <https://github.com/Brainwires/ratatui-interact>
- Ratzilla: <https://github.com/ratatui/ratzilla>
- wasm-bindgen size guide:
  <https://wasm-bindgen.github.io/wasm-bindgen/reference/optimize-size.html>
- `wasm32-unknown-unknown` target:
  <https://doc.rust-lang.org/rustc/platform-support/wasm32-unknown-unknown.html>
- napi-rs: <https://napi.rs/>
- Go WASM size floor and TinyGo limits:
  <https://go.dev/wiki/WebAssembly> ·
  <https://tinygo.org/docs/guides/webassembly/wasm/>
- Bubble Tea v2 (rejected alternative):
  <https://github.com/charmbracelet/bubbletea/releases>
- Existing update design: [`docs/update-mechanism.md`](../update-mechanism.md)
