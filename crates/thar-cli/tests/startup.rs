//! Startup proof for the binary's non-TTY paths.
//!
//! `Command::output()` gives the child no terminal, so these tests stop before
//! the event loop: they cover the create/load and terminal-setup failure paths.
//! The real interactive session is covered by `tests/pty/main.rs`, which
//! asserts the saved bytes after a PTY run.

mod support;

use support::{TempDir, modified, stderr, thar};

#[test]
fn a_non_tty_startup_leaves_an_existing_file_content_and_mtime_untouched() {
    let dir = TempDir::new("startup-file");
    let path = dir.write("todo.txt", b"one @home\nx 2026-11-01 done\n");
    let before_bytes = std::fs::read(&path).expect("read before");
    let before_mtime = modified(&path);
    let before_entries = dir.entries();

    let output = thar()
        .env("THAR_TUI_PANIC", "1")
        .arg("--file")
        .arg(&path)
        .output()
        .expect("run thar-rs");

    // A TTY run panics via the hook (101); a non-TTY run fails terminal setup
    // (1). Both are non-zero, but the invariant under test is the file: since
    // no edit was made, startup must not rewrite it.
    assert!(!output.status.success());
    assert_eq!(std::fs::read(&path).expect("read after"), before_bytes);
    assert_eq!(modified(&path), before_mtime);
    assert_eq!(dir.entries(), before_entries);
}

#[test]
fn a_run_against_a_directory_does_not_change_the_directory() {
    let dir = TempDir::new("startup-dir");
    dir.write("todo.txt", b"one\n");
    let before_entries = dir.entries();
    let before_mtime = modified(dir.path());

    let output = thar().arg(dir.path()).output().expect("run thar-rs");

    assert_eq!(output.status.code(), Some(1));
    assert!(
        stderr(&output).contains("Cannot read the todo file"),
        "{}",
        stderr(&output)
    );
    assert_eq!(dir.entries(), before_entries);
    assert_eq!(modified(dir.path()), before_mtime);
}

#[test]
fn a_missing_file_is_created_before_terminal_setup() {
    let dir = TempDir::new("startup-missing");
    let path = dir.join("todo.txt");

    let output = thar()
        .env("THAR_TUI_PANIC", "1")
        .arg("--file")
        .arg(&path)
        .output()
        .expect("run thar-rs");

    // The write-by-default startup creates the file even though terminal setup
    // then fails (or the panic hook fires) for this non-TTY child.
    assert!(!output.status.success());
    assert!(
        path.exists(),
        "the binary must create the missing todo file"
    );
    assert_eq!(std::fs::read(&path).expect("read created file"), b"");
}
