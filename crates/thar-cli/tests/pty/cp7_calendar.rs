//! CP7 date-screen PTY coverage.
//!
//! The non-ignored test drives the real binary through the whole date flow:
//! `--write`, `d`, the Custom row, the calendar, a day move, Enter, and the
//! saved file. The fixture todo already has a fixed `due:` date, so the
//! calendar starts on a deterministic day instead of today.
//!
//! The `#[ignore]`d test is the manual asset generator for
//! `docs/rust-port/assets/cp7-calendar.png`; run it with
//! `cargo test -p thar-cli --test pty -- --ignored cp7_calendar_screenshot`.

use crate::screenshot::{asset_path, rasterize, svg};
use crate::support::TempDir;
use crate::{Session, TIMEOUT};

const FIXTURE: &str = "\
(A) write the CP7 calendar +thar due:2024-05-06
buy milk @home
read the rust book @home +learning
(C) review pull request @work due:2024-05-20
water the plants
call the dentist
";

const DOWN: &[u8] = b"\x1b[B";
const RIGHT: &[u8] = b"\x1b[C";
const ENTER: &[u8] = b"\r";

/// Drive the modal to the custom calendar and move one day right.
fn open_calendar_and_move(session: &mut Session) {
    session.wait_text("WRITE");
    session.wait_todo_text("write the CP7 calendar");
    session.send(b"d");
    session.wait_text("Set Due Date");

    // Custom is the fifth row (Today, Tomorrow, Next Week, Next Month, Custom).
    for _ in 0..4 {
        session.send(DOWN);
    }
    session.wait_text("» Custom");
    session.send(ENTER);
    session.wait_text("Selected: 2024-05-06");

    // Right is one day; the list step is gone but the calendar owns the keys.
    session.send(RIGHT);
    session.wait_text("Selected: 2024-05-07");
}

#[test]
fn choosing_a_custom_due_date_saves_the_new_day() {
    let directory = TempDir::new("cp7-calendar");
    let path = directory.write("todo.txt", FIXTURE.as_bytes());
    let mut session = Session::open_write(&path);

    open_calendar_and_move(&mut session);
    session.send(ENTER);
    // The modal closes and the list repaints with the saved tag.
    session.wait_no_text("Set Due Date");
    session.wait_todo_text("due:2024-05-07");

    session.send(b"q");
    let status = session.wait_exit(TIMEOUT);
    assert_eq!(status.exit_code(), 0);

    let saved = std::fs::read_to_string(&path).expect("read saved file");
    assert!(
        saved.contains("due:2024-05-07"),
        "the calendar day must be saved: {saved:?}"
    );
    assert!(
        !saved.contains("due:2024-05-06"),
        "the old due date must be replaced: {saved:?}"
    );
    // The other rows are untouched.
    assert!(saved.contains("(A) write the CP7 calendar"), "{saved:?}");
    assert!(saved.contains("water the plants"), "{saved:?}");
}

#[test]
fn escape_from_the_calendar_returns_to_the_list_step() {
    let directory = TempDir::new("cp7-calendar-escape");
    let path = directory.write("todo.txt", FIXTURE.as_bytes());
    let mut session = Session::open_write(&path);

    open_calendar_and_move(&mut session);
    // Escape leaves the calendar, not the modal; the Custom row stays selected.
    session.send(b"\x1b");
    session.wait_no_text("Selected: 2024-05-07");
    session.wait_text("» Custom");
    session.send(b"\x1b");
    session.wait_no_text("Set Due Date");

    session.send(b"q");
    let status = session.wait_exit(TIMEOUT);
    assert_eq!(status.exit_code(), 0);
    assert_eq!(
        std::fs::read(&path).expect("read the file"),
        FIXTURE.as_bytes(),
        "escaping both steps must not write a date"
    );
}

#[test]
#[ignore = "manual asset generator: regenerates docs/rust-port/assets/cp7-calendar.png"]
fn cp7_calendar_screenshot() {
    let directory = TempDir::new("cp7-calendar-screenshot");
    let path = directory.write("todo.txt", FIXTURE.as_bytes());
    let mut session = Session::open_write(&path);

    open_calendar_and_move(&mut session);

    let image = session.with_screen(svg);
    let svg_path = directory.join("cp7-calendar.svg");
    std::fs::write(&svg_path, &image).expect("write the SVG frame");

    let png_path = asset_path("cp7-calendar.png");
    std::fs::create_dir_all(png_path.parent().expect("the asset has a directory"))
        .expect("create docs/rust-port/assets");
    rasterize(&svg_path, &png_path);
    println!("wrote {}", png_path.display());

    // Leave the calendar step, close the modal, then quit.
    session.send(b"\x1b");
    session.wait_no_text("Selected: 2024-05-07");
    session.send(b"\x1b");
    session.wait_no_text("Set Due Date");
    session.send(b"q");
    let status = session.wait_exit(TIMEOUT);
    assert_eq!(status.exit_code(), 0);
}
