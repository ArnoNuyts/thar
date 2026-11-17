//! CP7 data-safety matrix: saves, external edits, reloads and recovery.
//!
//! Everything here runs against the real filesystem in a temporary directory,
//! and every time-dependent assertion uses an explicit [`Instant`] or a
//! condition wait; nothing sleeps for a fixed duration.
//!
//! The matrix mirrors the TypeScript oracle's
//! `unit-tests/todo-file-write-safety.test.ts` and
//! `unit-tests/todo-context-lifecycle.test.tsx`:
//!
//! 1. a read-only directory refuses the save and leaves the target untouched;
//! 2. an external edit between load and save is refused, external bytes intact;
//! 3. an external edit reloads into the new list;
//! 4. a touched-but-unchanged file does not reload (the byte compare runs);
//! 5. a save's own bytes do not reload, and a save inside the window is
//!    suppressed;
//! 6. a failed reload keeps the in-memory list, cancels the pending save and
//!    is not retried until the file changes again;
//! 7. a later successful reload clears the error and re-enables writes;
//! 8. a crash before the rename leaves the previous target bytes in place.

mod support;

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use thar_cli::file::{parse_bytes, read_bytes};
use thar_cli::sync::{
    FileSync, MAX_MESSAGE_CHARS, POLL_INTERVAL, RELOAD_DEBOUNCE, ReloadOutcome, SELF_WRITE_WINDOW,
    bounded_message,
};
use thar_core::{ReadLimits, Todo, TodoDate, TodoId};
use thar_store::{BackupPolicy, SaveGuard, StoreError};
use thar_tui::App;

use support::TempDir;

/// A deterministic list of todos, one per line.
fn todos(lines: &[&str]) -> Vec<Todo> {
    lines
        .iter()
        .enumerate()
        .map(|(index, line)| Todo::parse_line(line, TodoId::new(index as u64)))
        .collect()
}

/// A write-enabled app for the reload tests.
fn app(lines: &[&str]) -> App {
    let mut app = App::new(
        "todo.txt",
        todos(lines),
        "2026-11-15".parse::<TodoDate>().expect("valid date"),
    );
    app.set_read_only(false);
    app
}

/// Poll the watcher on a synthetic clock until it produces an outcome.
///
/// No sleeping: the watcher accepts the instant, so a test can move time
/// forward as fast as the assertions need.
fn poll_until(sync: &mut FileSync, start: Instant) -> Option<ReloadOutcome> {
    let mut now = start;
    for _ in 0..64 {
        if let Some(outcome) = sync.poll(now) {
            return Some(outcome);
        }
        now += POLL_INTERVAL;
    }
    None
}

/// Set a file's modification time without changing its bytes.
fn set_modified(path: &Path, modified: SystemTime) {
    let file = std::fs::OpenOptions::new()
        .write(true)
        .open(path)
        .expect("open for timestamp");
    file.set_times(std::fs::FileTimes::new().set_modified(modified))
        .expect("set modification time");
}

fn entry_names(directory: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(directory)
        .expect("read directory")
        .map(|entry| {
            entry
                .expect("directory entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    names.sort();
    names
}

#[cfg(unix)]
fn set_directory_mode(directory: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(directory, std::fs::Permissions::from_mode(mode))
        .expect("set directory mode");
}

/// True when the mode bits actually prevent writes.
///
/// Root and some container filesystems ignore the directory mode; the test
/// skips instead of reporting a false failure.
#[cfg(unix)]
fn mode_bits_are_enforced(directory: &Path) -> bool {
    let probe = directory.join(".thar-mode-probe");
    match std::fs::write(&probe, b"probe") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            false
        }
        Err(_) => true,
    }
}

#[cfg(unix)]
fn current_time() -> std::time::Instant {
    std::time::Instant::now()
}

#[test]
fn a_read_only_directory_refuses_the_save_and_keeps_the_target() {
    let root = TempDir::new("write-safety-readonly-dir");
    let locked = root.join("locked");
    std::fs::create_dir(&locked).expect("create locked directory");
    let target = locked.join("todo.txt");
    std::fs::write(&target, b"Locked\n").expect("seed target");

    set_directory_mode(&locked, 0o555);
    if !mode_bits_are_enforced(&locked) {
        set_directory_mode(&locked, 0o755);
        return;
    }

    let result = std::panic::catch_unwind(|| {
        let mut guard = SaveGuard::open(&target, BackupPolicy::Bak).expect("guard");
        let error = guard.save(&todos(&["new"])).expect_err("save refused");
        assert!(matches!(error, StoreError::Io { .. }), "{error:?}");

        // The target is byte-identical and nothing new was created, including
        // no backup and no leftover temporary file.
        assert_eq!(std::fs::read(&target).expect("read target"), b"Locked\n");
        assert_eq!(entry_names(&locked), ["todo.txt"]);
        assert_eq!(guard.last_bytes(), b"Locked\n".as_slice());
    });

    set_directory_mode(&locked, 0o755);
    result.expect("the read-only directory assertions");
}

#[test]
fn an_external_edit_between_load_and_save_is_refused() {
    let directory = TempDir::new("write-safety-external-edit");
    let path = directory.write("todo.txt", b"one\n");
    let mut guard = SaveGuard::open(&path, BackupPolicy::None).expect("guard");

    // Another program changes the file after this session loaded it.
    std::fs::write(&path, b"external\nedit from elsewhere\n").expect("external edit");

    let error = guard.save(&todos(&["mine"])).expect_err("save refused");
    assert!(
        matches!(error, StoreError::ChangedOnDisk { .. }),
        "{error:?}"
    );

    // The external bytes are intact and no temp file survived.
    assert_eq!(
        std::fs::read(&path).expect("read target"),
        b"external\nedit from elsewhere\n"
    );
    assert_eq!(entry_names(directory.path()), ["todo.txt"]);
    assert_eq!(guard.last_bytes(), b"one\n".as_slice());
}

#[test]
fn an_external_edit_reloads_into_the_new_list() {
    let directory = TempDir::new("write-safety-reload");
    let path = directory.write("todo.txt", b"one\n");
    let limits = ReadLimits::DEFAULT;

    let start = Instant::now();
    let mut sync = FileSync::new(&path, limits);
    std::fs::write(&path, b"one\ntwo\nexternal\n").expect("external edit");

    // First poll sees the new stamp and arms the debounce; it must not read yet.
    assert!(
        sync.poll(start + POLL_INTERVAL).is_none(),
        "a change must wait for the reload debounce"
    );
    assert!(
        sync.poll(start + POLL_INTERVAL + RELOAD_DEBOUNCE - Duration::from_millis(1))
            .is_none(),
        "the debounce has not elapsed yet"
    );

    let outcome =
        poll_until(&mut sync, start + POLL_INTERVAL + RELOAD_DEBOUNCE).expect("a debounced reload");
    let ReloadOutcome::Changed(bytes) = outcome else {
        panic!("expected changed bytes, got {outcome:?}");
    };
    let reloaded = parse_bytes(&bytes, &limits).expect("parse reloaded bytes");
    assert_eq!(
        reloaded
            .iter()
            .map(|todo| todo.text.as_str())
            .collect::<Vec<_>>(),
        ["one", "two", "external"]
    );

    // The reload is the new baseline: polling again is a no-op.
    sync.adopt(&bytes);
    assert!(poll_until(&mut sync, start + Duration::from_secs(3)).is_none());
}

#[test]
fn a_touched_but_unchanged_file_is_read_once_and_does_not_reload() {
    let directory = TempDir::new("write-safety-touch");
    let path = directory.write("todo.txt", b"one\ntwo\n");
    let start = Instant::now();
    let mut sync = FileSync::new(&path, ReadLimits::DEFAULT);

    // An editor or sync client rewrites the same bytes. The stamp changes, so
    // the watcher must read the file and reject it by content comparison.
    set_modified(&path, SystemTime::now() + Duration::from_secs(60));

    let outcome = poll_until(&mut sync, start + POLL_INTERVAL);
    assert!(
        matches!(outcome, Some(ReloadOutcome::Unchanged)),
        "a touch with identical bytes is an explicit no-op, not a missing event: {outcome:?}"
    );
    assert_eq!(
        sync.content_reads(),
        1,
        "the touch must reach the byte compare, not be skipped by the stamp"
    );
}

#[test]
fn a_save_does_not_reload_its_own_bytes() {
    let directory = TempDir::new("write-safety-self-write");
    let path = directory.write("todo.txt", b"one\n");
    let mut guard = SaveGuard::open(&path, BackupPolicy::None).expect("guard");

    let start = Instant::now();
    let mut sync = FileSync::new(&path, ReadLimits::DEFAULT);
    let saved_at = start + Duration::from_millis(10);

    guard.save(&todos(&["one", "two"])).expect("save");
    sync.note_write(saved_at);
    sync.adopt(guard.last_bytes());

    assert!(
        sync.poll(saved_at + POLL_INTERVAL).is_none(),
        "a save's own rename must not reload"
    );
    assert!(
        poll_until(&mut sync, saved_at + SELF_WRITE_WINDOW).is_none(),
        "the written bytes are the baseline, so the echo is a no-op"
    );
}

#[test]
fn an_external_edit_inside_the_self_write_window_waits() {
    let directory = TempDir::new("write-safety-suppress");
    let path = directory.write("todo.txt", b"one\n");
    let start = Instant::now();
    let mut sync = FileSync::new(&path, ReadLimits::DEFAULT);
    let saved_at = start + Duration::from_millis(10);

    sync.note_write(saved_at);
    std::fs::write(&path, b"external\nedit\n").expect("external edit");

    assert!(
        sync.poll(saved_at + POLL_INTERVAL).is_none(),
        "the change is suppressed inside the self-write window"
    );
    assert!(
        sync.poll(saved_at + SELF_WRITE_WINDOW - Duration::from_millis(1))
            .is_none(),
        "the window has not elapsed yet"
    );

    let outcome = poll_until(&mut sync, saved_at + SELF_WRITE_WINDOW)
        .expect("the external edit reloads after the window");
    assert!(matches!(outcome, ReloadOutcome::Changed(_)), "{outcome:?}");
}

#[test]
fn a_failed_reload_keeps_the_list_cancels_the_save_and_is_not_retried() {
    let directory = TempDir::new("write-safety-failed-reload");
    let path = directory.write("todo.txt", b"Original\n");
    let limits = ReadLimits::DEFAULT;

    let start = Instant::now();
    let mut sync = FileSync::new(&path, limits);
    let mut app = app(&["Original"]);
    app.add_todos(&["Queued".to_owned()], current_time());
    assert!(app.is_dirty(), "the in-memory edit is pending");

    // An external writer poisons the file with a rejected control character.
    std::fs::write(&path, b"RELOAD_POISON\x00\n").expect("poison the file");

    let outcome = poll_until(&mut sync, start + POLL_INTERVAL).expect("a change");
    let ReloadOutcome::Changed(bytes) = outcome else {
        panic!("expected changed bytes, got {outcome:?}");
    };
    let error = parse_bytes(&bytes, &limits).expect_err("the file is rejected");
    app.reload_failed(bounded_message(&error.to_string()));

    // The list survives; the pending save does not; the session stops writing.
    assert_eq!(
        app.todos()
            .iter()
            .map(|todo| todo.text.as_str())
            .collect::<Vec<_>>(),
        ["Original", "Queued"]
    );
    assert!(!app.is_dirty());
    assert!(app.save_timeout(Instant::now()).is_none());
    assert!(!app.writable());
    assert!(app.load_error().is_some());

    // The message is bounded and never carries the poisoned content.
    let message = app.load_error().expect("load error").to_owned();
    assert!(!message.contains('\u{0}'), "{message:?}");
    assert!(!message.contains("RELOAD_POISON"), "{message:?}");
    assert!(message.chars().count() <= MAX_MESSAGE_CHARS + 3);

    // A rejected reload is not retried on a timer: no second attempt until the
    // metadata changes again, so a broken file cannot toast in a loop.
    let reads_after_failure = sync.content_reads();
    assert!(
        poll_until(&mut sync, start + Duration::from_secs(5)).is_none(),
        "a failed reload must not produce a second outcome"
    );
    assert_eq!(sync.content_reads(), reads_after_failure);
}

#[test]
fn a_reload_lossily_decodes_invalid_utf8() {
    // The Node reader uses `String::from_utf8_lossy`, and `file::load` follows
    // it. A reload must not reject a file the startup read would have accepted.
    let directory = TempDir::new("write-safety-lossy");
    let path = directory.write("todo.txt", b"one\n");
    let start = Instant::now();
    let mut sync = FileSync::new(&path, ReadLimits::DEFAULT);

    std::fs::write(&path, b"one\n\xFF\xFE external\n").expect("write invalid UTF-8");
    let outcome = poll_until(&mut sync, start + POLL_INTERVAL).expect("a change");
    let ReloadOutcome::Changed(bytes) = outcome else {
        panic!("expected changed bytes, got {outcome:?}");
    };
    let todos = parse_bytes(&bytes, &ReadLimits::DEFAULT).expect("lossy decode");
    assert_eq!(todos.len(), 2);
    assert!(
        todos[1].text.contains('\u{FFFD}'),
        "invalid UTF-8 becomes U+FFFD: {:?}",
        todos[1].text
    );
}

#[test]
fn a_later_reload_recovers_the_session_and_re_enables_writes() {
    let directory = TempDir::new("write-safety-recovery");
    let path = directory.write("todo.txt", b"Original\n");
    let limits = ReadLimits::DEFAULT;

    let start = Instant::now();
    let mut sync = FileSync::new(&path, limits);
    let mut app = app(&["Original"]);

    // Enter read-only recovery with one undo step outstanding, as a failed
    // reload would after an unsaved edit.
    let _ = app.add_todos(&["Unsaved".to_owned()], current_time());
    assert_eq!(app.history().undo_len(), 1);
    app.reload_failed("Cannot read the todo file: rejected");
    assert!(!app.writable());

    // Fixing the file externally must be seen once the quiet period ends.
    std::fs::write(&path, b"Recovered\nsecond\n").expect("fix the file");
    let outcome = poll_until(&mut sync, start + POLL_INTERVAL).expect("a change");
    let ReloadOutcome::Changed(bytes) = outcome else {
        panic!("expected changed bytes, got {outcome:?}");
    };
    let reloaded = parse_bytes(&bytes, &limits).expect("parse the fixed file");
    app.reloaded(reloaded);
    sync.adopt(&bytes);

    assert!(app.load_error().is_none());
    assert!(app.writable(), "recovery must re-enable writes");
    assert_eq!(app.todos().len(), 2);
    assert_eq!(
        app.history().undo_len(),
        0,
        "a reload clears the undo history"
    );
    assert!(
        !app.undo(current_time()),
        "nothing is left to undo after a reload"
    );

    // Saving works again and the guard accepts the reloaded baseline.
    let mut guard = SaveGuard::open(&path, BackupPolicy::None).expect("guard");
    guard.set_baseline(bytes);
    app.add_todos(&["Persisted".to_owned()], current_time());
    assert!(app.is_dirty());
    guard.save(app.todos()).expect("save after recovery");
    let saved = std::fs::read_to_string(&path).expect("read saved");
    // New todos are stamped with the session's creation date, matching the Ink
    // app, so assert the rows rather than a hand-written byte string.
    assert!(saved.starts_with("Recovered\nsecond\n"), "{saved:?}");
    assert!(saved.contains("Persisted"), "{saved:?}");
}

#[test]
fn a_missing_file_is_a_reload_error_not_an_empty_list() {
    let directory = TempDir::new("write-safety-missing");
    let path: PathBuf = directory.join("todo.txt");
    let error = read_bytes(&path, &ReadLimits::DEFAULT).expect_err("missing file");
    assert!(matches!(error, thar_cli::LoadError::Io(_)), "{error:?}");
}

#[test]
#[ignore = "helper process: spawned by crash_before_rename_leaves_the_previous_target"]
fn crash_before_rename_child() {
    let target = std::env::var_os("THAR_CRASH_TARGET").expect("THAR_CRASH_TARGET is set");
    thar_store::write_atomic(Path::new(&target), b"new\n").expect("write");
}

/// A crash between the temp-file flush and the rename must leave the old file.
///
/// The child is this same test binary, rerun for the ignored helper above with
/// `THAR_SAVE_CRASH=before-rename`; it aborts inside `thar_store::atomic`. The
/// hook is compiled out of release builds, so the test is skipped when the
/// profile has no debug assertions.
#[test]
fn crash_before_rename_leaves_the_previous_target() {
    if !cfg!(debug_assertions) {
        return;
    }

    let directory = TempDir::new("write-safety-crash");
    let target = directory.write("todo.txt", b"old\n");

    let status = std::process::Command::new(std::env::current_exe().expect("test binary"))
        .args(["--ignored", "--exact", "crash_before_rename_child"])
        .current_dir(directory.path())
        .env("THAR_SAVE_CRASH", "before-rename")
        .env("THAR_CRASH_TARGET", &target)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .expect("run the crash child");
    // The hook exits with the TypeScript oracle's status before the rename.
    assert_eq!(
        status.code(),
        Some(9),
        "the child must stop before the rename"
    );

    // Old or new, never partial or empty: the rename never ran, so it is old.
    assert_eq!(std::fs::read(&target).expect("read target"), b"old\n");

    // The fully written temporary file is inert. It is never renamed into
    // place, and the next save writes a fresh one.
    let temporaries: Vec<String> = entry_names(directory.path())
        .into_iter()
        .filter(|name| name.ends_with(".tmp"))
        .collect();
    assert_eq!(temporaries.len(), 1, "{temporaries:?}");

    thar_store::write_atomic(&target, b"after\n").expect("next save");
    assert_eq!(std::fs::read(&target).expect("read target"), b"after\n");
}
