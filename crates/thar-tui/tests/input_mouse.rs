//! Mouse parity: row clicks, shift ranges, double clicks, action bar and wheel.
//!
//! `thar-cli` converts crossterm's 0-based cells to 1-based [`MouseInput`], so
//! every coordinate in this file is 1-based. The list geometry comes from the
//! shared [`thar_tui::layout::Layout`], which is also what the renderer uses.

use std::time::{Duration, Instant};

use thar_core::{Todo, TodoDate, TodoId};
use thar_tui::input::{
    self, Command, DOUBLE_CLICK_WINDOW, MouseInput, MouseKind, READ_ONLY_MESSAGE, clicked_checkbox,
    handle_mouse,
};
use thar_tui::layout::{self, Layout};
use thar_tui::{App, nav};

fn app_with(lines: &[&str], width: u16, height: u16) -> App {
    let todos = lines
        .iter()
        .enumerate()
        .map(|(index, line)| Todo::parse_line(line, TodoId::new(index as u64)))
        .collect();
    let mut app = App::new(
        "todo.txt",
        todos,
        "2026-11-15".parse::<TodoDate>().expect("valid date"),
    );
    app.resize(width, height);
    app
}

fn two_todos() -> App {
    // 40x12: list rows 0..10, action border at 0-based 10, action content at
    // 0-based 11. Rows: None header (y=1), one (y=2), two (y=3).
    app_with(&["one", "two"], 40, 12)
}

fn click(x: u16, y: u16, shift: bool) -> MouseInput {
    MouseInput {
        kind: MouseKind::LeftClick,
        x,
        y,
        shift,
    }
}

fn wheel(kind: MouseKind) -> MouseInput {
    MouseInput {
        kind,
        x: 1,
        y: 2,
        shift: false,
    }
}

fn rejected() -> Option<Command> {
    Some(Command::Rejected(READ_ONLY_MESSAGE))
}

fn cursor_text(app: &App) -> Option<String> {
    app.selected_todo().map(|todo| todo.text.clone())
}

fn current_time() -> std::time::Instant {
    std::time::Instant::now()
}

#[test]
fn a_left_click_selects_the_todo_under_the_cursor() {
    let mut app = two_todos();
    let now = Instant::now();

    let (last, command) = handle_mouse(&mut app, click(1, 3, false), None, now);
    assert_eq!(command, None);
    assert_eq!(cursor_text(&app).as_deref(), Some("two"));
    let last = last.expect("a click is recorded");
    assert_eq!(last.todo_id, Some(TodoId::new(1)));
    assert_eq!((last.x, last.y), (1, 3));
}

#[test]
fn a_click_on_a_header_or_outside_the_list_is_ignored() {
    let mut app = two_todos();
    let now = Instant::now();
    let before = app.cursor();

    // y=1 is the "None" header.
    let (last, command) = handle_mouse(&mut app, click(1, 1, false), None, now);
    assert_eq!(command, None);
    assert_eq!(app.cursor(), before);
    assert_eq!(last.expect("recorded").todo_id, None);

    // The action-bar border is not the action content row.
    let (_, command) = handle_mouse(&mut app, click(1, 11, false), None, now);
    assert_eq!(command, None);
    assert_eq!(app.cursor(), before);

    // A click beyond the last row of the list.
    let (_, command) = handle_mouse(&mut app, click(1, 10, false), None, now);
    assert_eq!(command, None);
    assert_eq!(app.cursor(), before);
}

#[test]
fn shift_click_extends_the_range_from_the_previous_cursor() {
    let mut app = two_todos();
    let now = Instant::now();

    handle_mouse(&mut app, click(1, 3, false), None, now);
    assert_eq!(cursor_text(&app).as_deref(), Some("two"));

    let (_, command) = handle_mouse(&mut app, click(1, 2, true), None, now);
    assert_eq!(command, None);
    assert_eq!(app.anchor(), Some(TodoId::new(1)));
    assert_eq!(app.range(), [TodoId::new(0), TodoId::new(1)]);
    assert_eq!(app.selected_todos().len(), 2);
    assert_eq!(cursor_text(&app).as_deref(), Some("one"));

    // A plain click collapses the range again.
    handle_mouse(&mut app, click(1, 3, false), None, now);
    assert!(app.range().is_empty());
    assert_eq!(app.anchor(), None);
}

#[test]
fn a_click_on_a_header_never_extends_a_range() {
    let mut app = two_todos();
    let now = Instant::now();

    nav::move_cursor(&mut app, 1, true);
    assert_eq!(app.range().len(), 2);

    let (_, command) = handle_mouse(&mut app, click(1, 1, true), None, now);
    assert_eq!(command, None);
    assert_eq!(app.range().len(), 2);
}

#[test]
fn a_double_click_selects_and_is_rejected_read_only() {
    let mut app = two_todos();
    let now = Instant::now();

    let (first, command) = handle_mouse(&mut app, click(1, 2, false), None, now);
    assert_eq!(command, None);
    assert_eq!(cursor_text(&app).as_deref(), Some("one"));

    let (_, command) = handle_mouse(
        &mut app,
        click(1, 2, false),
        first,
        now + DOUBLE_CLICK_WINDOW / 2,
    );
    assert_eq!(command, rejected());
    assert_eq!(cursor_text(&app).as_deref(), Some("one"));
    assert_eq!(
        app.toast_message(Instant::now()),
        None,
        "handle_mouse returns the command; applying it is the event loop's job"
    );
    input::apply(
        &mut app,
        Command::Rejected(READ_ONLY_MESSAGE),
        current_time(),
    );
    assert_eq!(app.toast_message(Instant::now()), Some(READ_ONLY_MESSAGE));
}

#[test]
fn a_double_click_on_the_checkbox_and_on_the_text_are_both_rejected() {
    for x in [4, 20] {
        let mut app = two_todos();
        let now = Instant::now();
        let (first, _) = handle_mouse(&mut app, click(x, 2, false), None, now);
        let (_, command) = handle_mouse(
            &mut app,
            click(x, 2, false),
            first,
            now + Duration::from_millis(100),
        );
        assert_eq!(command, rejected(), "column {x}");
    }
}

#[test]
fn clicks_outside_the_double_click_window_are_two_single_clicks() {
    let mut app = two_todos();
    let now = Instant::now();

    let (first, _) = handle_mouse(&mut app, click(1, 2, false), None, now);
    let (_, command) = handle_mouse(
        &mut app,
        click(1, 2, false),
        first,
        now + DOUBLE_CLICK_WINDOW + Duration::from_millis(1),
    );
    assert_eq!(command, None);
}

#[test]
fn a_click_on_another_row_is_not_a_double_click() {
    let mut app = two_todos();
    let now = Instant::now();

    let (first, _) = handle_mouse(&mut app, click(1, 2, false), None, now);
    let (_, command) = handle_mouse(
        &mut app,
        click(1, 3, false),
        first,
        now + Duration::from_millis(100),
    );
    assert_eq!(command, None);
}

#[test]
fn a_shift_click_never_counts_as_a_double_click() {
    let mut app = two_todos();
    let now = Instant::now();

    let (first, _) = handle_mouse(&mut app, click(1, 2, false), None, now);
    let (_, command) = handle_mouse(
        &mut app,
        click(1, 2, true),
        first,
        now + Duration::from_millis(100),
    );
    assert_eq!(command, None);
    // The shift click stays a range update, never a double click: the anchor
    // is the previous cursor, so this click selects exactly that row.
    assert_eq!(app.range(), [TodoId::new(0)]);
    assert_eq!(app.anchor(), Some(TodoId::new(0)));
}

#[test]
fn action_bar_clicks_map_to_their_command() {
    let layout = Layout::new(40, 12, false);
    let y = layout.action_row() + 1;
    let cases = [
        (1, rejected()),
        (10, Some(Command::Quit)),
        (19, rejected()),
        (27, rejected()),
        (36, Some(Command::SearchFocus)),
        (47, None),
    ];

    for (x, expected) in cases {
        let mut app = two_todos();
        let before = app.cursor();
        let (last, command) = handle_mouse(&mut app, click(x, y, false), None, Instant::now());
        assert_eq!(command, expected, "column {x}");
        assert_eq!(app.cursor(), before);
        assert!(last.is_none(), "action clicks are not row clicks");
    }
}

#[test]
fn action_bar_covers_every_layout_segment() {
    // The hit-test must agree with the shared table, including its boundaries.
    for (index, (key, label)) in layout::ACTION_ITEMS.iter().enumerate() {
        let start: u16 = layout::ACTION_ITEMS[..index]
            .iter()
            .map(|(key, label)| layout::action_item_width(key, label))
            .sum();
        let end = start + layout::action_item_width(key, label) - 1;
        assert_eq!(layout::action_item_at(start), Some(*key));
        assert_eq!(layout::action_item_at(end), Some(*key));
    }
}

#[test]
fn wheel_scrolls_only_while_the_list_owns_focus() {
    let lines: Vec<String> = (1..=20).map(|n| format!("task {n:02}")).collect();
    let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
    let mut app = app_with(&refs, 40, 12);
    // 10 list rows, 21 row-model rows, so the maximum offset is 11.
    let now = Instant::now();

    app.set_offset(5);
    handle_mouse(&mut app, wheel(MouseKind::WheelUp), None, now);
    assert_eq!(app.offset(), 4);
    handle_mouse(&mut app, wheel(MouseKind::WheelDown), None, now);
    assert_eq!(app.offset(), 5);

    app.set_offset(0);
    handle_mouse(&mut app, wheel(MouseKind::WheelUp), None, now);
    assert_eq!(app.offset(), 0);

    app.set_offset(app.max_offset());
    assert_eq!(app.offset(), 11);
    handle_mouse(&mut app, wheel(MouseKind::WheelDown), None, now);
    assert_eq!(app.offset(), 11);

    app.set_search_focused(true);
    app.set_offset(5);
    handle_mouse(&mut app, wheel(MouseKind::WheelUp), None, now);
    assert_eq!(app.offset(), 5);
    handle_mouse(&mut app, wheel(MouseKind::WheelDown), None, now);
    assert_eq!(app.offset(), 5);
}

#[test]
fn mouse_motion_is_ignored() {
    let mut app = two_todos();
    let (last, command) = handle_mouse(
        &mut app,
        MouseInput {
            kind: MouseKind::Move,
            x: 10,
            y: 3,
            shift: false,
        },
        None,
        Instant::now(),
    );
    assert!(last.is_none());
    assert_eq!(command, None);
}

#[test]
fn clicked_checkbox_matches_the_layout_table() {
    let app = app_with(&["one"], 40, 12);
    let columns = layout::checkbox_columns(app.max_todo_number_digits());
    assert_eq!(columns, 3..=5);

    // 1-based terminal columns: 0-based 3..=5 is 4..=6.
    assert!(clicked_checkbox(&app, 4));
    assert!(clicked_checkbox(&app, 5));
    assert!(clicked_checkbox(&app, 6));
    assert!(!clicked_checkbox(&app, 1));
    assert!(!clicked_checkbox(&app, 3));
    assert!(!clicked_checkbox(&app, 7));
}

#[test]
fn clicked_checkbox_follows_the_widest_todo_number() {
    let lines: Vec<String> = (1..=100).map(|n| format!("task {n:03}")).collect();
    let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
    let app = app_with(&refs, 40, 12);
    assert_eq!(app.max_todo_number_digits(), 3);

    let columns = layout::checkbox_columns(3);
    assert_eq!(columns, 5..=7);
    for column in columns.clone() {
        assert!(clicked_checkbox(&app, column + 1), "0-based {column}");
    }
    assert!(!clicked_checkbox(&app, *columns.start()));
    assert!(!clicked_checkbox(&app, columns.end() + 2));
}

#[test]
fn clicking_a_row_while_search_is_focused_focuses_the_list() {
    let mut app = app_with(&["one"], 40, 12);
    app.set_search_focused(true);
    // With the search bar visible the list starts on 0-based row 2.
    assert_eq!(app.layout().list_top, 2);

    let (_, command) = handle_mouse(&mut app, click(1, 4, false), None, Instant::now());
    assert_eq!(command, None);
    assert!(!app.search_focused());
    assert_eq!(cursor_text(&app).as_deref(), Some("one"));
}

#[test]
fn a_search_bar_click_is_not_a_row_click() {
    let mut app = app_with(&["one", "two"], 40, 12);
    app.set_search_focused(true);
    let before = app.cursor();

    let (_, command) = handle_mouse(&mut app, click(1, 1, false), None, Instant::now());
    assert_eq!(command, None);
    assert_eq!(app.cursor(), before);
    assert!(app.search_focused());
}
