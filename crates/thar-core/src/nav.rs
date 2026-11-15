//! Pure navigation helpers for the row model.
//!
//! Ports the React-free half of `logic/navigation.ts` with [`TodoId`] in place
//! of JavaScript `symbol` ids. The TypeScript functions return `-1` for "no
//! row"; here that is `None`, so a caller cannot accidentally use `-1` as an
//! index.
//!
//! Not ported: `reconcileNavState`. It composes these helpers but keys its
//! cache on **object identity** (`todos !== prevTodos`, `indexes !==
//! prevIndexes`), which has no portable equivalent and no domain meaning: the
//! caller knows whether the list changed. `guesstimateSelection` itself is
//! pure once the identity short-circuit is dropped; comparing equal content
//! returns the same answer as the short-circuit.
//!
//! # Row stepping
//!
//! [`get_navigable_row`] moves `step` rows and then skips context headers in
//! the direction of travel. Crossing a list boundary lands on the first or last
//! todo row, never on a header. [`validate_selection`] keeps a stable cursor,
//! restores it by serialized hash after a reload, and otherwise falls forward
//! or backward to the nearest todo row.

use crate::model::{Todo, TodoId};
use crate::rows::Row;

/// First and last row covered by a multi-selection.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SelectionRange {
    /// Lowest selected row (the cursor row is always included).
    pub min: usize,
    /// Highest selected row (the cursor row is always included).
    pub max: usize,
}

/// `Math.max(min, Math.min(max, value))`.
pub(crate) fn clamp(value: isize, min: isize, max: isize) -> isize {
    value.min(max).max(min)
}

/// Row reached by moving `step` rows from `current_row`, skipping headers.
///
/// A move that crosses a boundary falls back to the first (backward) or last
/// (forward) todo row, or to `current_row` when the list has no todo row at
/// all. An empty row list returns `0`, matching the oracle.
#[must_use]
pub fn get_navigable_row(rows: &[Row<'_>], current_row: usize, step: isize) -> usize {
    if rows.is_empty() {
        return 0;
    }

    let last = row_index(rows.len() - 1);
    let direction = if step > 0 { 1 } else { -1 };
    let mut selected = position(clamp(row_index(current_row) + step, 0, last));

    while !rows[selected].is_todo() {
        let moved = row_index(selected) + direction;
        if moved < 0 || moved > last {
            let fallback = if direction < 0 {
                rows.iter().position(Row::is_todo)
            } else {
                rows.iter().rposition(Row::is_todo)
            };
            return fallback.unwrap_or(current_row);
        }
        selected = position(moved);
    }

    selected
}

/// First and last rows covered by `range_ids`, always including `fallback_row`.
///
/// Range ids that are not visible in `rows` are ignored, exactly like the
/// oracle.
#[must_use]
pub fn get_selection_range_rows(
    rows: &[Row<'_>],
    range_ids: &[TodoId],
    fallback_row: usize,
) -> SelectionRange {
    let mut range = SelectionRange {
        min: fallback_row,
        max: fallback_row,
    };

    if range_ids.is_empty() {
        return range;
    }

    for (index, row) in rows.iter().enumerate() {
        if let Some(id) = row.todo_id()
            && range_ids.contains(&id)
        {
            range.min = range.min.min(index);
            range.max = range.max.max(index);
        }
    }

    range
}

/// Row holding `id`, checking `last_row` first.
///
/// `last_row` is almost always the cursor row, so the fast path keeps
/// navigation O(1); the scan only runs when the row model changed underneath.
#[must_use]
pub fn find_todo_row(rows: &[Row<'_>], id: Option<TodoId>, last_row: usize) -> Option<usize> {
    let id = id?;

    if let Some(row) = rows.get(last_row)
        && row.todo_id() == Some(id)
    {
        return Some(last_row);
    }

    rows.iter().position(|row| row.todo_id() == Some(id))
}

/// Validate the cursor, returning the id to keep or its fallback.
///
/// Order: keep a cursor that is still visible; restore it by serialized hash
/// (a reload keeps ids but the list is rebuilt); otherwise take the nearest
/// todo row from `(last_row, last_row - 1, …, 0)` skipping headers.
#[must_use]
pub fn validate_selection(
    rows: &[Row<'_>],
    cursor: Option<TodoId>,
    last_hash: Option<&str>,
    last_row: usize,
) -> Option<TodoId> {
    if rows.is_empty() {
        return None;
    }

    if find_todo_row(rows, cursor, last_row).is_some() {
        return cursor;
    }

    // The oracle only uses a truthy hash, so an empty serialized line is not a
    // usable key.
    if let Some(hash) = last_hash.filter(|hash| !hash.is_empty())
        && let Some(id) = rows.iter().find_map(|row| match row {
            Row::Todo { todo, .. } if todo.hash() == hash => Some(todo.id),
            Row::Context { .. } | Row::Todo { .. } => None,
        })
    {
        return Some(id);
    }

    let target = position(clamp(row_index(last_row), 0, row_index(rows.len() - 1)));

    if let Some(id) = rows[target..].iter().find_map(Row::todo_id) {
        return Some(id);
    }

    rows[..target].iter().rev().find_map(Row::todo_id)
}

/// Guess the selection after the todo list changed.
///
/// Returns `None` to keep the current cursor. A newly added todo wins unless it
/// is already selected; otherwise a modified and no-longer-visible todo wins.
/// The TypeScript identity guard (`todos === prevTodos`) is unnecessary: equal
/// lists produce no candidates, so the result is `None` either way.
#[must_use]
pub fn guesstimate_selection(
    todos: &[Todo],
    prev_todos: &[Todo],
    rows: &[Row<'_>],
    current_cursor: Option<TodoId>,
) -> Option<TodoId> {
    let added: Vec<&Todo> = todos
        .iter()
        .filter(|todo| !prev_todos.iter().any(|previous| previous.id == todo.id))
        .collect();

    // If every todo is new, this is a reload, not an insertion: let the
    // validation path keep or restore the cursor by hash.
    if !added.is_empty() && added.len() < todos.len() {
        if current_cursor.is_some_and(|id| added.iter().any(|todo| todo.id == id)) {
            return None;
        }

        if let Some(id) = first_visible_matching(rows, &added) {
            return Some(id);
        }
    }

    let modified: Vec<&Todo> = todos
        .iter()
        .filter(|todo| {
            prev_todos
                .iter()
                .find(|previous| previous.id == todo.id)
                .is_some_and(|previous| previous.serialize() != todo.serialize())
        })
        .collect();

    if !modified.is_empty() {
        let cursor_is_valid = current_cursor.is_some_and(|id| {
            modified.iter().any(|todo| todo.id == id)
                && rows.iter().any(|row| row.todo_id() == Some(id))
        });

        if cursor_is_valid {
            return None;
        }

        return first_visible_matching(rows, &modified);
    }

    None
}

/// Scroll offset that keeps the cursor, and as much of the range as possible,
/// inside a viewport of `list_height` rows.
///
/// Port of `calculateScrollOffset`, including its one-row padding. When the
/// whole range fits, the offset is constrained to a window that shows all of
/// it; otherwise only the cursor is kept visible.
#[must_use]
pub fn calculate_scroll_offset(
    selected_row: usize,
    range: SelectionRange,
    current_offset: usize,
    list_height: usize,
    row_count: usize,
) -> usize {
    const SCROLL_PADDING: isize = 1;

    let selected = row_index(selected_row);
    let offset = row_index(current_offset);
    let height = row_index(list_height);
    let count = row_index(row_count);
    let min_row = row_index(range.min);
    let max_row = row_index(range.max);

    let cursor_min = (selected - height + 1).max(0);
    let cursor_max = selected.min((count - height).max(0));

    let target = if selected < offset + SCROLL_PADDING {
        selected - SCROLL_PADDING
    } else if selected >= offset + height - SCROLL_PADDING {
        selected - height + 1 + SCROLL_PADDING
    } else {
        offset
    };

    let range_height = max_row - min_row + 1;
    let clamped = if range_height <= height {
        // Show the whole range, but apply the cursor padding when it does not
        // hide any of it.
        let range_min_allowed = (max_row - height + 1).max(0);
        let range_max_allowed = min_row.min((count - height).max(0));
        clamp(target, range_min_allowed, range_max_allowed)
    } else {
        // The range does not fit; keep the cursor visible.
        clamp(target, cursor_min, cursor_max)
    };

    position(clamped)
}

/// First visible row whose todo is in `candidates`.
fn first_visible_matching(rows: &[Row<'_>], candidates: &[&Todo]) -> Option<TodoId> {
    rows.iter().find_map(|row| match row {
        Row::Todo { todo, .. } if candidates.iter().any(|other| other.id == todo.id) => {
            Some(todo.id)
        }
        Row::Context { .. } | Row::Todo { .. } => None,
    })
}

/// Convert a row position to the signed arithmetic type used by the oracle.
///
/// Every value is a `Vec` length or a row index derived from one, so it fits an
/// `isize` on every supported target: a `Vec` above `isize::MAX` elements cannot
/// be allocated. The cast is still checked in debug builds so a future caller
/// with synthetic input fails loudly instead of wrapping.
fn row_index(value: usize) -> isize {
    debug_assert!(
        isize::try_from(value).is_ok(),
        "row position {value} exceeds isize::MAX"
    );
    value as isize
}

/// Convert a clamped, non-negative value back to a row position.
fn position(value: isize) -> usize {
    debug_assert!(value >= 0, "row position {value} is negative");
    value as usize
}

#[cfg(test)]
mod tests {
    use super::{
        SelectionRange, calculate_scroll_offset, find_todo_row, get_navigable_row,
        get_selection_range_rows, guesstimate_selection, validate_selection,
    };
    use crate::model::{Todo, TodoId};
    use crate::rows::{Row, create_rows};

    fn todos(lines: &[&str]) -> Vec<Todo> {
        lines
            .iter()
            .enumerate()
            .map(|(index, line)| Todo::parse_line(line, TodoId::new(index as u64)))
            .collect()
    }

    fn id(value: u64) -> Option<TodoId> {
        Some(TodoId::new(value))
    }

    #[test]
    fn navigable_row_skips_headers_in_the_direction_of_travel() {
        let list = todos(&["Todo 1 @a", "Todo 2 @b"]);
        let rows = create_rows(list.iter());
        // 0 header a, 1 todo1, 2 header b, 3 todo2
        assert_eq!(get_navigable_row(&rows, 1, 1), 3);
        assert_eq!(get_navigable_row(&rows, 3, -1), 1);
    }

    #[test]
    fn navigable_row_stays_on_the_first_todo_when_a_leading_header_is_crossed() {
        let list = todos(&["Todo 1 @a", "Todo 2 @a"]);
        let rows = create_rows(list.iter());
        assert_eq!(get_navigable_row(&rows, 1, -1), 1);
        assert_eq!(get_navigable_row(&rows, 1, -5), 1);
    }

    #[test]
    fn navigable_row_stays_on_the_last_todo_when_a_trailing_header_is_crossed() {
        let list = todos(&["Todo 1 @a", "Todo 2 @b"]);
        let rows = create_rows(list.iter());
        // 0 header a, 1 todo1, 2 header b, 3 todo2; step past todo2 hits the
        // end of the list.
        assert_eq!(get_navigable_row(&rows, 3, 1), 3);
        assert_eq!(get_navigable_row(&rows, 3, 5), 3);
    }

    #[test]
    fn navigable_row_clamps_without_wrapping() {
        let list = todos(&["Todo 1 @a", "Todo 2 @a"]);
        let rows = create_rows(list.iter());
        assert_eq!(get_navigable_row(&rows, 1, -3), 1);
        assert_eq!(get_navigable_row(&rows, 2, 3), 2);
        assert_eq!(get_navigable_row(&[], 0, 1), 0);
    }

    #[test]
    fn selection_range_rows_covers_the_selected_ids() {
        let list = todos(&["one @a", "two @a", "three @b"]);
        let rows = create_rows(list.iter());
        // 0 header a, 1 one, 2 two, 3 header b, 4 three
        assert_eq!(
            get_selection_range_rows(&rows, &[TodoId::new(0), TodoId::new(2)], 1),
            SelectionRange { min: 1, max: 4 }
        );
        assert_eq!(
            get_selection_range_rows(&rows, &[], 3),
            SelectionRange { min: 3, max: 3 }
        );
        // An id that is not visible is ignored.
        assert_eq!(
            get_selection_range_rows(&rows, &[TodoId::new(99)], 2),
            SelectionRange { min: 2, max: 2 }
        );
    }

    #[test]
    fn find_todo_row_uses_the_hint_and_falls_back_to_a_scan() {
        let list = todos(&["Todo 1 @a", "Todo 2 @a"]);
        let rows = create_rows(list.iter());
        assert_eq!(find_todo_row(&rows, id(1), 2), Some(2));
        assert_eq!(find_todo_row(&rows, id(1), 0), Some(2));
        assert_eq!(find_todo_row(&rows, id(9), 1), None);
        assert_eq!(find_todo_row(&rows, None, 0), None);
    }

    #[test]
    fn validate_selection_keeps_a_valid_cursor() {
        let list = todos(&["Todo 1 @a", "Todo 2 @a"]);
        let rows = create_rows(list.iter());
        assert_eq!(validate_selection(&rows, id(1), None, 0), id(1));
        assert_eq!(validate_selection(&rows, id(1), None, 2), id(1));
        // A stale hint pointing at another todo must not win.
        assert_eq!(validate_selection(&rows, id(0), None, 2), id(0));
    }

    #[test]
    fn validate_selection_restores_by_hash_then_by_row() {
        let list = todos(&["Todo 1 @a", "Todo 2 @a"]);
        let rows = create_rows(list.iter());
        assert_eq!(validate_selection(&rows, None, Some("Todo 2 @a"), 0), id(1));
        assert_eq!(validate_selection(&rows, None, None, 0), id(0));
        assert_eq!(validate_selection(&rows, None, None, 999), id(1));
        assert_eq!(validate_selection(&rows, id(9), None, 0), id(0));
        assert_eq!(validate_selection(&[], None, None, 0), None);
    }

    #[test]
    fn validate_selection_returns_none_without_todo_rows() {
        let list: Vec<Todo> = Vec::new();
        let rows = vec![
            Row::Context {
                name: "None",
                todo_count: 0,
            },
            Row::Context {
                name: "Other",
                todo_count: 0,
            },
        ];
        assert_eq!(validate_selection(&rows, None, Some("hash"), 1), None);
        assert!(create_rows(list.iter()).is_empty());
    }

    #[test]
    fn guesstimate_prefers_a_newly_added_todo() {
        let previous = todos(&["Todo 1", "Todo 2"]);
        let mut current = previous.clone();
        current.push(Todo::parse_line("Todo 3", TodoId::new(2)));
        let mut rows = Vec::new();
        rows.extend(create_rows(current.iter()));

        assert_eq!(
            guesstimate_selection(&current, &previous, &rows, id(0)),
            id(2)
        );
        // An explicit selection of the new todo is kept.
        assert_eq!(
            guesstimate_selection(&current, &previous, &rows, id(2)),
            None
        );
    }

    #[test]
    fn guesstimate_selects_a_modified_todo_and_keeps_a_valid_cursor() {
        let previous = todos(&["Todo 1", "Todo 2"]);
        let mut current = previous.clone();
        current[0] = current[0].clone().set_text("Todo 1 updated", false);
        let rows = create_rows(current.iter());

        assert_eq!(
            guesstimate_selection(&current, &previous, &rows, id(1)),
            id(0)
        );
        assert_eq!(
            guesstimate_selection(&current, &previous, &rows, id(0)),
            None
        );
    }

    #[test]
    fn guesstimate_ignores_reloads_reorders_and_unchanged_lists() {
        let previous = todos(&["Todo 1", "Todo 2"]);

        // Every todo is new: a reload.
        let reloaded = todos(&["Todo 1", "Todo 2"]);
        let rows = create_rows(reloaded.iter());
        assert_eq!(
            guesstimate_selection(&reloaded, &previous, &rows, id(0)),
            None
        );

        // Same content, same ids: nothing changed.
        let rows = create_rows(previous.iter());
        assert_eq!(
            guesstimate_selection(&previous, &previous, &rows, id(1)),
            None
        );

        // Same ids in another order: no candidate.
        let mut reordered = previous.clone();
        reordered.reverse();
        let rows = create_rows(reordered.iter());
        assert_eq!(
            guesstimate_selection(&reordered, &previous, &rows, id(1)),
            None
        );
    }

    #[test]
    fn scroll_offset_keeps_the_offset_when_the_range_fits() {
        assert_eq!(
            calculate_scroll_offset(5, SelectionRange { min: 5, max: 5 }, 0, 10, 30),
            0
        );
    }

    #[test]
    fn scroll_offset_scrolls_to_show_a_range_larger_than_the_viewport() {
        assert_eq!(
            calculate_scroll_offset(10, SelectionRange { min: 1, max: 20 }, 0, 10, 30),
            2
        );
    }

    #[test]
    fn scroll_offset_moves_the_viewport_towards_the_cursor() {
        assert_eq!(
            calculate_scroll_offset(2, SelectionRange { min: 2, max: 2 }, 10, 10, 30),
            1
        );
        assert_eq!(
            calculate_scroll_offset(25, SelectionRange { min: 25, max: 25 }, 0, 10, 30),
            17
        );
    }

    #[test]
    fn scroll_offset_clamps_at_both_ends() {
        assert_eq!(
            calculate_scroll_offset(0, SelectionRange { min: 0, max: 0 }, 5, 10, 30),
            0
        );
        assert_eq!(
            calculate_scroll_offset(29, SelectionRange { min: 29, max: 29 }, 0, 10, 30),
            20
        );
    }

    #[test]
    fn scroll_offset_clamps_to_keep_the_whole_range_visible() {
        assert_eq!(
            calculate_scroll_offset(5, SelectionRange { min: 1, max: 5 }, 5, 10, 20),
            1
        );
        assert_eq!(
            calculate_scroll_offset(2, SelectionRange { min: 2, max: 2 }, 0, 10, 3),
            0
        );
    }
}
