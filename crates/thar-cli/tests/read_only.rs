//! End-to-end read-only proof for the built binary.
//!
//! A successful load reaches the TUI, so the child is stopped with the test-only
//! `THAR_TUI_PANIC=1` trigger (or by the terminal setup failure when the test
//! runs without a TTY). Either way the process exits without any code path that
//! can write, and the file/directory must be byte- and mtime-identical.

mod support;

use support::{TempDir, modified, stderr, thar};

#[test]
fn a_tui_run_leaves_the_file_content_and_mtime_untouched() {
    let dir = TempDir::new("read-only-file");
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
    // (1). Both are non-zero, but the invariant under test is the file.
    assert!(!output.status.success());
    assert_eq!(std::fs::read(&path).expect("read after"), before_bytes);
    assert_eq!(modified(&path), before_mtime);
    assert_eq!(dir.entries(), before_entries);
}

#[test]
fn a_run_against_a_directory_does_not_change_the_directory() {
    let dir = TempDir::new("read-only-dir");
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
fn a_missing_file_is_not_created_by_the_binary() {
    let dir = TempDir::new("read-only-missing");
    let path = dir.join("todo.txt");

    let output = thar()
        .env("THAR_TUI_PANIC", "1")
        .arg("--file")
        .arg(&path)
        .output()
        .expect("run thar-rs");

    assert!(!output.status.success());
    assert!(!path.exists());
    assert!(dir.entries().is_empty());
}
