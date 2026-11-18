//! Screen geometry shared by rendering, mouse hit-testing, and navigation.
//!
//! The Ink layout is a single column: an optional search bar (two rows, content
//! plus a bottom border), the list, and a two-row action bar (top border plus
//! content). The list's last column is the scrollbar when it is scrollable.
//! Mouse row coordinates are terminal rows (crossterm reports 0-based cells;
//! the host adds one), so every
//! conversion lives here and is pinned by tests: the row-model `"None"` header
//! counts as a list row, and a click must land on the same row the renderer
//! drew.
//!
//! Overlays (suggestion popups and modals) own their own hit-test registries
//! in `view/overlay.rs` and `modal/geometry.rs` rather than changing these
//! base rows.

use crate::input::Command;
use crate::modal::ModalId;

/// Rows occupied by the action bar: its top border and its content row.
pub const ACTION_BAR_HEIGHT: u16 = 2;
/// Rows occupied by the search bar: its content row and its bottom border.
pub const SEARCH_BAR_HEIGHT: u16 = 2;
/// Width of the scrollbar column.
pub const SCROLLBAR_WIDTH: u16 = 1;
/// Action-bar items in render order: `(key, label, command)`.
///
/// The renderer, the click hit-test and the command dispatch all read this
/// table, so a label change cannot silently move the clickable region and a
/// click cannot fall through on a mistyped key.
pub const ACTION_ITEMS: [(&str, &str, Command); 5] = [
    // The Menu item opens the single- or multi-select screen depending on the
    // active range; `input::left_click` resolves it with `menu_for`.
    ("x", "Menu", Command::Open(ModalId::TodoMenu)),
    ("q", "Quit", Command::Quit),
    ("n", "New", Command::Open(ModalId::CreateTodo)),
    ("e", "Edit", Command::Open(ModalId::EditTodo)),
    ("/", "Search", Command::SearchFocus),
];
/// Width of one action-bar item including its surrounding spaces.
pub const fn action_item_width(key: &str, label: &str) -> u16 {
    (key.len() + label.len() + 4) as u16
}

/// The resolved rows and columns for one frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Layout {
    /// Full terminal width.
    pub width: u16,
    /// Full terminal height.
    pub height: u16,
    /// First list row on the screen (0-based).
    pub list_top: u16,
    /// Number of list rows that fit.
    pub list_height: u16,
    /// Width available to list content, excluding the scrollbar column.
    pub list_width: u16,
    /// Screen row of the action bar's top border.
    pub action_top: u16,
    /// Screen column of the scrollbar.
    pub scrollbar_x: u16,
    /// True when the search bar occupies the top two rows.
    pub search_visible: bool,
}

impl Layout {
    /// Resolve the layout for a terminal size.
    #[must_use]
    pub fn new(width: u16, height: u16, search_visible: bool) -> Self {
        let search_rows = if search_visible {
            SEARCH_BAR_HEIGHT.min(height)
        } else {
            0
        };
        let action_top = height.saturating_sub(ACTION_BAR_HEIGHT);
        let list_top = search_rows;
        let list_height = action_top.saturating_sub(list_top);

        Self {
            width,
            height,
            list_top,
            list_height,
            list_width: width.saturating_sub(SCROLLBAR_WIDTH),
            action_top,
            scrollbar_x: width.saturating_sub(SCROLLBAR_WIDTH),
            search_visible,
        }
    }

    /// Screen row of the search bar's content line.
    #[must_use]
    pub const fn search_row(&self) -> u16 {
        0
    }

    /// Screen row of the search bar's bottom border.
    #[must_use]
    pub const fn search_border_row(&self) -> u16 {
        1
    }

    /// Screen row of the action bar's content line.
    #[must_use]
    pub const fn action_row(&self) -> u16 {
        self.action_top.saturating_add(1)
    }

    /// List-relative row for a 0-based screen row, if the row is inside the
    /// list.
    #[must_use]
    pub fn row_at(&self, screen_y: u16) -> Option<usize> {
        let relative = screen_y.checked_sub(self.list_top)?;
        (relative < self.list_height).then_some(relative as usize)
    }

    /// Screen row for a list-relative row.
    #[must_use]
    pub fn screen_row(&self, list_row: usize) -> u16 {
        self.list_top
            .saturating_add(u16::try_from(list_row).unwrap_or(u16::MAX))
    }
}

/// First and last 0-based columns of the `[x]` checkbox on a todo row.
///
/// A row starts with `" " + padded number + " "`, which is `max_digits + 2`
/// columns, and the checkbox is three columns wide. The Ink list computes the
/// same window to decide whether a double-click toggled the checkbox.
#[must_use]
pub fn checkbox_columns(max_digits: usize) -> core::ops::RangeInclusive<u16> {
    let start = u16::try_from(max_digits)
        .unwrap_or(u16::MAX)
        .saturating_add(2);
    start..=start.saturating_add(2)
}

/// The action-bar command at an 0-based screen column, if any.
///
/// The Ink bar lays items out from column 1 (1-based) with the segment
/// `" <key> <label>  "`; this maps the same regions to 0-based columns.
#[must_use]
pub fn action_item_at(column: u16) -> Option<Command> {
    let mut start = 0_u16;
    for (key, label, command) in ACTION_ITEMS {
        let width = action_item_width(key, label);
        if (start..start + width).contains(&column) {
            return Some(command);
        }
        start = start.saturating_add(width);
    }
    None
}

/// Lays out the row prefix exactly as the renderer does: a space, the number
/// right-aligned to `max_digits`, a space, then `[ ]` or `[x]`.
#[must_use]
pub fn todo_prefix(number: usize, max_digits: usize, done: bool) -> String {
    let checkbox = if done { "[x]" } else { "[ ]" };
    format!(" {number:>max_digits$} {checkbox} ")
}

#[cfg(test)]
mod tests {
    use super::{Layout, checkbox_columns, todo_prefix};

    #[test]
    fn list_sits_between_the_search_bar_and_action_bar() {
        let layout = Layout::new(120, 40, false);
        assert_eq!(layout.list_top, 0);
        assert_eq!(layout.list_height, 38);
        assert_eq!(layout.action_top, 38);
        assert_eq!(layout.action_row(), 39);
        assert_eq!(layout.scrollbar_x, 119);

        let with_search = Layout::new(120, 40, true);
        assert_eq!(with_search.list_top, 2);
        assert_eq!(with_search.list_height, 36);
        assert_eq!(with_search.action_top, 38);
        assert_eq!(with_search.row_at(0), None);
        assert_eq!(with_search.row_at(1), None);
        assert_eq!(with_search.row_at(2), Some(0));
        assert_eq!(with_search.row_at(37), Some(35));
        assert_eq!(with_search.row_at(38), None);
    }

    #[test]
    fn tiny_terminals_never_underflow() {
        for height in 0..=4 {
            for width in 0..=2 {
                let layout = Layout::new(width, height, true);
                assert!(layout.list_height <= height);
                assert!(layout.action_top <= height);
                assert!(layout.scrollbar_x <= width);
            }
        }
    }

    #[test]
    fn checkbox_columns_follow_the_row_prefix() {
        // one digit: " 1 [ ] " -> checkbox starts at column 2 (0-based)
        assert_eq!(checkbox_columns(1), 3..=5);
        // three digits: " 100 [ ] " -> checkbox starts at column 4
        assert_eq!(checkbox_columns(3), 5..=7);
    }

    #[test]
    fn todo_prefix_is_the_rendered_prefix() {
        assert_eq!(todo_prefix(1, 1, false), " 1 [ ] ");
        assert_eq!(todo_prefix(7, 3, true), "   7 [x] ");
    }

    #[test]
    fn action_items_cover_the_rendered_segments() {
        use super::{ACTION_ITEMS, action_item_at, action_item_width};
        use crate::input::Command;
        use crate::modal::ModalId;

        let widths: Vec<u16> = ACTION_ITEMS
            .iter()
            .map(|(key, label, _)| action_item_width(key, label))
            .collect();
        assert_eq!(widths, [9, 9, 8, 9, 11]);
        assert_eq!(action_item_at(0), Some(Command::Open(ModalId::TodoMenu)));
        assert_eq!(action_item_at(8), Some(Command::Open(ModalId::TodoMenu)));
        assert_eq!(action_item_at(9), Some(Command::Quit));
        assert_eq!(action_item_at(44), Some(Command::SearchFocus));
        assert_eq!(action_item_at(45), Some(Command::SearchFocus));
        assert_eq!(action_item_at(46), None);
    }
}
