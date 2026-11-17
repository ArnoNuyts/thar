//! Pure scroll-offset arithmetic for the row model.
//!
//! Ports `calculateScrollOffset` from `logic/navigation.ts`. The row stepping,
//! selection validation and selection guessing helpers live in `thar-tui`'s
//! live navigation implementation; only the offset calculation is shared with
//! the native host.
//!
//! # Scroll offsets
//!
//! [`calculate_scroll_offset`] keeps the cursor, and as much of a multi-row
//! selection as possible, inside a viewport of `list_height` rows. It includes
//! the oracle's one-row padding.

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
    use super::{SelectionRange, calculate_scroll_offset};

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
