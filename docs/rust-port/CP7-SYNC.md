# CP7 — file sync, reloads and read-only recovery

Status: implemented on `rust-port/cp7-sync`, based on
`rust-port/cp7-foundation`.

This workstream adds the missing half of CP7's data-safety story: while
`thar-rs --write` runs, an external edit to the todo file is noticed, debounced,
re-read and applied, and a file that becomes unreadable puts the session into
the same read-only recovery state as the Ink app. No new dependency, no
filesystem or process I/O in `thar-tui`, and the shipped atomic-replace path is
unchanged.

## What landed

| Area         | Change                                                                                                                                                                                                                                                      |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Watcher      | New `crates/thar-cli/src/sync.rs` with `FileSync`, `ReloadOutcome`, `bounded_message` and the poll/debounce/suppression constants. std only (`fs::metadata`, `fs::File`).                                                                                   |
| Event loop   | `terminal::run_with_store` owns one `FileSync`, extends the `event::poll` timeout with the watcher deadline, and calls `apply_reload` after every event or timeout.                                                                                         |
| Reload       | Reads the bytes once, lossy-decodes and parses with the startup `ReadLimits`, calls `App::reloaded` (which calls `set_todos`, clearing the undo history), adopts the parsed bytes as the watcher baseline (the save guard's `expected` bytes), and toasts `File reloaded`. |
| Failure      | Sets `app.load_error`, toasts the bounded message, cancels a pending save, and shows `READ-ONLY` until a later reload succeeds.                                                                                                                             |
| Recovery     | `App::reloaded` clears `load_error`, so `App::writable()` is true again and the next mutation saves. When the file returns with the already-accepted bytes, the host re-parses `FileSync::baseline()` and calls `App::reloaded`, so unsaved edits are not reported as saved. |                                                                                                                                                        |
| Save refusal | `StoreError::ChangedOnDisk` keeps the target untouched, shows one bounded toast, keeps the list dirty and retries with the app's 1 s backoff; the watcher normally reloads the external file first, which clears the dirty state.                           |
| Store        | `FileSync` owns the baseline; `SaveGuard::save(todos, expected)` compares against it and returns the written bytes; `atomic::write_atomic` gained a debug-only `THAR_SAVE_CRASH=before-rename` abort hook.                                                                                                         |
| Tests        | `crates/thar-cli/tests/write_safety.rs` (11 passing + 1 helper) and `crates/thar-cli/tests/pty/cp7_sync.rs` (5 passing + 1 ignored generator).                                                                                                              |
| Asset        | `docs/rust-port/assets/cp7-sync.png` from a real 100×30 PTY frame.                                                                                                                                                                                          |

## Policy

### Poll, debounce, suppress, compare

Constants in `thar-cli::sync`, chosen to match
`hooks/useTodoFileSync.ts`:

| Constant            | Value  | Meaning                                                                                                     |
| ------------------- | ------ | ----------------------------------------------------------------------------------------------------------- |
| `POLL_INTERVAL`     | 250 ms | Metadata is checked at most four times a second while idle.                                                 |
| `RELOAD_DEBOUNCE`   | 500 ms | Quiet period from the last metadata change before the file is read. A second change restarts it.            |
| `SELF_WRITE_WINDOW` | 1 s    | Reloads are suppressed this long after a successful save, matching the hook's `lastWriteTime < 1000` guard. |
| `MAX_MESSAGE_CHARS` | 300    | Same bound as `MAX_DISPLAY_ERROR_CHARS` in `logic/display-safety.ts`.                                       |

The watcher compares `(mtime, length)` against the last observed stamp. When a
stamp changes it arms the debounce; when the debounce expires it reads the file
and compares the **bytes** with the last accepted content. A touch (mtime
changes, bytes do not) therefore costs one read and produces no reload. The
number of content reads is exposed as `FileSync::content_reads()` so a test can
prove the byte compare ran instead of the change being missed.

A missing file is a change too: the reload reports an unreadable file instead of
creating an empty one, so an external delete is never silently turned into an
empty todo list.

### Event-loop ordering

Each iteration, in order:

1. expire the toast, and flush a due save;
2. draw;
3. wait for an event with the minimum of the toast expiry, save debounce,
   watcher deadline, and next local midnight;
4. apply the event;
5. poll the watcher, and apply a reload or a recovery failure;
6. run host effects, then re-derive the local day.

A save that is due at the same moment as a reload wins the ordering: the
`SaveGuard` refuses it with `ChangedOnDisk` (the external bytes stay), and the
reload then replaces the list. A reload that lands while a save is **pending**
(not yet due) drops the in-memory edit, because the external file is the source
of truth. `App::reloaded` cancels the pending save by construction.

### External-edit refusal

When a save fails with `StoreError::ChangedOnDisk`:

- the target is not written (`SaveGuard::save` compares the current bytes with
  its baseline and returns before serializing to disk);
- the action bar shows one bounded `Save failed: … changed on disk …` toast and
  `App::save_error` records it;
- the list stays dirty and the app retries after its 1 s backoff; the watcher
  normally reloads the external file first, which clears the dirty state and
  rebaselines both the guard and the watcher;
- the watcher notices the same metadata change independently and, after the
  debounce, reloads the external file.

The next user mutation schedules a new save. Nothing is merged: the external
file wins, and the in-memory edit that was refused is discarded by the reload.
This mirrors the Ink hook, which also replaces state on reload and only toasts
a write rejection.

### Read-only recovery

The `--write` flag and the recovery state are separate:

- `App::read_only` is set once from `--write`;
- `App::load_error` is the recovery state;
- `App::writable()` is `!read_only && load_error.is_none()`.

A failed reload (unreadable file, or bytes that fail validation) sets
`load_error`, cancels the pending save and toasts the bounded message. The badge
switches to `READ-ONLY` and mutations are applied in memory only, with the
existing `Not saved: read-only` toast; archive is blocked for the same reason
(it writes `done.txt`). A later successful reload clears `load_error`, restores
the `WRITE` badge and persists the next mutation.

### Bounds

Every failure message goes through `bounded_message`, which sanitizes control
characters (`logic/display-safety.ts` escapes them as `\uXXXX`), trims, maps an
empty message to `Unknown error`, and truncates at 300 characters. The action
bar additionally clips the toast to the free width, so a long path cannot push
the badge or the action items off screen.

## Data-safety matrix

The TypeScript oracle names the case; the Rust test proves it on the real
filesystem. No test uses a fixed sleep: every watcher assertion passes an
explicit `Instant` to `FileSync::poll`, and the PTY tests poll the parsed screen.

| Case                                                                   | Rust evidence                                                                                                                                                        |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read-only directory: save fails, target untouched, no temp/backup left | `write_safety::a_read_only_directory_refuses_the_save_and_keeps_the_target`, `pty::cp7_sync::a_read_only_directory_shows_a_bounded_save_failure_and_keeps_the_bytes` |
| External edit between load and save: refused, external bytes intact    | `write_safety::an_external_edit_between_load_and_save_is_refused`                                                                                                    |
| External edit: reloads into the new list                               | `write_safety::an_external_edit_reloads_into_the_new_list`, `pty::cp7_sync::an_external_edit_reloads_and_toasts`                                                     |
| Reload replaces instead of merging, and quitting writes nothing        | `pty::cp7_sync::an_external_edit_replaces_the_list_instead_of_merging`                                                                                               |
| Touched-but-unchanged file: one read, `Unchanged`, no reload           | `write_safety::a_touched_but_unchanged_file_is_read_once_and_does_not_reload`                                                                                        |
| Restoring the original bytes clears recovery                           | `pty::cp7_sync::restoring_the_original_bytes_clears_read_only_recovery`                                                                                              |
| Self-write echo: no reload; an edit inside the window waits            | `write_safety::a_save_does_not_reload_its_own_bytes`, `write_safety::an_external_edit_inside_the_self_write_window_waits`                                            |
| Failed reload keeps the list, cancels the save, is not retried         | `write_safety::a_failed_reload_keeps_the_list_cancels_the_save_and_is_not_retried`, `pty::cp7_sync::a_failed_reload_enters_read_only_recovery_and_a_fix_recovers`    |
| Recovery clears read-only and re-enables writes                        | `write_safety::a_later_reload_recovers_the_session_and_re_enables_writes`, same PTY test                                                                             |
| Missing file is a reload error, not an empty list                      | `write_safety::a_missing_file_is_a_reload_error_not_an_empty_list`                                                                                                   |
| Reload uses the reader's lossy UTF-8 decode                            | `write_safety::a_reload_lossily_decodes_invalid_utf8`                                                                                                                |
| Crash before the rename leaves the old target                          | `write_safety::crash_before_rename_leaves_the_previous_target`                                                                                                       |

### Crash hook

`thar_store::atomic::write_atomic` stops the process between the temp-file
flush and the rename when `THAR_SAVE_CRASH=before-rename` is set **and** the
build has debug assertions. It exits with status 9, the same signal-free crash
the TypeScript hook produces with `process.exit(9)`, so no core dump is written.
The crash test spawns this same test binary for the `crash_before_rename_child`
helper with that environment and a temporary working directory, then asserts:

- the child exits with status 9;
- the target still holds the old bytes (never a partial file);
- exactly one fully written `.tmp` sibling is left behind, inert because it is
  never renamed into place;
- the next `write_atomic` call succeeds normally.

Release builds ignore the variable, so the shipped path is unchanged.

## Evidence

Gates, all run in this worktree:

```sh
cargo fmt --all --check
cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
cargo test --locked --workspace --all-features
```

Results: fmt clean, clippy clean, workspace tests green. New coverage:
`thar-cli` unit 15, `tests/write_safety.rs` 11 passed + 1 ignored helper,
`tests/pty` 17 passed + 3 ignored generators, plus every pre-existing CP6/CP7
suite.

The screenshot generator, rerun from the repository root:

```sh
cargo test -p thar-cli --test pty -- --ignored cp7_sync_screenshot
```

produced `docs/rust-port/assets/cp7-sync.png` from the real binary: the list has
an externally added `ship the CP7 sync @work +thar` row, the badge reads
`WRITE`, and the action bar shows the `File reloaded` toast.

## Deliberate gaps and deviations

- **Polling, not inotify.** std has no cross-platform file-event API, and CP7
  forbids new dependencies. The cost is one `metadata` call every 250 ms while
  the TUI is open; no content is read unless a stamp changes.
- **Coarse timestamp granularity.** A same-length external edit on a filesystem
  whose mtime resolution is one second (and inside the same second as the last
  observed write) can be missed. The byte compare cannot help because no change
  is detected. Modern Linux (ext4, btrfs, xfs), APFS and NTFS report
  sub-second times. A manual refresh command is a possible later addition.
- **Startup handoff window.** `FileSync::new` reads the baseline a few
  milliseconds after the initial load. An edit in that window is treated as the
  starting content. The Ink hook has the same window between `repository.load`
  and its first watcher event.
- **A write session whose initial read _fails validation_ still exits** with a
  message before the TUI starts (CP6 behaviour, unchanged here). The recovery
  path covers a file that becomes invalid, unreadable or deleted after startup,
  which is what the Ink lifecycle tests exercise after the first load.
- **No reload retry timer.** A failed reload is only retried after the metadata
  changes again. That keeps a rejected file from toasting in a loop. The
  trade-off is that fixing only the permission bits (which does not change mtime
  or length) is not noticed until the file is written or touched; restoring
  the exact accepted bytes does recover (the watcher reports `Unchanged`).
- **No OS-level file lock.** `SaveGuard` compares the bytes and then renames;
  a writer that lands between the compare and the rename still loses. It is
  strictly stronger than the Ink app, which does not compare at all, but it is
  not a multi-writer lock.
- **No stale-temp cleanup.** A crash between flush and rename leaves a
  `.todo.txt.<pid>.<n>.tmp` sibling, as the TypeScript suite also accepts. It is
  never renamed into place; the next save writes a fresh temp file.
- **Archive is refused during recovery.** The guard was added here because a
  failed reload can now produce the recovery state while the store is present;
  it writes `done.txt` only when `App::writable()`.
