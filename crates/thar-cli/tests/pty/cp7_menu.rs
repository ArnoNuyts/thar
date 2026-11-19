//! CP7 menu, confirmation, archive and clipboard PTY coverage.
//!
//! These tests drive the real binary on a real terminal, so the crossterm
//! keymap, the modal host, the debounced save and the files on disk are all
//! exercised end to end. The screenshot generator is `#[ignore]`d like CP6's;
//! run it with:
//!
//! ```sh
//! cargo test -p thar-cli --test pty -- --ignored cp7_menu_screenshot
//! cargo test -p thar-cli --test pty -- --ignored cp7_modal_padding_screenshot
//! ```

use crate::screenshot::{asset_path, rasterize, svg};
use crate::support::TempDir;
use crate::{Session, TIMEOUT};

/// Fixture for the screenshot: priorities, contexts, projects, an overdue due
/// date and one completed row. Dates are far enough in the past that the set
/// does not change when the generator runs on a later day.
const FIXTURE: &str = "\
(A) write the CP7 menu @work +thar due:2026-11-01
buy milk @home
read the rust book @home +learning
(C) review pull request @work due:2026-11-20
x 2026-11-01 ship the release @work +thar
water the plants
call the dentist
";

/// A completed line and an open one, for the archive round trip.
const ARCHIVE_FIXTURE: &str = "\
x 2026-01-01 ship the release @work
buy milk @home
";

#[test]
fn the_menu_opens_and_a_shortcut_toggles_through_it() {
    let directory = TempDir::new("cp7-menu-toggle");
    let path = directory.write("todo.txt", b"one\ntwo\n");
    let mut session = Session::open_write(&path);

    session.wait_text("WRITE");
    session.wait_todo_text("one");

    session.send(b"x");
    session.wait_text("Todo menu");
    session.wait_text("Edit");
    session.wait_text("Toggle Complete");
    session.wait_text("Archive Completed");
    session.wait_text("Paste");

    // `space` is the Toggle Complete shortcut; the menu closes and the todo is
    // serialized as done on the next debounced save.
    session.send(b" ");
    session.wait_no_text("Todo menu");
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
}

#[test]
fn the_empty_list_menu_offers_only_global_commands() {
    let directory = TempDir::new("cp7-menu-empty");
    let path = directory.write("todo.txt", b"");
    let mut session = Session::open_write(&path);

    session.wait_text("WRITE");

    session.send(b"x");
    session.wait_text("Todo menu");
    session.wait_text("Show/Hide Hidden");
    session.wait_text("Archive Completed");
    session.wait_text("Paste");

    let snapshot = session.snapshot();
    for absent in ["Toggle Complete", "Set Due Date", "Modify Projects", "Copy"] {
        assert!(
            !snapshot.text.contains(absent),
            "{absent} must not be offered without a selection:\n{}",
            snapshot.text
        );
    }

    // A todo shortcut is not part of this menu, so it does nothing; the menu
    // stays open and the marker still moves.
    session.send(b" ");
    session.send(b"\x1b[B"); // Down
    session.wait_text("» Archive Completed");

    session.send(b"\x1b");
    session.wait_no_text("Todo menu");
    session.send(b"q");
    assert_eq!(session.wait_exit(TIMEOUT).exit_code(), 0);
    assert_eq!(std::fs::read(&path).expect("read file"), b"");
}

#[test]
fn archive_appends_done_txt_and_removes_the_completed_lines() {
    let directory = TempDir::new("cp7-menu-archive");
    let path = directory.write("todo.txt", ARCHIVE_FIXTURE.as_bytes());
    let mut session = Session::open_write(&path);

    session.wait_text("WRITE");
    session.wait_todo_text("ship the release");

    session.send(b"a");
    session.wait_text("Archive Completed");
    session.wait_text("Archive all completed todos to done.txt?");

    session.send(b"\r");
    session.wait_no_todo_text("ship the release");
    session.wait_todo_text("buy milk");

    session.send(b"q");
    let status = session.wait_exit(TIMEOUT);
    assert_eq!(status.exit_code(), 0);

    let main = std::fs::read_to_string(&path).expect("read todo file");
    assert_eq!(main, "buy milk @home\n");
    let done = directory.join("done.txt");
    let archived = std::fs::read_to_string(&done).expect("read done.txt");
    assert!(
        archived.contains("x 2026-01-01 ship the release @work"),
        "done.txt must gain the completed line: {archived:?}"
    );
}

#[test]
fn delete_asks_first_and_then_removes_the_cursor_todo() {
    let directory = TempDir::new("cp7-menu-delete");
    let path = directory.write("todo.txt", b"one\ntwo\n");
    let mut session = Session::open_write(&path);

    session.wait_text("WRITE");
    session.wait_todo_text("one");

    session.send(b"\x1b[3~"); // Delete
    session.wait_text("Delete Todo");
    session.wait_text("Are you sure you want to delete this todo?");

    session.send(b"\r");
    session.wait_no_todo_text("one");
    session.wait_todo_text("two");

    session.send(b"q");
    let status = session.wait_exit(TIMEOUT);
    assert_eq!(status.exit_code(), 0);
    assert_eq!(
        std::fs::read_to_string(&path).expect("read saved file"),
        "two\n"
    );
}

#[test]
fn a_clipboard_failure_is_one_bounded_toast() {
    let directory = TempDir::new("cp7-menu-clipboard");
    let path = directory.write("todo.txt", b"one\n");
    // An empty PATH has no clipboard tool, so both the copy and the paste
    // fallback lists fail without touching the host clipboard.
    let bin = directory.join("bin");
    std::fs::create_dir(&bin).expect("create empty bin directory");
    let bin = bin.to_string_lossy().into_owned();
    let mut session = Session::open_write_with(&path, &[("PATH", &bin)]);

    session.wait_text("WRITE");
    session.wait_todo_text("one");

    session.send(b"c");
    session.wait_text("Copy failed:");
    session.send(b"v");
    session.wait_text("Paste failed:");

    session.send(b"q");
    let status = session.wait_exit(TIMEOUT);
    assert_eq!(status.exit_code(), 0);
    assert_eq!(std::fs::read(&path).expect("read file"), b"one\n");
}

#[test]
fn a_read_only_run_rejects_the_menu_and_write_keys() {
    let directory = TempDir::new("cp7-menu-readonly");
    let path = directory.write("todo.txt", b"one\n");
    let mut session = Session::open(&path);

    session.wait_text("READ-ONLY");
    for key in [b"x".as_slice(), b"a", b"v"] {
        session.send(key);
        session.wait_text("Read-only: thar-rs cannot modify todo.txt");
    }

    // Copy is non-mutating, so the one gate lets it through even read-only.
    // The host may or may not have a clipboard tool, so accept either toast.
    session.send(b"c");
    session.wait_until("a copy result toast", |snapshot| {
        snapshot.text.contains("Todo copied") || snapshot.text.contains("Copy failed:")
    });
    // Without host update information `u` is a bounded information toast, not
    // a rejection.
    session.send(b"u");
    session.wait_text("No update available");

    session.send(b"q");
    let status = session.wait_exit(TIMEOUT);
    assert_eq!(status.exit_code(), 0);
    assert_eq!(std::fs::read(&path).expect("read file"), b"one\n");
    assert!(!directory.join("done.txt").exists());
}

#[test]
#[ignore = "manual asset generator: regenerates docs/rust-port/assets/cp7-menu.png"]
fn cp7_menu_screenshot() {
    let directory = TempDir::new("cp7-menu-screenshot");
    let path = directory.write("todo.txt", FIXTURE.as_bytes());
    let mut session = Session::open_write(&path);

    session.wait_text("WRITE");
    session.wait_todo_text("write the CP7 menu");

    session.send(b"x");
    session.wait_text("Todo menu");
    session.wait_text("Show/Hide Hidden");

    let image = session.with_screen(svg);
    let svg_path = directory.join("cp7-menu.svg");
    std::fs::write(&svg_path, &image).expect("write the SVG frame");

    let png_path = asset_path("cp7-menu.png");
    std::fs::create_dir_all(png_path.parent().expect("the asset has a directory"))
        .expect("create docs/rust-port/assets");
    rasterize(&svg_path, &png_path);
    println!("wrote {}", png_path.display());

    // Escape closes the menu, then quit so the session flushes and exits.
    session.send(b"\x1b");
    session.wait_no_text("Todo menu");
    session.send(b"q");
    let status = session.wait_exit(TIMEOUT);
    assert_eq!(status.exit_code(), 0);
}

#[test]
fn the_delete_confirmation_at_80x24_uses_the_left_bar_chrome() {
    let directory = TempDir::new("cp7-modal-padding-80");
    let path = directory.write("todo.txt", b"one\ntwo\n");
    let mut session = Session::open_write_sized(&path, 80, 24);

    session.wait_text("WRITE");
    session.wait_todo_text("one");
    session.send(b"\x1b[3~"); // Delete
    session.wait_text("Delete Todo");

    let snapshot = session.snapshot();
    let title = snapshot
        .text
        .lines()
        .find(|line| line.contains("Delete Todo"))
        .unwrap_or_else(|| panic!("no title row:\n{}", snapshot.text));
    assert!(
        title.trim_start_matches(' ').starts_with("┃ Delete Todo"),
        "the title is not a primary chip after the accent bar: {title:?}"
    );
    // The modal rows are the ones carrying the accent bar. A scrollbar `│`
    // elsewhere on the screen is a list glyph, not modal chrome.
    for line in snapshot.text.lines().filter(|line| line.contains('┃')) {
        for glyph in ['│', '┌', '┐', '└', '┘'] {
            assert!(!line.contains(glyph), "box glyph {glyph} in: {line:?}");
        }
    }
    assert!(
        snapshot
            .text
            .lines()
            .any(|line| line.contains("this todo?")),
        "the wrapped message is missing:\n{}",
        snapshot.text
    );

    session.send(b"\x1b");
    session.wait_no_text("Delete Todo");
    session.send(b"q");
    assert_eq!(session.wait_exit(TIMEOUT).exit_code(), 0);
}

#[test]
#[ignore = "manual asset generator: regenerates docs/rust-port/assets/cp7-modal-padding.png"]
fn cp7_modal_padding_screenshot() {
    let directory = TempDir::new("cp7-modal-padding");
    let path = directory.write("todo.txt", FIXTURE.as_bytes());
    let mut session = Session::open_write_sized(&path, 80, 24);

    session.wait_text("WRITE");
    session.wait_todo_text("water the plants");

    // Open the single-todo delete confirmation. Its message is long enough to
    // reach the right edge, which is exactly the padding this asset pins.
    session.send(b"\x1b[3~"); // Delete
    session.wait_text("Delete Todo");
    session.wait_text("Are you sure");

    let image = session.with_screen(svg);
    let svg_path = directory.join("cp7-modal-padding.svg");
    std::fs::write(&svg_path, &image).expect("write the SVG frame");

    let png_path = asset_path("cp7-modal-padding.png");
    std::fs::create_dir_all(png_path.parent().expect("the asset has a directory"))
        .expect("create docs/rust-port/assets");
    rasterize(&svg_path, &png_path);
    println!("wrote {}", png_path.display());

    session.send(b"\x1b"); // close the confirmation
    session.wait_no_text("Delete Todo");
    session.send(b"q");
    assert_eq!(session.wait_exit(TIMEOUT).exit_code(), 0);
}
