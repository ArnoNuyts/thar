//! Selection and scroll transitions.
//!
//! These are the native equivalents of the pure helpers in
//! `logic/navigation.ts` (and `thar-core::nav`), expressed over the owned
//! [`ListRow`] model. The row model is the navigation model: context headers
//! are skipped by row stepping, and they count for the viewport and for mouse
//! hit-testing.
//!
//! This module has no terminal or clock dependency; the event loop and the
//! tests drive it with plain calls.

use thar_core::TodoId;

use crate::app::App;
use crate::list::ListRow;

/// Scroll padding kept around the cursor when the list scrolls, matching
/// `calculateScrollOffset`'s one-row padding.
pub const SCROLL_PADDING: usize = 1;

/// Select the todo at `row`, optionally extending the shift-selection.
pub fn select_row(app: &mut App, row: usize, shift: bool) {
    let Some(entry) = app.rows().get(row) else {
        return;
    };
    let Some(todo_index) = entry.todo_index() else {
        return;
    };
    let Some(id) = app.todo_at(todo_index).map(|todo| todo.id) else {
        return;
    };

    if shift {
        let anchor = app.anchor.unwrap_or_else(|| app.cursor.unwrap_or(id));
        app.anchor = Some(anchor);
        app.range = range_between(app, anchor, id);
    } else {
        app.anchor = None;
        app.range.clear();
    }

    app.cursor = Some(id);
    ensure_visible(app, row);
}

/// Move `step` rows, skipping context headers.
pub fn move_cursor(app: &mut App, step: isize, shift: bool) {
    let Some(current) = app.cursor.and_then(|id| app.row_for(id)) else {
        if let Some(first) = app.first_todo_id() {
            app.cursor = Some(first);
            if let Some(row) = app.row_for(first) {
                ensure_visible(app, row);
            }
        }
        return;
    };

    let Some(row) = navigable_row(app, current, step) else {
        return;
    };
    select_row(app, row, shift);
}

/// Move to the first todo row.
pub fn select_first(app: &mut App) {
    if let Some(id) = app.first_todo_id()
        && let Some(row) = app.row_for(id)
    {
        select_row(app, row, false);
    }
}

/// Move to the last todo row.
pub fn select_last(app: &mut App) {
    if let Some(id) = app.last_todo_id()
        && let Some(row) = app.row_for(id)
    {
        select_row(app, row, false);
    }
}

/// Move to the first todo of the next (`direction = 1`) or previous (`-1`)
/// context group. The first group's first todo is the fallback for a cursor
/// that is already above the first header.
pub fn move_context(app: &mut App, direction: isize, shift: bool) {
    let Some(current) = app.cursor.and_then(|id| app.row_for(id)) else {
        return;
    };

    let Some(header) = app.rows()[..=current]
        .iter()
        .rposition(|row| !row.is_todo())
    else {
        return;
    };

    let target_header = if direction > 0 {
        app.rows()
            .iter()
            .enumerate()
            .skip(header + 1)
            .find(|(_, row)| !row.is_todo())
            .map(|(index, _)| index)
    } else {
        app.rows()[..header].iter().rposition(|row| !row.is_todo())
    };

    let Some(target_header) = target_header else {
        return;
    };

    let target = app.rows()[target_header + 1..]
        .iter()
        .position(|row| row.is_todo())
        .map(|offset| target_header + 1 + offset);

    if let Some(row) = target {
        select_row(app, row, shift);
    }
}

/// Scroll the viewport by one row without moving the cursor.
pub fn scroll(app: &mut App, direction: isize) {
    let max = app.max_offset();
    let next = if direction < 0 {
        app.offset.saturating_sub(1)
    } else {
        app.offset.saturating_add(1).min(max)
    };
    app.offset = next;
}

/// Clear a shift-selection, keeping the cursor.
pub fn clear_range(app: &mut App) {
    app.anchor = None;
    app.range.clear();
}

/// Row reached by stepping from `current`, skipping headers; crossing a
/// boundary falls back to the first/last todo row.
fn navigable_row(app: &App, current: usize, step: isize) -> Option<usize> {
    if app.rows().is_empty() {
        return None;
    }

    let last = app.rows().len() - 1;
    let direction: isize = if step > 0 { 1 } else { -1 };
    let mut row = current.saturating_add_signed(step).min(last);

    while !app.rows().get(row).is_some_and(ListRow::is_todo) {
        let next = row.checked_add_signed(direction);
        match next {
            Some(next) if next <= last => row = next,
            _ => {
                return if direction < 0 {
                    app.rows().iter().position(ListRow::is_todo)
                } else {
                    app.rows().iter().rposition(ListRow::is_todo)
                };
            }
        }
    }

    Some(row)
}

/// All todo ids between two ids (inclusive), following row order.
fn range_between(app: &App, left: TodoId, right: TodoId) -> Vec<TodoId> {
    let Some(left_row) = app.row_for(left) else {
        return Vec::new();
    };
    let Some(right_row) = app.row_for(right) else {
        return Vec::new();
    };
    let (start, end) = if left_row <= right_row {
        (left_row, right_row)
    } else {
        (right_row, left_row)
    };

    app.rows()[start..=end]
        .iter()
        .filter_map(|row| row.todo_index())
        .filter_map(|index| app.todo_at(index))
        .map(|todo| todo.id)
        .collect()
}

/// Keep `row` visible with one row of padding where possible.
fn ensure_visible(app: &mut App, row: usize) {
    let height = app.visible_height();
    if height == 0 {
        return;
    }
    let padding = SCROLL_PADDING.min(height / 2);

    if row < app.offset + padding {
        app.offset = row.saturating_sub(padding);
    } else if row + padding >= app.offset + height {
        app.offset = (row + padding + 1).saturating_sub(height);
    }
    app.clamp_offset();
}

#[cfg(test)]
mod tests {
    use super::{
        clear_range, move_context, move_cursor, scroll, select_first, select_last, select_row,
    };
    use crate::app::App;
    use thar_core::{Todo, TodoDate, TodoId};

    fn app(lines: &[&str]) -> App {
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
        app.resize(80, 10);
        app
    }

    fn cursor_line(app: &App) -> Option<String> {
        app.selected_todo().map(|todo| todo.text.clone())
    }

    #[test]
    fn initial_cursor_is_the_first_visible_todo() {
        assert_eq!(cursor_line(&app(&["one", "two"])).as_deref(), Some("one"));
    }

    #[test]
    fn arrow_steps_skip_headers_and_clamp_at_the_ends() {
        let mut app = app(&["one @home", "two", "three @home"]);
        // Sort order: None group (two) first, then the home group.
        // Rows: None header, two, home header, one, three.
        assert_eq!(cursor_line(&app).as_deref(), Some("two"));
        move_cursor(&mut app, 1, false);
        assert_eq!(cursor_line(&app).as_deref(), Some("one @home"));
        move_cursor(&mut app, 1, false);
        assert_eq!(cursor_line(&app).as_deref(), Some("three @home"));
        move_cursor(&mut app, 1, false);
        assert_eq!(cursor_line(&app).as_deref(), Some("three @home"));
        move_cursor(&mut app, -1, false);
        move_cursor(&mut app, -1, false);
        move_cursor(&mut app, -1, false);
        assert_eq!(cursor_line(&app).as_deref(), Some("two"));
    }

    #[test]
    fn shift_selection_is_contiguous_over_todo_rows() {
        let mut app = app(&["one @home", "two", "three @home"]);
        select_first(&mut app);
        move_cursor(&mut app, 1, true);
        assert_eq!(app.selected_todos().len(), 2);
        assert_eq!(app.anchor, Some(TodoId::new(1)));
        clear_range(&mut app);
        assert_eq!(app.selected_todos().len(), 1);
    }

    #[test]
    fn context_moves_land_on_the_first_todo_of_the_group() {
        let mut app = app(&["one @home", "two", "three @home"]);
        select_first(&mut app);
        assert_eq!(cursor_line(&app).as_deref(), Some("two"));
        move_context(&mut app, 1, false);
        assert_eq!(cursor_line(&app).as_deref(), Some("one @home"));
        move_context(&mut app, -1, false);
        assert_eq!(cursor_line(&app).as_deref(), Some("two"));
    }

    #[test]
    fn home_and_end_are_the_first_and_last_todo_rows() {
        let mut app = app(&["one @home", "two", "three @home"]);
        select_last(&mut app);
        assert_eq!(cursor_line(&app).as_deref(), Some("three @home"));
        select_first(&mut app);
        assert_eq!(cursor_line(&app).as_deref(), Some("two"));
    }

    #[test]
    fn cursor_scrolling_keeps_padding() {
        let mut app = app(&["a", "b", "c", "d", "e", "f", "g", "h"]);
        while cursor_line(&app).as_deref() != Some("h") {
            move_cursor(&mut app, 1, false);
        }
        assert_eq!(app.offset, 1);
        scroll(&mut app, -1);
        assert_eq!(app.offset, 0);
    }

    #[test]
    fn shift_click_on_a_header_does_nothing() {
        let mut app = app(&["one @home"]);
        select_row(&mut app, 0, true);
        assert_eq!(app.selected_todos().len(), 1);
    }
}
