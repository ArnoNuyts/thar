//! Selection and scroll transitions.
//!
//! These are the native equivalents of the pure helpers in
//! `logic/navigation.ts` (and `thar-core::nav`), expressed over the owned
//! [`ListRow`] model. The row model is the navigation model: context headers
//! are skipped by row stepping, they count for the viewport, and a shift range
//! is contiguous over todo rows only. The uncategorised `"None"` header is a
//! row like any other, so every row index here already accounts for it.
//!
//! `scroll_to` is a direct use of [`thar_core::calculate_scroll_offset`], the
//! ported `calculateScrollOffset`: the offset keeps the cursor and as much of
//! the shift range as possible visible, with one row of padding.
//!
//! [`rebuild`] is the `reconcileNavState` half of
//! `hooks/useNavigationState.ts`. It is needed because the [`App`] rebuild
//! only knows how to drop a cursor, while the hook keeps the old row as an
//! anchor: the replacement cursor is the nearest visible todo forward from the
//! old row, then backward.
//!
//! This module has no terminal or clock dependency; the event loop and the
//! tests drive it with plain calls.

use std::collections::HashSet;

use thar_core::{SelectionRange, TodoId, calculate_scroll_offset};

use crate::app::App;
use crate::list::ListRow;

/// Select the todo at `row`, optionally extending the shift-selection.
///
/// Selecting without shift clears the anchor and the range, matching
/// `setSelectedTodoId(id)`. A shift selection with no anchor uses the previous
/// cursor as the anchor, so the first shift step covers both rows.
pub fn select_row(app: &mut App, row: usize, shift: bool) {
    let Some(entry) = app.rows().get(row) else {
        return;
    };
    let Some(id) = app.row_todo_id(entry) else {
        return;
    };

    if shift {
        let anchor = app
            .selection
            .anchor
            .unwrap_or_else(|| app.selection.cursor.unwrap_or(id));
        app.selection.anchor = Some(anchor);
        app.selection.range = range_between(app, anchor, id);
    } else {
        app.selection.collapse();
    }

    app.selection.cursor = Some(id);
    scroll_to(app, row);
}

/// Move `step` rows, skipping context headers.
///
/// Crossing a list boundary lands on the first (backward) or last (forward)
/// todo row, never on a header.
pub fn move_cursor(app: &mut App, step: isize, shift: bool) {
    let current = app
        .selection
        .cursor
        .and_then(|id| app.row_for(id))
        .unwrap_or(0);
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
/// context group.
///
/// The group must directly follow its header; an empty group is not entered,
/// matching the oracle's loop that stops at the next header.
pub fn move_context(app: &mut App, direction: isize, shift: bool) {
    let Some(current) = app.selection.cursor.and_then(|id| app.row_for(id)) else {
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

    if app
        .rows()
        .get(target_header + 1)
        .is_some_and(ListRow::is_todo)
    {
        select_row(app, target_header + 1, shift);
    }
}

/// Scroll the viewport by one row without moving the cursor.
///
/// The viewport is clamped to `0..=max_offset`, so a wheel event at either end
/// is a no-op.
pub fn scroll(app: &mut App, direction: isize) {
    let max = app.max_offset();
    let next = if direction < 0 {
        app.offset().saturating_sub(1)
    } else {
        app.offset().saturating_add(1).min(max)
    };
    app.set_offset(next);
}

/// Clear a shift-selection, keeping the cursor.
pub fn clear_range(app: &mut App) {
    app.selection.collapse();
}

/// Rebuild the row model after a query change and reconcile the selection.
///
/// This is the filter half of `reconcileNavState`: a cursor that is still
/// visible stays; otherwise the nearest todo forward from the old row wins,
/// then the nearest one backward. A range is cleared as a whole as soon as one
/// of its ids is filtered out, so a selection never silently shrinks.
pub fn rebuild(app: &mut App) {
    let previous = Previous::capture(app);
    app.recompute_rows();
    previous.reconcile(app);
}

/// Re-derive the scroll offset for the current viewport.
///
/// The Ink hook re-runs reconciliation whenever `listHeight` changes (focusing
/// or blurring the search bar changes it by two rows), so the caller must
/// reflow rather than only clamping the old offset. A cursor row drives the
/// range-aware [`calculate_scroll_offset`]; with no cursor the offset is simply
/// clamped.
pub fn reflow(app: &mut App) {
    match app.selection.cursor.and_then(|id| app.row_for(id)) {
        Some(row) => scroll_to(app, row),
        None => app.clamp_offset(),
    }
}

/// Navigation metadata captured before the row model is rebuilt.
struct Previous {
    cursor: Option<TodoId>,
    anchor: Option<TodoId>,
    range: Vec<TodoId>,
    row: usize,
}

impl Previous {
    fn capture(app: &App) -> Self {
        Self {
            cursor: app.selection.cursor,
            anchor: app.selection.anchor,
            range: app.selection.range.clone(),
            row: app
                .selection
                .cursor
                .and_then(|id| app.row_for(id))
                .unwrap_or(0),
        }
    }

    /// Restore the cursor and range over the rebuilt row model.
    fn reconcile(self, app: &mut App) {
        app.selection.cursor = match self.cursor {
            Some(id) if app.row_for(id).is_some() => Some(id),
            _ => validate_cursor(app, self.row),
        };

        if self.range.iter().all(|id| app.row_for(*id).is_some()) {
            app.selection.range = self.range;
            app.selection.anchor = self.anchor;
        } else {
            app.selection.collapse();
        }

        reflow(app);
    }
}

/// Fallback cursor for a list whose selection disappeared.
///
/// Port of the row half of `validateSelection`: from the old row (clamped to
/// the new row count) search forward for a todo row, then backward. The
/// oracle's hash step restores a cursor after a file reload; a filter rebuild
/// keeps the same todos, so there is nothing for it to match here.
fn validate_cursor(app: &App, last_row: usize) -> Option<TodoId> {
    let rows = app.rows();
    if rows.is_empty() {
        return None;
    }

    let target = last_row.min(rows.len() - 1);
    rows[target..]
        .iter()
        .find_map(|row| app.row_todo_id(row))
        .or_else(|| {
            rows[..target]
                .iter()
                .rev()
                .find_map(|row| app.row_todo_id(row))
        })
}

/// Row reached by stepping from `current`, skipping headers.
///
/// Port of `getNavigableRow`: a move that crosses the list boundary falls back
/// to the first (backward) or last (forward) todo row.
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

/// Keep `row` and the active shift range visible.
///
/// `calculate_scroll_offset` already includes the one-row padding and the
/// "show the whole range when it fits" rule; this wrapper only resolves the
/// range ids to row bounds. With no list rows on screen (a terminal shorter
/// than the chrome) there is nothing to scroll, so the offset is left alone.
fn scroll_to(app: &mut App, row: usize) {
    let height = app.visible_height();
    if height == 0 {
        app.clamp_offset();
        return;
    }

    let range = app.selection.range.clone();
    let selection = selection_range_rows(app, &range, row);
    let offset = calculate_scroll_offset(row, selection, app.offset(), height, app.rows().len());
    app.set_offset(offset);
}

/// First and last rows covered by `range`, always including `fallback`.
///
/// Port of `getSelectionRangeRows`: range ids that are not visible in the
/// current row model are ignored rather than treated as a position.
fn selection_range_rows(app: &App, range: &[TodoId], fallback: usize) -> SelectionRange {
    let mut selection = SelectionRange {
        min: fallback,
        max: fallback,
    };

    if range.is_empty() {
        return selection;
    }

    // A shift range can hold ten thousand ids. Hashing once keeps the scan of
    // the row model O(rows) instead of O(rows x range); the visible list is
    // usually far smaller than the range.
    let selected: HashSet<TodoId> = range.iter().copied().collect();
    for (index, row) in app.rows().iter().enumerate() {
        if let Some(id) = app.row_todo_id(row)
            && selected.contains(&id)
        {
            selection.min = selection.min.min(index);
            selection.max = selection.max.max(index);
        }
    }

    selection
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
        .filter_map(|row| app.row_todo_id(row))
        .collect()
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
            "2026-11-15".parse::<TodoDate>().expect("valid date"),
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
        assert_eq!(app.selection.anchor, Some(TodoId::new(1)));
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
        assert_eq!(app.offset(), 1);
        scroll(&mut app, -1);
        assert_eq!(app.offset(), 0);
    }

    #[test]
    fn shift_click_on_a_header_does_nothing() {
        let mut app = app(&["one @home"]);
        select_row(&mut app, 0, true);
        assert_eq!(app.selected_todos().len(), 1);
    }
}
