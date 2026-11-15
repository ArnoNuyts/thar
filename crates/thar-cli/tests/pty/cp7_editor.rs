//! CP7 editor PTY coverage.
//!
//! The create modal is driven through a real terminal: `n` opens it, the typed
//! text, the live suggestion list, `Enter` to apply a suggestion, `Enter` to
//! submit and `q` to flush the debounced save. The assertion reads the file
//! after the process exits, so it proves the bytes on disk.
//!
//! The screenshot generator is `#[ignore]`d like the CP6/CP7 ones; run it with
//! `cargo test -p thar-cli --test pty -- --ignored cp7_editor_screenshot`.

use crate::Session;
use crate::TIMEOUT;
use crate::screenshot::{asset_path, rasterize, svg};
use crate::support::TempDir;

/// Fixture for the editor tests: two projects (one a prefix of the other) and
/// two contexts, so a `+th` word lists both suggestion rows.
const FIXTURE: &str = "\
buy milk @home
write the port @work +thar
read the plan @home +thar-tui
water the plants
";

const ENTER: &[u8] = b"\r";
const ESC: &[u8] = b"\x1b";

#[test]
fn the_create_modal_types_applies_a_suggestion_and_saves() {
    let directory = TempDir::new("cp7-editor-create");
    let path = directory.write("todo.txt", FIXTURE.as_bytes());
    let mut session = Session::open_write(&path);

    session.wait_text("WRITE");
    session.wait_todo_text("water the plants");

    // `n` opens the create screen with the input focused.
    session.send(b"n");
    session.wait_text("Create new todo");

    // Typing `+th` opens the suggestion list with both projects. The waits
    // target the modal's own rows: `+thar-tui` also appears in the list behind
    // the modal, so it would race with the capture.
    session.send(b"write the port +th");
    session.wait_text("» write the port +th");
    session.wait_text("│  +thar");

    // The first `Enter` applies the highlighted suggestion, not the form.
    session.send(ENTER);
    session.wait_text("» write the port +thar");

    // The second `Enter` submits; the screen closes.
    session.send(ENTER);
    session.wait_no_text("Create new todo");

    // The new todo is in the list with `@work` untouched and the project
    // appended by the suggestion.
    session.wait_todo_text("write the port +thar");
    assert!(
        session.snapshot().text.contains("write the port +thar"),
        "the new todo is missing from the list:\n{}",
        session.snapshot().text
    );

    session.send(b"q");
    let status = session.wait_exit(TIMEOUT);
    assert_eq!(status.exit_code(), 0);

    let saved = std::fs::read_to_string(&path).expect("read saved file");
    assert!(
        saved.contains("write the port +thar"),
        "the create modal did not save the todo: {saved:?}"
    );
    assert_eq!(
        saved.lines().count(),
        FIXTURE.lines().count() + 1,
        "exactly one todo was added: {saved:?}"
    );
    // Existing lines are unchanged.
    assert!(saved.contains("buy milk @home"));
    assert!(saved.contains("read the plan @home +thar-tui"));
}

#[test]
fn escape_closes_the_create_modal_without_adding_anything() {
    let directory = TempDir::new("cp7-editor-cancel");
    let path = directory.write("todo.txt", FIXTURE.as_bytes());
    let mut session = Session::open_write(&path);

    session.wait_text("WRITE");
    session.send(b"n");
    session.wait_text("Create new todo");
    session.send(b"half typed");
    session.send(ESC);

    // The Escape only closes the screen, and the timed save has nothing to
    // flush; `q` exits.
    session.wait_no_text("Create new todo");
    session.send(b"q");
    let status = session.wait_exit(TIMEOUT);
    assert_eq!(status.exit_code(), 0);

    assert_eq!(
        std::fs::read_to_string(&path).expect("read saved file"),
        FIXTURE,
        "a cancelled create must leave the file byte-identical"
    );
}

#[test]
#[ignore = "manual asset generator: regenerates docs/rust-port/assets/cp7-editor.png"]
fn cp7_editor_screenshot() {
    let directory = TempDir::new("cp7-editor-screenshot");
    let path = directory.write("todo.txt", FIXTURE.as_bytes());
    let mut session = Session::open_write(&path);

    session.wait_text("WRITE");
    session.wait_todo_text("water the plants");

    // Open the create screen and type a tag word so the suggestion list is
    // visible in the captured frame.
    session.send(b"n");
    session.wait_text("Create new todo");
    session.send(b"buy oat milk for the week +th");
    session.wait_text("» buy oat milk for the week +th");
    session.wait_text("│  +thar");

    let image = session.with_screen(svg);
    let svg_path = directory.join("cp7-editor.svg");
    std::fs::write(&svg_path, &image).expect("write the SVG frame");

    let png_path = asset_path("cp7-editor.png");
    std::fs::create_dir_all(png_path.parent().expect("the asset has a directory"))
        .expect("create docs/rust-port/assets");
    rasterize(&svg_path, &png_path);
    println!("wrote {}", png_path.display());

    // The screen owns the keyboard: the first Escape clears the suggestion
    // list, the second closes the screen, then `q` quits. The wait between the
    // two keeps crossterm from folding both bytes into one key event.
    session.send(ESC);
    session.wait_no_text("│  +thar");
    session.send(ESC);
    session.wait_no_text("Create new todo");
    session.send(b"q");
    let status = session.wait_exit(TIMEOUT);
    assert_eq!(status.exit_code(), 0);
}
