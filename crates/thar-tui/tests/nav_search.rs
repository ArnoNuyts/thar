//! Search editing and selection reconciliation.
//!
//! Typing rebuilds the row model and then runs the `reconcileNavState` rules:
//! a still-visible cursor stays, a filtered-out cursor falls forward from its
//! old row (then backward), and a range is cleared as a whole if any of its
//! ids disappeared. Escape clears the filter and blurs; Enter blurs and keeps
//! it.

use thar_core::{Todo, TodoDate, TodoId};
use thar_tui::input::{self, Command};
use thar_tui::{App, nav};

fn app_with(lines: &[&str]) -> App {
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
    app.resize(80, 10);
    app
}

fn type_query(app: &mut App, query: &str) {
    for ch in query.chars() {
        input::apply(app, Command::SearchInsert(ch), current_time());
    }
}

fn cursor_text(app: &App) -> Option<String> {
    app.selected_todo().map(|todo| todo.text.clone())
}

fn todo_rows(app: &App) -> usize {
    app.rows().iter().filter(|row| row.is_todo()).count()
}

fn current_time() -> std::time::Instant {
    std::time::Instant::now()
}

#[test]
fn typing_filters_rows_and_keeps_a_visible_cursor() {
    let mut app = app_with(&["alpha", "beta", "gamma"]);
    assert_eq!(app.cursor(), Some(TodoId::new(0)));

    input::apply(&mut app, Command::SearchFocus, current_time());
    type_query(&mut app, "a");
    // Every todo contains an `a`, so the cursor is untouched.
    assert_eq!(app.cursor(), Some(TodoId::new(0)));
    assert_eq!(todo_rows(&app), 3);

    type_query(&mut app, "mm");
    assert_eq!(app.search().query(), "amm");
    assert_eq!(app.cursor(), Some(TodoId::new(2)));
    assert_eq!(cursor_text(&app).as_deref(), Some("gamma"));
    assert_eq!(todo_rows(&app), 1);
}

#[test]
fn a_filtered_out_cursor_falls_forward_from_its_old_row() {
    let mut app = app_with(&["apple @a", "kiwi @b", "apricot @c"]);

    // Rows: a header, apple, b header, kiwi, c header, apricot.
    nav::select_row(&mut app, 3, false);
    assert_eq!(cursor_text(&app).as_deref(), Some("kiwi @b"));

    input::apply(&mut app, Command::SearchFocus, current_time());
    type_query(&mut app, "ap");

    // The old row (3) clamps to the new last row, so `apricot` wins over the
    // earlier `apple` match: the cursor falls forward, not back to row 0.
    assert_eq!(cursor_text(&app).as_deref(), Some("apricot @c"));
    assert_eq!(app.cursor(), Some(TodoId::new(2)));
}

#[test]
fn a_filter_that_removes_every_todo_clears_the_cursor() {
    let mut app = app_with(&["alpha", "beta"]);
    nav::select_last(&mut app);

    input::apply(&mut app, Command::SearchFocus, current_time());
    type_query(&mut app, "zzz");

    assert!(app.rows().is_empty());
    assert_eq!(app.cursor(), None);
    assert_eq!(app.offset(), 0);
    assert!(app.selected_todos().is_empty());
}

#[test]
fn a_range_is_cleared_whole_when_one_id_is_filtered_out() {
    let mut app = app_with(&["alpha", "beta", "gamma", "delta"]);

    nav::move_cursor(&mut app, 2, true);
    assert_eq!(app.range().len(), 3);

    input::apply(&mut app, Command::SearchFocus, current_time());
    type_query(&mut app, "alp");

    assert_eq!(todo_rows(&app), 1);
    assert!(app.range().is_empty());
    assert_eq!(app.anchor(), None);
    assert_eq!(cursor_text(&app).as_deref(), Some("alpha"));
    assert_eq!(app.selected_todos().len(), 1);
}

#[test]
fn a_range_survives_a_filter_that_keeps_every_member() {
    let mut app = app_with(&["alpha", "beta", "gamma", "delta"]);

    nav::move_cursor(&mut app, 2, true);
    let range = app.range().to_vec();
    let anchor = app.anchor();

    input::apply(&mut app, Command::SearchFocus, current_time());
    type_query(&mut app, "a");

    assert_eq!(todo_rows(&app), 4);
    assert_eq!(app.range(), range);
    assert_eq!(app.anchor(), anchor);
}

#[test]
fn enter_blurs_and_keeps_the_filter_escape_clears_it() {
    let mut app = app_with(&["alpha", "beta", "gamma"]);

    input::apply(&mut app, Command::SearchFocus, current_time());
    type_query(&mut app, "beta");
    assert_eq!(todo_rows(&app), 1);

    input::apply(&mut app, Command::SearchBlur, current_time());
    assert!(!app.search().focused());
    assert_eq!(app.search().query(), "beta");
    assert_eq!(todo_rows(&app), 1);

    input::apply(&mut app, Command::SearchFocus, current_time());
    input::apply(&mut app, Command::SearchClear, current_time());
    assert!(!app.search().focused());
    assert_eq!(app.search().query(), "");
    assert_eq!(app.search().cursor(), 0);
    assert_eq!(todo_rows(&app), 3);
}

#[test]
fn home_and_end_navigate_the_list_while_search_is_focused() {
    let mut app = app_with(&["alpha", "beta", "gamma"]);

    input::apply(&mut app, Command::SearchFocus, current_time());
    type_query(&mut app, "a");
    assert_eq!(app.search().cursor(), 1);

    input::apply(&mut app, Command::End, current_time());
    assert_eq!(cursor_text(&app).as_deref(), Some("gamma"));
    // Home/End never move the query cursor: the search handler intercepts
    // them before the text editor.
    assert_eq!(app.search().cursor(), 1);
    assert_eq!(app.search().query(), "a");

    input::apply(&mut app, Command::Home, current_time());
    assert_eq!(cursor_text(&app).as_deref(), Some("alpha"));
    assert_eq!(app.search().cursor(), 1);
}

#[test]
fn query_cursor_editing_inserts_and_deletes_at_the_cursor() {
    let mut app = app_with(&["alpha"]);

    input::apply(&mut app, Command::SearchFocus, current_time());
    type_query(&mut app, "ga");
    input::apply(&mut app, Command::SearchLeft, current_time());
    input::apply(&mut app, Command::SearchInsert('m'), current_time());
    assert_eq!(app.search().query(), "gma");
    assert_eq!(app.search().cursor(), 2);

    input::apply(&mut app, Command::SearchLeft, current_time());
    input::apply(&mut app, Command::SearchBackspace, current_time());
    assert_eq!(app.search().query(), "ma");
    assert_eq!(app.search().cursor(), 0);

    input::apply(&mut app, Command::SearchDelete, current_time());
    assert_eq!(app.search().query(), "a");
    assert_eq!(app.search().cursor(), 0);

    // Left/Right clamp instead of wrapping.
    input::apply(&mut app, Command::SearchLeft, current_time());
    assert_eq!(app.search().cursor(), 0);
    input::apply(&mut app, Command::SearchRight, current_time());
    input::apply(&mut app, Command::SearchRight, current_time());
    assert_eq!(app.search().cursor(), 1);
}

#[test]
fn toggling_hidden_todos_reconciles_the_cursor() {
    let mut app = app_with(&["visible", "hidden h:1"]);

    assert_eq!(todo_rows(&app), 1);
    app.toggle_hidden_view();
    assert_eq!(todo_rows(&app), 2);
    assert_eq!(cursor_text(&app).as_deref(), Some("visible"));

    // Hiding again removes the cursor's row only if it was hidden; the visible
    // cursor survives. Then hide the cursor itself by selecting the hidden
    // todo and toggling back.
    nav::select_last(&mut app);
    assert_eq!(cursor_text(&app).as_deref(), Some("hidden"));
    app.toggle_hidden_view();
    assert_eq!(todo_rows(&app), 1);
    assert_eq!(cursor_text(&app).as_deref(), Some("visible"));
}

#[test]
fn search_focus_shrinks_the_list_and_keeps_the_offset_valid() {
    let lines: Vec<String> = (1..=30).map(|n| format!("task {n:02}")).collect();
    let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
    let mut app = app_with(&refs);

    nav::select_last(&mut app);
    assert!(app.offset() > 0);

    input::apply(&mut app, Command::SearchFocus, current_time());
    assert_eq!(app.visible_height(), 6);
    assert!(app.offset() <= app.max_offset());

    input::apply(&mut app, Command::SearchBlur, current_time());
    assert_eq!(app.visible_height(), 8);
    assert!(app.offset() <= app.max_offset());
}
