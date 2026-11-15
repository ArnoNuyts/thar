//! Selection parity: header skipping, context moves, shift ranges and paging.
//!
//! The row model is the navigation model, so every test here counts the
//! `"None"` header (and any context headers) as rows while asserting that a
//! cursor or a range only ever lands on todo rows.

use thar_core::{Todo, TodoDate, TodoId};
use thar_tui::input::{self, Command};
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
        TodoDate::parse("2026-11-15").expect("valid date"),
    );
    app.resize(width, height);
    app
}

fn cursor_text(app: &App) -> Option<String> {
    app.selected_todo().map(|todo| todo.text.clone())
}

fn cursor_row(app: &App) -> Option<usize> {
    app.cursor.and_then(|id| app.row_for(id))
}

#[test]
fn the_none_header_is_a_row_but_never_a_selection() {
    let mut app = app_with(&["one", "two"], 80, 10);

    assert_eq!(app.rows()[0].context_count(), Some(2));
    assert_eq!(app.rows().len(), 3);
    assert_eq!(cursor_row(&app), Some(1));
    assert_eq!(cursor_text(&app).as_deref(), Some("one"));

    nav::move_cursor(&mut app, -1, false);
    // The leading header cannot be selected, so Up stays on the first todo.
    assert_eq!(cursor_text(&app).as_deref(), Some("one"));

    nav::move_cursor(&mut app, 1, false);
    assert_eq!(cursor_text(&app).as_deref(), Some("two"));
    nav::move_cursor(&mut app, 1, false);
    assert_eq!(cursor_text(&app).as_deref(), Some("two"));
}

#[test]
fn arrow_steps_skip_every_context_header() {
    let mut app = app_with(&["one @home", "two", "three @home"], 80, 10);

    // Rows: None header, two, home header, one, three.
    assert_eq!(cursor_text(&app).as_deref(), Some("two"));
    nav::move_cursor(&mut app, 1, false);
    assert_eq!(cursor_text(&app).as_deref(), Some("one @home"));
    nav::move_cursor(&mut app, 1, false);
    assert_eq!(cursor_text(&app).as_deref(), Some("three @home"));
}

#[test]
fn context_moves_land_on_the_first_todo_and_do_not_wrap() {
    let mut app = app_with(&["one @home", "two", "three @home"], 80, 10);

    assert_eq!(cursor_text(&app).as_deref(), Some("two"));
    // The first group has no previous group.
    nav::move_context(&mut app, -1, false);
    assert_eq!(cursor_text(&app).as_deref(), Some("two"));

    nav::move_context(&mut app, 1, false);
    assert_eq!(cursor_text(&app).as_deref(), Some("one @home"));

    // `one` and `three` are one contiguous group: the next header is already
    // past the last group, so there is nowhere to go.
    nav::move_context(&mut app, 1, false);
    assert_eq!(cursor_text(&app).as_deref(), Some("one @home"));

    nav::move_context(&mut app, -1, false);
    assert_eq!(cursor_text(&app).as_deref(), Some("two"));
}

#[test]
fn shift_ranges_span_headers_but_contain_only_todos() {
    let mut app = app_with(&["one @home", "two", "three @home", "four"], 80, 10);

    // Rows: None header, two, four, home header, one, three.
    assert_eq!(cursor_text(&app).as_deref(), Some("two"));
    // No anchor yet: the first shift step anchors on the previous cursor.
    nav::move_cursor(&mut app, 1, true);
    assert_eq!(app.anchor, Some(TodoId::new(1)));
    assert_eq!(app.range, [TodoId::new(1), TodoId::new(3)]);

    nav::move_cursor(&mut app, 1, true);
    nav::move_cursor(&mut app, 1, true);
    assert_eq!(
        app.range,
        [
            TodoId::new(1),
            TodoId::new(3),
            TodoId::new(0),
            TodoId::new(2)
        ]
    );
    // The home header sits inside the row span but is not a selection.
    assert_eq!(app.selected_todos().len(), app.range.len());
    assert!(
        app.rows()[app.row_for(TodoId::new(3)).unwrap()..=app.row_for(TodoId::new(0)).unwrap()]
            .iter()
            .any(|row| !row.is_todo())
    );

    // Contracting back to the anchor leaves exactly the anchor selected.
    for _ in 0..3 {
        nav::move_cursor(&mut app, -1, true);
    }
    assert_eq!(app.range, [TodoId::new(1)]);
    assert_eq!(cursor_text(&app).as_deref(), Some("two"));
}

#[test]
fn plain_selection_clears_the_anchor_and_range() {
    let mut app = app_with(&["one", "two", "three"], 80, 10);

    nav::move_cursor(&mut app, 2, true);
    assert_eq!(app.range.len(), 3);
    assert!(app.anchor.is_some());

    nav::select_first(&mut app);
    assert!(app.range.is_empty());
    assert_eq!(app.anchor, None);

    nav::move_cursor(&mut app, 1, true);
    assert_eq!(app.anchor, Some(TodoId::new(0)));
    nav::select_row(&mut app, 3, false);
    assert!(app.range.is_empty());
    assert_eq!(app.anchor, None);
}

#[test]
fn shift_context_move_extends_over_the_group_in_between() {
    let mut app = app_with(&["one @home", "two", "three @home", "four"], 80, 10);

    // Rows: None header, two, four, home header, one, three.
    assert_eq!(cursor_text(&app).as_deref(), Some("two"));
    nav::move_context(&mut app, 1, true);
    assert_eq!(cursor_text(&app).as_deref(), Some("one @home"));
    assert_eq!(app.range, [TodoId::new(1), TodoId::new(3), TodoId::new(0)]);
    assert_eq!(app.anchor, Some(TodoId::new(1)));
}

#[test]
fn page_keys_move_five_todo_rows() {
    let lines: Vec<String> = (1..=12).map(|n| format!("item {n:02}")).collect();
    let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
    let mut app = app_with(&refs, 80, 20);

    assert_eq!(cursor_text(&app).as_deref(), Some("item 01"));
    input::apply(&mut app, Command::PageDown);
    assert_eq!(cursor_text(&app).as_deref(), Some("item 06"));
    input::apply(&mut app, Command::PageDown);
    assert_eq!(cursor_text(&app).as_deref(), Some("item 11"));
    // The last step clamps at the final todo instead of overshooting.
    input::apply(&mut app, Command::PageDown);
    assert_eq!(cursor_text(&app).as_deref(), Some("item 12"));
    input::apply(&mut app, Command::PageUp);
    assert_eq!(cursor_text(&app).as_deref(), Some("item 07"));
}

#[test]
fn page_up_at_the_top_keeps_the_first_todo() {
    let lines: Vec<String> = (1..=12).map(|n| format!("item {n:02}")).collect();
    let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
    let mut app = app_with(&refs, 80, 20);

    input::apply(&mut app, Command::PageUp);
    assert_eq!(cursor_text(&app).as_deref(), Some("item 01"));
}

#[test]
fn shift_page_extends_the_range_by_five_rows() {
    let lines: Vec<String> = (1..=12).map(|n| format!("item {n:02}")).collect();
    let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
    let mut app = app_with(&refs, 80, 20);

    input::apply(&mut app, Command::ExtendPageDown);
    assert_eq!(cursor_text(&app).as_deref(), Some("item 06"));
    assert_eq!(app.range.len(), 6);
    assert_eq!(app.anchor, Some(TodoId::new(0)));

    input::apply(&mut app, Command::ExtendPageUp);
    assert_eq!(cursor_text(&app).as_deref(), Some("item 01"));
    assert_eq!(app.range, [TodoId::new(0)]);
}

#[test]
fn home_and_end_select_the_first_and_last_todo() {
    let mut app = app_with(&["one @home", "two", "three @home"], 80, 10);

    input::apply(&mut app, Command::End);
    assert_eq!(cursor_text(&app).as_deref(), Some("three @home"));
    assert_eq!(cursor_row(&app), Some(4));

    input::apply(&mut app, Command::Home);
    assert_eq!(cursor_text(&app).as_deref(), Some("two"));
    assert_eq!(cursor_row(&app), Some(1));
}

#[test]
fn escape_clears_the_range_and_keeps_the_cursor() {
    let mut app = app_with(&["one", "two", "three"], 80, 10);

    nav::move_cursor(&mut app, 2, true);
    assert_eq!(app.range.len(), 3);
    let cursor = app.cursor;

    input::apply(&mut app, Command::ClearRange);
    assert!(app.range.is_empty());
    assert_eq!(app.anchor, None);
    assert_eq!(app.cursor, cursor);
}

#[test]
fn an_empty_list_never_produces_a_cursor() {
    let mut app = app_with(&[], 80, 10);

    assert!(app.rows().is_empty());
    assert_eq!(app.cursor, None);
    nav::move_cursor(&mut app, 1, false);
    nav::move_cursor(&mut app, -1, true);
    nav::select_first(&mut app);
    nav::select_last(&mut app);
    nav::move_context(&mut app, 1, false);
    assert_eq!(app.cursor, None);
    assert!(app.range.is_empty());
}
