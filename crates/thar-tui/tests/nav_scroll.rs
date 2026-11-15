//! Scroll parity: `calculateScrollOffset` with range selection and padding.
//!
//! The expected offsets are worked out from the TypeScript rule, not copied
//! from the Rust helper: a 120x40 terminal leaves 38 list rows (two action-bar
//! rows), the `"None"` header is row 0, and the viewport keeps one row of
//! padding below (or above) the cursor when the range allows it.

use thar_core::{Todo, TodoDate, TodoId};
use thar_tui::{App, input, nav};

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

fn tasks(count: usize) -> Vec<String> {
    (1..=count).map(|n| format!("task {n:02}")).collect()
}

fn with_tasks(count: usize, width: u16, height: u16) -> App {
    let lines = tasks(count);
    let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
    app_with(&refs, width, height)
}

fn cursor_row(app: &App) -> usize {
    app.cursor.and_then(|id| app.row_for(id)).expect("cursor")
}

#[test]
fn one_row_padding_is_kept_at_the_bottom_of_a_120x40_list() {
    let mut app = with_tasks(60, 120, 40);
    assert_eq!(app.visible_height(), 38);
    assert_eq!(app.rows().len(), 61);
    assert_eq!(app.offset, 0);

    // Row 37 is the last row that fits below the cursor plus padding: the
    // offset moves to 1, leaving exactly one row under the cursor.
    for _ in 0..36 {
        nav::move_cursor(&mut app, 1, false);
    }
    assert_eq!(cursor_row(&app), 37);
    assert_eq!(app.offset, 1);
    assert_eq!(app.offset + app.visible_height() - 1 - cursor_row(&app), 1);

    nav::select_last(&mut app);
    assert_eq!(cursor_row(&app), 60);
    assert_eq!(app.offset, app.max_offset());
    assert_eq!(app.offset, 23);

    nav::select_first(&mut app);
    assert_eq!(cursor_row(&app), 1);
    assert_eq!(app.offset, 0);
}

#[test]
fn padding_above_the_cursor_scrolls_the_offset_back() {
    let mut app = with_tasks(60, 120, 40);

    app.offset = 10;
    nav::select_row(&mut app, 10, false);
    assert_eq!(app.offset, 9);

    app.offset = 10;
    nav::select_row(&mut app, 48, false);
    assert_eq!(app.offset, 12);
    assert_eq!(app.offset + app.visible_height() - 1 - 48, 1);
}

#[test]
fn a_range_that_fits_stays_fully_visible() {
    let mut app = with_tasks(60, 120, 40);

    nav::select_row(&mut app, 1, false);
    for _ in 0..40 {
        nav::move_cursor(&mut app, 1, false);
    }
    assert_eq!(cursor_row(&app), 41);
    assert_eq!(app.offset, 5);

    for _ in 0..5 {
        nav::move_cursor(&mut app, 1, true);
    }
    assert_eq!(cursor_row(&app), 46);
    assert_eq!(app.range.len(), 6);
    assert_eq!(app.offset, 10);
    for row in 41..=46 {
        assert!(
            (app.offset..app.offset + app.visible_height()).contains(&row),
            "row {row} outside {}..{}",
            app.offset,
            app.offset + app.visible_height()
        );
    }
}

#[test]
fn a_range_larger_than_the_viewport_keeps_the_cursor_visible() {
    let mut app = with_tasks(60, 120, 40);

    nav::select_row(&mut app, 1, false);
    for _ in 0..40 {
        nav::move_cursor(&mut app, 1, true);
    }
    assert_eq!(cursor_row(&app), 41);
    assert_eq!(app.range.len(), 41);
    assert!(app.range.len() > app.visible_height());
    // The range cannot fit, so the cursor wins, still with one row below it.
    assert_eq!(app.offset, 5);
    assert_eq!(app.offset + app.visible_height() - 1 - cursor_row(&app), 1);
}

#[test]
fn the_visible_height_follows_the_search_bar() {
    let mut app = with_tasks(60, 120, 40);

    app.set_query("task");
    assert_eq!(app.visible_height(), 36);

    nav::select_last(&mut app);
    assert_eq!(app.offset, 61 - 36);
    assert_eq!(app.offset, app.max_offset());
}

#[test]
fn tiny_terminals_clamp_without_panicking() {
    for height in 1..=4 {
        let mut app = with_tasks(5, 120, height);

        nav::select_last(&mut app);
        assert_eq!(app.cursor, Some(TodoId::new(4)), "height {height}");
        assert!(app.offset <= app.max_offset(), "height {height}");

        nav::select_first(&mut app);
        assert_eq!(app.cursor, Some(TodoId::new(0)), "height {height}");
        assert!(app.offset <= app.max_offset(), "height {height}");
    }
}

#[test]
fn a_one_row_list_scrolls_to_the_last_row() {
    // 120x3: two chrome rows outside the list, so exactly one list row is
    // visible (the action bar overlaps the border row).
    let mut app = with_tasks(5, 120, 3);
    assert_eq!(app.visible_height(), 1);

    nav::select_last(&mut app);
    assert_eq!(cursor_row(&app), 5);
    assert_eq!(app.offset, 5);
    assert_eq!(app.offset, app.max_offset());
}

#[test]
fn focusing_or_blurring_search_reflows_the_cursor_into_the_list() {
    // 80x10 has 8 list rows; the two-row search bar leaves 6. Reflowing only
    // the old offset would leave the last row two rows below the viewport.
    let mut app = with_tasks(40, 80, 10);
    nav::select_last(&mut app);
    let row = cursor_row(&app);
    assert!(row < app.offset + app.visible_height());

    input::apply(&mut app, input::Command::SearchFocus);
    assert_eq!(app.visible_height(), 6);
    let row = cursor_row(&app);
    assert!(
        row >= app.offset && row < app.offset + app.visible_height(),
        "row {row} is outside {}..{}",
        app.offset,
        app.offset + app.visible_height()
    );

    input::apply(&mut app, input::Command::SearchBlur);
    assert_eq!(app.visible_height(), 8);
    let row = cursor_row(&app);
    assert!(row >= app.offset && row < app.offset + app.visible_height());
}

#[test]
fn a_zero_row_list_leaves_the_offset_alone() {
    // 120x2 has no list row at all; navigation still moves the cursor but the
    // viewport has nothing to scroll.
    let mut app = with_tasks(5, 120, 2);
    assert_eq!(app.visible_height(), 0);

    nav::select_last(&mut app);
    assert_eq!(cursor_row(&app), 5);
    assert_eq!(app.offset, 0);
    assert!(app.visible_rows().is_empty());
}
