//! CP7 write-path PTY coverage.
//!
//! These tests drive the real binary through a real terminal in its default
//! mode: a toggle key, the debounced save, undo, and the one-session backup.
//! They read the file after the process exits, so they prove the bytes on disk
//! rather than the in-memory state.
//!
//! The screenshot generator is `#[ignore]`d like CP6's; run it with
//! `cargo test -p thar-cli --test pty -- --ignored cp7_write_screenshot`.

use std::path::Path;

use crate::screenshot::{asset_path, rasterize, svg};
use crate::support::TempDir;
use crate::{Session, TIMEOUT};

/// Fixture for the screenshot: a few contexts, a project, a priority, an
/// overdue due date and one completed row.
const FIXTURE: &str = "\
(A) write the CP7 foundation @work +thar due:2026-11-01
buy milk @home
read the rust book @home +learning
(C) review pull request @work due:2026-11-20
water the plants
call the dentist
";

fn wait_for_file(path: &Path, needle: &str) {
    // The process exits only after the pending save is flushed, so the file is
    // final before this helper runs. The loop is for a slow filesystem, not a
    // fixed sleep.
    let deadline = std::time::Instant::now() + TIMEOUT;
    loop {
        if let Ok(text) = std::fs::read_to_string(path)
            && text.contains(needle)
        {
            return;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "{} never contained {needle:?}",
            path.display()
        );
        std::thread::yield_now();
    }
}

#[test]
fn the_default_session_toggles_saves_and_keeps_a_backup() {
    let directory = TempDir::new("cp7-write-toggle");
    let path = directory.write("todo.txt", b"one\ntwo\n");
    let mut session = Session::open(&path);

    session.wait_todo_text("one");
    session.send(b" ");
    session.wait_text("[x]");

    session.send(b"q");
    let status = session.wait_exit(TIMEOUT);
    assert_eq!(status.exit_code(), 0);

    let saved = std::fs::read_to_string(&path).expect("read saved file");
    assert!(
        saved.starts_with("x "),
        "completion must be serialized: {saved:?}"
    );
    assert!(saved.contains("one"));
    assert!(saved.contains("two"));

    let backup = directory.join("todo.txt.bak");
    wait_for_file(&backup, "one");
    assert_eq!(std::fs::read(&backup).expect("backup bytes"), b"one\ntwo\n");
}

#[test]
fn undo_restores_the_original_bytes() {
    let directory = TempDir::new("cp7-write-undo");
    let path = directory.write("todo.txt", b"one\n");
    let mut session = Session::open(&path);

    session.wait_todo_text("one");
    session.send(b" ");
    session.wait_text("[x]");
    session.send(b"z");
    session.wait_no_text("[x]");

    session.send(b"q");
    let status = session.wait_exit(TIMEOUT);
    assert_eq!(status.exit_code(), 0);
    assert_eq!(
        std::fs::read_to_string(&path).expect("read saved file"),
        "one\n"
    );
}

#[test]
#[ignore = "manual asset generator: regenerates docs/rust-port/assets/cp7-write.png"]
fn cp7_write_screenshot() {
    let directory = TempDir::new("cp7-write-screenshot");
    let path = directory.write("todo.txt", FIXTURE.as_bytes());
    let mut session = Session::open(&path);

    session.wait_todo_text("write the CP7 foundation");
    session.send(b" ");
    session.wait_text("[x]");

    let image = session.with_screen(svg);
    let svg_path = directory.join("cp7-write.svg");
    std::fs::write(&svg_path, &image).expect("write the SVG frame");

    let png_path = asset_path("cp7-write.png");
    std::fs::create_dir_all(png_path.parent().expect("the asset has a directory"))
        .expect("create docs/rust-port/assets");
    rasterize(&svg_path, &png_path);
    println!("wrote {}", png_path.display());

    session.send(b"q");
    let status = session.wait_exit(TIMEOUT);
    assert_eq!(status.exit_code(), 0);
}
