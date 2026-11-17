# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `thar-rs`: a read-only ratatui TUI shipped as a separate binary, with list
  navigation, context headers, search, the hidden-todo view, a scrollbar,
  mouse wheel/click/shift-click/double-click and terminal restore on panic.
  It links no writer and never creates a todo file; `thar` still starts the Ink
  app.
- Prebuilt `thar-rs` release archives for Linux (x64/arm64), macOS (x64/arm64)
  and Windows (x64), each with a `.sha256` checksum.

### Changed

- The Rust todo core is now the default: parsing, list building and the
  byte-compared write path run through the shipped WebAssembly core, with
  `THAR_CORE=ts` as the one-release escape hatch.

## [0.6.1] - 2026-11-14

### Changed

- Modal dialogs now use a slightly lighter background than the todo list, so
  they stand out from the content behind them.
- Unselected modal button labels use a brighter muted tone so they stay legible
  on the new dialog background.
- Enable React lint rules in Oxlint, add a rule that requires date-fns for
  calendar math, and gate pull requests on React Doctor findings.

## [0.6.0] - 2026-11-13

### Added

- Non-blocking update checks against the npm registry, with a footer badge
  when a newer version is available, a one-time notice per version, and a modal
  to skip that version or update on exit.
- `thar update [--check] [--yes]`, plus `-v`/`--version` and
  `--no-update-check` CLI flags.
- Type declaration file for the package entry point, so the published package
  reports its types to editors and npm.
- Navigation benchmark (`npm run bench:list`) for measuring list keypress
  latency, React render work, and Ink output cost.

### Changed

- Publish with provenance by default via `publishConfig.provenance`, so a
  release can no longer drop its SLSA attestation.
- Improve list navigation responsiveness: rows and the scrollbar are memoized,
  navigation bookkeeping avoids full-list scans on every keypress, and Ink's
  render throttle is raised from its 30 fps default so keypresses are not held
  for a frame window.

### Fixed

- Date-dependent state such as due and overdue markers now refreshes at
  midnight instead of only at startup.

## [0.5.0] - 2026-11-12

First public release.

### Added

- Keyboard-driven todo.txt TUI with projects, contexts, priorities, due dates,
  threshold dates, recurrence, and hidden todos.
- Search with project/context autocomplete, multi-select, mouse support, and a
  command menu.
- Undo/redo, copy/paste, archive to `done.txt`, and external file watching.
- npm package for Node.js 22.12 and newer.

[Unreleased]: https://github.com/ArnoNuyts/thar/compare/v0.6.1...HEAD
[0.6.1]: https://github.com/ArnoNuyts/thar/releases/tag/v0.6.1
[0.6.0]: https://github.com/ArnoNuyts/thar/releases/tag/v0.6.0
[0.5.0]: https://github.com/ArnoNuyts/thar/releases/tag/v0.5.0
