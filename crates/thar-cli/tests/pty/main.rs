//! PTY integration tests for the `thar-rs` TUI.
//!
//! Each test spawns the real binary on a real pseudo-terminal and drives it
//! with the bytes a terminal sends, so the terminal lifecycle, the crossterm
//! key/mouse decoding and the ratatui backend are all exercised end to end.
//! Assertions read the parsed `vt100` screen and target stable text (todo
//! text, context headers, action-bar labels) rather than whole-screen
//! goldens; the view styling is pinned separately by `thar-tui/tests/golden.rs`.
//!
//! portable-pty is Unix-focused (it has a Windows backend, but CI only runs
//! these tests on Linux and macOS), so the target compiles to an empty crate
//! elsewhere: `cargo check --all-targets` on Windows still validates the
//! dependency tree, and the job never runs a PTY test it cannot support.
#![cfg(unix)]

mod screenshot;
mod session;
#[path = "../support/mod.rs"]
mod support;

mod cp7_calendar;
mod cp7_editor;
mod cp7_menu;
mod cp7_sync;
mod cp7_write;

use session::{COLS, Session, TIMEOUT};
use support::{TempDir, modified};

/// Fixture for the initial-screen, keyboard and mouse tests.
///
/// The row model sorts open before done, then by context (`None` first, then
/// `home`, then `work`), then archival overdue metadata, then priority. Both
/// hidden todos (a non-zero `h:` and a future `t:`) are deliberately last in
/// load order so their absence cannot be confused with truncation.
const FIXTURE: &str = "\
(A) write port plan @work +thar due:2000-01-01
buy milk @home
read rust book @home +learning h:1
plan the sprint @work t:2999-01-01
x 2026-01-01 ship the release @work +thar
(C) review pull request @work
water the plants
call the dentist
";

const UP: &[u8] = b"\x1b[A";
const DOWN: &[u8] = b"\x1b[B";
const CTRL_UP: &[u8] = b"\x1b[1;5A";
const CTRL_DOWN: &[u8] = b"\x1b[1;5B";
const HOME: &[u8] = b"\x1b[H";
const END: &[u8] = b"\x1b[F";
const ENTER: &[u8] = b"\r";
const ESC: &[u8] = b"\x1b";
const BACKSPACE: u8 = 0x7f;
const CTRL_C: &[u8] = b"\x03";

/// Create a fixture directory and open its `todo.txt`.
fn open_fixture(label: &str, contents: &str) -> (TempDir, Session) {
    let directory = TempDir::new(label);
    let path = directory.write("todo.txt", contents.as_bytes());
    let session = Session::open(&path);
    (directory, session)
}

/// The exact first screen row for a search bar holding `query` at [`COLS`].
///
/// The bar is `" / "` + the query + blank cells, then the three-cell closing
/// delimiter `" / "` anchored at `COLS - 3`.
fn search_row(query: &str) -> String {
    let mut row = format!(" / {query}");
    row.push_str(&" ".repeat(usize::from(COLS) - 3 - row.len()));
    row.push_str(" / ");
    row
}

/// An SGR mouse event, encoded the way xterm sends it.
///
/// `button` is the SGR button byte (0 left, 4 shift+left, 64 wheel up, 65
/// wheel down), and `column`/`row` are 1-based terminal cells.
fn mouse(button: u8, column: u16, row: u16) -> Vec<u8> {
    format!("\x1b[<{button};{column};{row}M").into_bytes()
}

#[test]
fn initial_screen_shows_the_list_and_action_bar() {
    let (_directory, session) = open_fixture("initial", FIXTURE);
    // The action bar is painted after the list, so waiting for its last item
    // proves the whole first frame is complete; the PTY reader can otherwise
    // hand over a prefix of the first draw.
    session.wait_text("/ Search");

    let snapshot = session.snapshot();
    let screen = &snapshot.text;

    // Todo text, priorities and tags.
    for needle in [
        "water the plants",
        "call the dentist",
        "buy milk",
        "(A) write port plan @work +thar due:2000-01-01",
        "(C) review pull request @work",
        "ship the release @work +thar",
    ] {
        assert!(
            screen.contains(needle),
            "the initial screen is missing {needle:?}:\n{screen}"
        );
    }

    // Context headers, including the uncategorised group.
    for needle in ["None (2)", "home (1)", "work (3)"] {
        assert!(
            screen.contains(needle),
            "the initial screen is missing the {needle:?} header:\n{screen}"
        );
    }

    // Action bar labels come from `layout::ACTION_ITEMS`.
    for label in ["Menu", "Quit", "New", "Edit", "Search"] {
        assert!(
            screen.contains(label),
            "the action bar is missing {label:?}:\n{screen}"
        );
    }
    assert!(
        !screen.contains("WRITE")
            && !screen.contains("NOT SAVING")
            && !screen.contains("READ-ONLY")
            && !screen.to_lowercase().contains("read-only"),
        "the UI must not mention a write or read-only mode:\n{screen}"
    );
    assert!(
        !screen.contains("not found"),
        "a present file must not render the missing-file note:\n{screen}"
    );

    // Both hidden todos are filtered out of the default overview.
    for needle in [
        "read rust book",
        "plan the sprint",
        "[HIDDEN TODOS VISIBLE]",
    ] {
        assert!(
            !screen.contains(needle),
            "{needle:?} must not be visible by default:\n{screen}"
        );
    }

    // The cursor starts on the first visible todo, not on a header.
    let focused = snapshot.focused_text().expect("a focused todo row");
    assert!(
        focused.contains("water the plants"),
        "unexpected initial cursor row: {focused:?}"
    );
}

#[test]
fn a_large_paste_opens_the_confirmation_and_cancel_leaves_the_file_unchanged() {
    let directory = TempDir::new("pty-paste");
    let path = directory.write("todo.txt", b"one\n");
    let before_bytes = std::fs::read(&path).expect("read before");
    let before_mtime = modified(&path);
    let before_entries = directory.entries();
    let mut session = Session::open(&path);

    session.wait_todo_text("one");

    // Eleven lines open the paste confirmation instead of adding anything.
    let pasted = (1..=11)
        .map(|index| format!("pasted {index}"))
        .collect::<Vec<_>>()
        .join("\n");
    session.send(format!("\x1b[200~{pasted}\x1b[201~").as_bytes());
    session.wait_text("Paste Multiple Todos");

    session.send(ESC);
    session.wait_no_text("Paste Multiple Todos");
    session.wait_no_todo_text("pasted");

    session.send(b"q");
    let status = session.wait_exit(TIMEOUT);
    assert_eq!(status.exit_code(), 0);
    assert_eq!(
        std::fs::read(&path).expect("read after"),
        before_bytes,
        "a cancelled paste must not change the file"
    );
    assert_eq!(
        modified(&path),
        before_mtime,
        "a no-op session must not rewrite the file"
    );
    assert_eq!(
        directory.entries(),
        before_entries,
        "a no-op session must not create backup or temp files"
    );
    assert!(!directory.join("todo.txt.bak").exists());
}

#[test]
fn a_large_paste_confirms_and_saves_every_line() {
    let directory = TempDir::new("pty-paste-confirm");
    let path = directory.write("todo.txt", b"one\n");
    let mut session = Session::open(&path);

    session.wait_todo_text("one");

    let pasted = (1..=11)
        .map(|index| format!("pasted {index}"))
        .collect::<Vec<_>>()
        .join("\n");
    session.send(format!("\x1b[200~{pasted}\x1b[201~").as_bytes());
    session.wait_text("Paste Multiple Todos");

    session.send(ENTER);
    session.wait_text("Pasted 11 todo(s)");
    session.wait_todo_text("pasted 11");

    session.send(b"q");
    let status = session.wait_exit(TIMEOUT);
    assert_eq!(status.exit_code(), 0);

    let saved = std::fs::read_to_string(&path).expect("read saved file");
    assert_eq!(
        saved.lines().count(),
        12,
        "one original plus eleven pasted lines: {saved:?}"
    );
    for index in 1..=11 {
        assert!(
            saved
                .lines()
                .any(|line| line.ends_with(&format!("pasted {index}"))),
            "missing exact pasted line {index}: {saved:?}"
        );
    }
}

#[test]
fn keyboard_navigation_moves_the_cursor_through_rows_and_contexts() {
    let (_directory, mut session) = open_fixture("keyboard", FIXTURE);
    session.wait_text("water the plants");
    session.wait_focused("water the plants");

    // Down/Up step one todo row and skip context headers.
    session.send(DOWN);
    session.wait_focused("call the dentist");
    session.send(UP);
    session.wait_focused("water the plants");

    // Ctrl+Down/Up jump to the first todo of the next/previous group.
    session.send(CTRL_DOWN);
    session.wait_focused("buy milk");
    session.send(CTRL_DOWN);
    session.wait_focused("write port plan");
    session.send(CTRL_UP);
    session.wait_focused("buy milk");

    // End/Home are the last and first todo rows, headers excluded.
    session.send(END);
    session.wait_focused("ship the release");
    session.send(HOME);
    session.wait_focused("water the plants");

    // q exits with a success status.
    session.send(b"q");
    let status = session.wait_exit(TIMEOUT);
    assert_eq!(status.exit_code(), 0, "q must exit 0");
}

#[test]
fn search_filters_shows_no_results_and_clears() {
    let (_directory, mut session) = open_fixture("search", FIXTURE);
    session.wait_text("water the plants");

    // `/` focuses the search bar (two rows at the top). The whole first row
    // and the inverse cursor cell right after the `" / "` prompt prove it.
    session.send(b"/");
    session.wait_row(0, &search_row(""));
    session.wait_cell_reversed(0, 3, true);

    // Typing filters the list; the cursor cell moves after the query.
    session.send(b"milk");
    session.wait_row(0, &search_row("milk"));
    session.wait_cell_reversed(0, 7, true);
    session.wait_todo_text("buy milk");
    session.wait_no_todo_text("water the plants");

    // A query without a match renders the no-results state.
    session.send(b"zzz");
    session.wait_text("No results found for 'milkzzz'");
    assert!(
        session.snapshot().todos.is_empty(),
        "the no-results state must not render todo rows"
    );

    // Backspace restores the previous filter.
    session.send(&[BACKSPACE; 3]);
    session.wait_todo_text("buy milk");

    // Enter keeps the filter and leaves the search bar: the exact row is the
    // blurred query (no inverse cursor) with the closing delimiter at
    // COLS - 3, and the cell that held the cursor is no longer reversed.
    session.send(ENTER);
    session.wait_row(0, &search_row("milk"));
    session.wait_cell_reversed(0, 7, false);
    session.wait_focused("buy milk");
    let snapshot = session.snapshot();
    assert!(
        snapshot
            .todos
            .iter()
            .all(|todo| !todo.text.contains("water")),
        "Enter must keep the filter applied:\n{}",
        snapshot.text
    );

    // Escape clears the filter, blurs the bar and hides it: the first row is
    // the list's first header again, not a search row.
    session.send(b"/");
    session.send(ESC);
    session.wait_todo_text("water the plants");
    session.wait_row(
        0,
        &format!("  None (2){}", " ".repeat(usize::from(COLS) - 10)),
    );
}

#[test]
fn hidden_view_toggle_shows_the_indicator_and_hidden_rows() {
    let (_directory, mut session) = open_fixture("hidden", FIXTURE);
    session.wait_text("water the plants");
    session.wait_no_todo_text("read rust book");

    session.send(b"H");
    session.wait_text("[HIDDEN TODOS VISIBLE]");
    session.wait_todo_text("read rust book");
    session.wait_todo_text("plan the sprint");

    // The group counts include the newly visible rows.
    let screen = session.snapshot().text;
    assert!(screen.contains("home (2)"), "{screen}");
    assert!(screen.contains("work (4)"), "{screen}");
}

#[test]
fn mouse_wheel_scrolls_and_clicks_select_and_extend() {
    let mut contents = String::new();
    for number in 1..=15 {
        contents.push_str(&format!("loose {number:02}\n"));
    }
    for number in 1..=30 {
        contents.push_str(&format!("task {number:02} @work\n"));
    }
    let (_directory, mut session) = open_fixture("mouse", &contents);

    // 46 todos plus two headers cannot fit in 28 list rows.
    session.wait_text("None (15)");
    let top = first_line(&session);
    assert!(top.contains("None (15)"), "unexpected top row: {top:?}");
    let cursor = session.snapshot().focused_text().map(str::to_owned);

    // Wheel down one row scrolls the viewport without moving the cursor.
    session.send(&mouse(65, 10, 5));
    session.wait_until("the list to scroll down one row", |snapshot| {
        snapshot
            .text
            .lines()
            .next()
            .is_some_and(|line| line.contains("loose 01"))
    });
    assert_eq!(
        session.snapshot().focused_text().map(str::to_owned),
        cursor,
        "the wheel must scroll the viewport, not the cursor"
    );

    // Wheel up returns to the top.
    session.send(&mouse(64, 10, 5));
    session.wait_text("None (15)");

    // A left click on a todo row selects it.
    session.send(&mouse(0, 5, 3));
    session.wait_focused("loose 02");

    // Shift+left (SGR button 4) extends from the anchor to the clicked row.
    session.send(&mouse(4, 5, 5));
    session.wait_until("a three-row shift selection", |snapshot| {
        snapshot.highlighted().len() == 3
    });
    let selected: Vec<String> = session
        .snapshot()
        .highlighted()
        .iter()
        .map(|todo| todo.text.clone())
        .collect();
    assert!(
        selected[0].contains("loose 02")
            && selected[1].contains("loose 03")
            && selected[2].contains("loose 04"),
        "unexpected shift selection: {selected:?}"
    );
}

#[test]
fn double_click_toggles_the_todo_and_persists() {
    let directory = TempDir::new("double-click");
    let path = directory.write("todo.txt", FIXTURE.as_bytes());
    let mut session = Session::open(&path);
    session.wait_text("water the plants");

    // Two clicks in one write: the app sees both well inside the 350 ms
    // double-click window, so the test never depends on scheduling luck.
    // Column 5 is the checkbox of row 3 (`call the dentist`).
    let click = mouse(0, 5, 3);
    let mut double_click = click.clone();
    double_click.extend(click);
    session.send(&double_click);

    session.wait_text("[x] call the dentist");
    session.wait_focused("call the dentist");

    session.send(b"q");
    let status = session.wait_exit(TIMEOUT);
    assert_eq!(status.exit_code(), 0);
    let saved = std::fs::read_to_string(&path).expect("read saved file");
    assert!(
        saved
            .lines()
            .any(|line| line.starts_with("x ") && line.contains("call the dentist")),
        "the double-click toggle must be saved: {saved:?}"
    );
}

#[test]
fn ctrl_c_exits_cleanly_and_restores_the_terminal() {
    let (_directory, mut session) = open_fixture("ctrl-c", FIXTURE);
    session.wait_text("water the plants");

    session.send(CTRL_C);
    let status = session.wait_exit(TIMEOUT);
    assert_eq!(status.exit_code(), 0, "Ctrl+C must exit 0");

    assert_restored(&session);
}

#[test]
fn panic_reports_the_failure_and_restores_the_terminal() {
    let directory = TempDir::new("panic");
    let path = directory.write("todo.txt", FIXTURE.as_bytes());
    let mut session = Session::open_with(&path, &[("THAR_TUI_PANIC", "1")]);

    // The restore hook runs before the panic message is printed, so these
    // bytes prove the terminal was put back first. The trigger text is asserted
    // on the raw stream as well: the panic message may be scrolled by a
    // backtrace on a short screen.
    session.wait_text("panicked");
    session.wait_raw(b"THAR_TUI_PANIC=1: deliberately panicking");

    let status = session.wait_exit(TIMEOUT);
    assert!(
        !status.success(),
        "the deliberate panic must exit non-zero, got {status}"
    );

    assert_restored(&session);
}

#[test]
fn a_missing_file_is_created_and_renders_the_welcome_screen() {
    let directory = TempDir::new("missing");
    let mut session = Session::start(directory.path(), &[]);

    // Write-by-default startup creates the file, so the empty list shows the
    // welcome quote rather than the missing-file note.
    session.wait_text("I love deadlines");
    session.wait_text("Menu");
    let snapshot = session.snapshot();
    assert!(
        snapshot.todos.is_empty(),
        "an empty file must render an empty list:\n{}",
        snapshot.text
    );
    assert!(
        directory.join("todo.txt").exists(),
        "the binary must create a missing todo file"
    );

    session.send(b"q");
    let status = session.wait_exit(TIMEOUT);
    assert_eq!(status.exit_code(), 0);
}

/// The terminal-restore sequences a TUI must emit on the way out: leave the
/// alternate screen, disable mouse capture and bracketed paste, show the
/// cursor.
fn assert_restored(session: &Session) {
    for (name, sequence) in [
        ("leave the alternate screen", b"\x1b[?1049l".as_slice()),
        ("disable SGR mouse mode", b"\x1b[?1006l".as_slice()),
        ("disable bracketed paste", b"\x1b[?2004l".as_slice()),
        ("show the cursor", b"\x1b[?25h".as_slice()),
    ] {
        assert!(
            session.raw_contains(sequence),
            "the terminal was not restored: missing {name} ({sequence:?})"
        );
    }
}

/// The first non-empty screen line.
fn first_line(session: &Session) -> String {
    session
        .snapshot()
        .text
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or_default()
        .to_owned()
}
