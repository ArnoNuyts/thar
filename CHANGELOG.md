# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

## [0.5.0] - 2026-11-12

First public release.

### Added

- Keyboard-driven todo.txt TUI with projects, contexts, priorities, due dates,
  threshold dates, recurrence, and hidden todos.
- Search with project/context autocomplete, multi-select, mouse support, and a
  command menu.
- Undo/redo, copy/paste, archive to `done.txt`, and external file watching.
- npm package for Node.js 22.12 and newer.

[Unreleased]: https://github.com/ArnoNuyts/thar/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/ArnoNuyts/thar/releases/tag/v0.5.0
