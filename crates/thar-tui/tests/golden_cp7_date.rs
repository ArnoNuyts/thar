//! Golden frames for the CP7 date, priority, recurrence, and tag screens.
//!
//! The view styling is pinned the same way CP6's list is (`golden.rs`): a fixed
//! todo list, a fixed terminal size and a fixed day, then the exact cell
//! contents of the modal block. Comparing parsed `TestBackend` cells instead of
//! ANSI strings keeps the test independent of colour capability; the style
//! assertions next to the text ones catch a colour regression on the selected
//! row, the calendar selection and the tag checkboxes.
//!
//! Two sizes are covered because the calendar is 24 cells wide inside a fixed
//! 30-cell modal: 80×24 proves the vertically compact layout and 100×30 proves
//! the frame the PTY screenshot uses.
//!
//! The modal chrome always contributes three rows above the body (the outer
//! padding, the title, and the content-box padding) and two below, so a body of
//! `n` rows is a block of `n + 5` lines and body row `i` is block line `3 + i`.

use ratatui::Terminal;
use ratatui::backend::TestBackend;
use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::style::Color;
use thar_core::{Todo, TodoDate, TodoId};
use thar_tui::view;
use thar_tui::{App, ModalId};

fn app(lines: &[&str]) -> App {
    let todos = lines
        .iter()
        .enumerate()
        .map(|(index, line)| Todo::parse_line(line, TodoId::new(index as u64)))
        .collect();
    App::new(
        "todo.txt",
        todos,
        "2026-11-15".parse::<TodoDate>().expect("valid date"),
    )
}

fn draw(app: &App, width: u16, height: u16) -> Vec<String> {
    let mut terminal = Terminal::new(TestBackend::new(width, height)).expect("test terminal");
    terminal
        .draw(|frame| view::render(frame, app))
        .expect("draw succeeds");
    screen_lines(terminal.backend())
}

fn screen_lines(backend: &TestBackend) -> Vec<String> {
    let buffer = backend.buffer();
    (0..buffer.area.height)
        .map(|y| {
            (0..buffer.area.width)
                .map(|x| buffer[(x, y)].symbol())
                .collect::<String>()
                .trim_end()
                .to_owned()
        })
        .collect()
}

/// The modal block: from the outer top padding row through the outer bottom
/// padding row. The accent bar marks the title and body rows, so it locates the
/// block without relying on a box border.
fn modal_block(lines: &[String]) -> Vec<String> {
    let first = lines
        .iter()
        .position(|line| line.contains('┃'))
        .unwrap_or_else(|| panic!("no modal accent bar:\n{}", lines.join("\n")));
    let last = lines
        .iter()
        .rposition(|line| line.contains('┃'))
        .unwrap_or(first);
    let start = first.saturating_sub(1);
    let end = (last + 1).min(lines.len().saturating_sub(1));
    lines[start..=end].to_vec()
}

fn key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::NONE)
}

fn shift_key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::SHIFT)
}

/// A due-tagged todo plus a plain one, so the list has a `None` header and a
/// focused row behind the overlay.
fn fixture() -> App {
    app(&["ship the release +thar due:2024-05-06", "plain follow-up"])
}

/// Move to the `Custom` row (offset 4) and open the calendar.
fn open_calendar(app: &mut App) {
    app.open_modal(ModalId::SetDueDate);
    for _ in 0..4 {
        thar_tui::input::handle_key(app, key(KeyCode::Down), current_time());
    }
    thar_tui::input::handle_key(app, key(KeyCode::Enter), current_time());
}

fn current_time() -> std::time::Instant {
    std::time::Instant::now()
}

#[test]
fn the_due_date_list_matches_at_80x24() {
    let mut app = fixture();
    app.resize(80, 24);
    app.open_modal(ModalId::SetDueDate);
    let lines = draw(&app, 80, 24);
    let block = modal_block(&lines);
    assert_eq!(block.len(), 11, "{block:#?}");
    assert_eq!(
        block,
        vec![
            "",
            "                     ┃ Set Due Date",
            "                     ┃",
            "                     ┃  » Today",
            "                     ┃    Tomorrow",
            "                     ┃    Next Week",
            "                     ┃    Next Month",
            "                     ┃    Custom",
            "                     ┃    Reset",
            "                     ┃",
            "",
        ],
        "the due list must match the 80x24 frame exactly"
    );
    // 50% of 80 is 40 cells, centred at column 20.
    assert!(
        block[1].starts_with(&format!("{}┃ Set Due Date", " ".repeat(21))),
        "{block:#?}"
    );
    assert!(
        lines
            .last()
            .is_some_and(|line| line.ends_with("e Edit   / Search")),
        "the action bar must be the last row: {lines:#?}"
    );
    assert!(
        lines.iter().any(|line| line.contains("None (2)")),
        "{lines:#?}"
    );

    // The marker is the secondary accent.
    let mut terminal = Terminal::new(TestBackend::new(80, 24)).expect("test terminal");
    terminal
        .draw(|frame| view::render(frame, &app))
        .expect("draw succeeds");
    let buffer = terminal.backend().buffer();
    let top = lines
        .iter()
        .position(|line| line.contains('┃'))
        .expect("title row");
    let marker = &buffer[(24, u16::try_from(top + 2).expect("row"))];
    assert_eq!(marker.symbol(), "»");
    assert_eq!(marker.style().fg, Some(Color::Rgb(0xAF, 0x76, 0xB7)));
}

#[test]
fn the_calendar_step_matches_at_100x30() {
    let mut app = fixture();
    app.resize(100, 30);
    open_calendar(&mut app);
    let lines = draw(&app, 100, 30);
    let block = modal_block(&lines);
    assert_eq!(block.len(), 13, "{block:#?}");
    assert_eq!(
        block,
        vec![
            "",
            "                                    ┃ Set Due Date",
            "                                    ┃",
            "                                    ┃         May 2024",
            "                                    ┃   Mo Tu We Th Fr Sa Su",
            "                                    ┃   29 30  1  2  3  4  5",
            "                                    ┃    6  7  8  9 10 11 12",
            "                                    ┃   13 14 15 16 17 18 19",
            "                                    ┃   20 21 22 23 24 25 26",
            "                                    ┃   27 28 29 30 31  1  2",
            "                                    ┃   Selected: 2024-05-06",
            "                                    ┃",
            "",
        ],
        "the calendar must match the 100x30 frame exactly"
    );
    // 30 cells wide, centred in 100: columns 35..64, bar at 36.
    assert!(
        block[1].starts_with(&format!("{}┃ Set Due Date", " ".repeat(36))),
        "{block:#?}"
    );

    // The selected day cell is the success background.
    let mut terminal = Terminal::new(TestBackend::new(100, 30)).expect("test terminal");
    terminal
        .draw(|frame| view::render(frame, &app))
        .expect("draw succeeds");
    let buffer = terminal.backend().buffer();
    let success = (0..100)
        .flat_map(|x| (0..30).map(move |y| (x, y)))
        .filter(|(x, y)| buffer[(*x, *y)].style().bg == Some(Color::Rgb(0x7B, 0xA1, 0x52)))
        .count();
    assert_eq!(success, 3, "one selected day cell is three columns wide");
}

#[test]
fn the_calendar_moves_one_month_with_shift_right_at_100x30() {
    let mut app = fixture();
    app.resize(100, 30);
    open_calendar(&mut app);
    thar_tui::input::handle_key(&mut app, shift_key(KeyCode::Right), current_time());
    thar_tui::input::handle_key(&mut app, key(KeyCode::Right), current_time());
    let lines = draw(&app, 100, 30);
    let block = modal_block(&lines);
    assert!(block[3].contains("June 2024"), "{block:#?}");
    assert!(block[10].contains("Selected: 2024-06-07"), "{block:#?}");
}

#[test]
fn the_priority_screen_matches_at_80x24() {
    let mut app = app(&["(B) ship the release", "plain follow-up"]);
    app.resize(80, 24);
    app.open_modal(ModalId::SetPriority);
    let lines = draw(&app, 80, 24);
    let block = modal_block(&lines);
    assert_eq!(block.len(), 12, "{block:#?}");
    assert!(block[1].contains("Set Priority"), "{block:#?}");
    // 30 cells, centred: columns 25..54, bar at 26.
    assert!(
        block[1].starts_with(&format!("{}┃ Set Priority", " ".repeat(26))),
        "{block:#?}"
    );
    assert!(block[3].contains("» A"), "{block:#?}");
    for (index, letter) in ["B", "C", "D", "E", "F", "Unset"].iter().enumerate() {
        assert!(block[4 + index].contains(letter), "row {index}: {block:#?}");
    }
}

#[test]
fn the_recurrence_base_matches_at_80x24() {
    let mut app = app(&["water the plants rec:1w", "plain follow-up"]);
    app.resize(80, 24);
    app.open_modal(ModalId::SetRecurrence);
    let lines = draw(&app, 80, 24);
    let block = modal_block(&lines);
    assert_eq!(block.len(), 10, "{block:#?}");
    assert!(block[1].contains("Set Recurrence Base"), "{block:#?}");
    for (index, label) in ["Daily", "Weekly", "Monthly", "Yearly", "Reset"]
        .iter()
        .enumerate()
    {
        assert!(block[3 + index].contains(label), "row {index}: {block:#?}");
    }
    assert!(block[3].contains("» Daily"), "{block:#?}");
}

#[test]
fn the_recurrence_amount_matches_at_80x24() {
    let mut app = app(&["water the plants rec:1w", "plain follow-up"]);
    app.resize(80, 24);
    app.open_modal(ModalId::SetRecurrence);
    thar_tui::input::handle_key(&mut app, key(KeyCode::Down), current_time());
    thar_tui::input::handle_key(&mut app, key(KeyCode::Enter), current_time());
    thar_tui::input::handle_key(&mut app, key(KeyCode::Char('3')), current_time());
    let lines = draw(&app, 80, 24);
    let block = modal_block(&lines);
    assert_eq!(block.len(), 7, "{block:#?}");
    assert!(
        block[1].contains("Set Recurrence Interval (Weekly)"),
        "{block:#?}"
    );
    assert!(block[3].contains("Every 3 week(s)"), "{block:#?}");
    assert!(block[4].contains("Enter = save, Esc = back"), "{block:#?}");
}

#[test]
fn the_tag_editor_matches_at_100x30() {
    let mut app = app(&[
        "one +work @office",
        "two +work +personal @office",
        "three +personal",
    ]);
    app.set_range(app.todos().iter().take(2).map(|todo| todo.id).collect());
    app.resize(100, 30);
    app.open_modal(ModalId::AddProject);
    let lines = draw(&app, 100, 30);
    let block = modal_block(&lines);
    assert_eq!(block.len(), 9, "{block:#?}");
    assert!(block[1].contains("Modify Projects"), "{block:#?}");
    // 40 cells, centred: columns 30..69, bar at 31.
    assert!(
        block[1].starts_with(&format!("{}┃ Modify Projects", " ".repeat(31))),
        "{block:#?}"
    );
    assert!(block[3].contains("» New:"), "{block:#?}");
    assert!(block[3].contains('+'), "{block:#?}");
    assert!(block[4].contains('─'), "{block:#?}");
    // personal is on one of the two selected todos, work on both.
    assert!(block[5].contains("[?] personal"), "{block:#?}");
    assert!(block[6].contains("[x] work"), "{block:#?}");

    // `[x]` uses the success colour and `[?]` the warning colour.
    let mut terminal = Terminal::new(TestBackend::new(100, 30)).expect("test terminal");
    terminal
        .draw(|frame| view::render(frame, &app))
        .expect("draw succeeds");
    let buffer = terminal.backend().buffer();
    let top = u16::try_from(
        lines
            .iter()
            .position(|line| line.contains('┃'))
            .expect("title row"),
    )
    .expect("row");
    let personal = &buffer[(36, top + 4)];
    let work = &buffer[(36, top + 5)];
    assert_eq!(personal.symbol(), "[");
    assert_eq!(personal.style().fg, Some(Color::Rgb(0xDD, 0xB1, 0x4D)));
    assert_eq!(work.symbol(), "[");
    assert_eq!(work.style().fg, Some(Color::Rgb(0x7B, 0xA1, 0x52)));
}

#[test]
fn a_context_editor_matches_at_80x24() {
    let mut app = app(&["one +work @office", "two +work @office @home"]);
    app.set_range(app.todos().iter().take(2).map(|todo| todo.id).collect());
    app.resize(80, 24);
    app.open_modal(ModalId::AddContext);
    let lines = draw(&app, 80, 24);
    let block = modal_block(&lines);
    assert_eq!(block.len(), 9, "{block:#?}");
    assert!(block[1].contains("Modify Contexts"), "{block:#?}");
    assert!(block[3].contains('@'), "{block:#?}");
    assert!(block[5].contains("[?] home"), "{block:#?}");
    assert!(block[6].contains("[x] office"), "{block:#?}");
}
