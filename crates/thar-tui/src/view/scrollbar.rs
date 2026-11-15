//! The list scrollbar.
//!
//! Mirrors `components/TodoListScrollbar.tsx` exactly, because the handle
//! position is user-visible state and the PTY/golden tests pin it:
//!
//! - the track is one column wide and as tall as the list viewport;
//! - the handle is `max(1, floor(list_height² / total_rows))` rows tall;
//! - its top is `floor(clamped_offset / max_offset × (track − handle))`;
//! - the handle is drawn with `│` and the track with spaces, all in the muted
//!   colour.
//!
//! The Ink app renders the scrollbar as a sibling column, so it only takes a
//! column when the list is scrollable. [`geometry`] returns `None` in every
//! other case (not enough rows, or no viewport), and the renderer then keeps
//! the full width for row content.

use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::widgets::Paragraph;

use crate::theme;

/// One resolved scrollbar for a frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Scrollbar {
    /// Number of rows in the track.
    pub track_height: usize,
    /// Number of rows covered by the handle.
    pub handle_height: usize,
    /// First track row covered by the handle.
    pub handle_top: usize,
}

impl Scrollbar {
    /// True when the handle covers a track row.
    #[must_use]
    pub const fn covers(&self, row: usize) -> bool {
        row >= self.handle_top && row < self.handle_top + self.handle_height
    }

    /// The character drawn for one track row.
    #[must_use]
    pub const fn track_symbol(&self, row: usize) -> &'static str {
        if self.covers(row) { "│" } else { " " }
    }
}

/// Resolve the scrollbar for a row count, viewport height and first row.
///
/// Returns `None` when the list is not scrollable; the caller must then not
/// reserve a column. A zero viewport is never scrollable.
#[must_use]
pub fn geometry(total_rows: usize, list_height: usize, offset: usize) -> Option<Scrollbar> {
    if list_height == 0 || total_rows <= list_height {
        return None;
    }

    // `list_height²` fits in `u64` for every viewport a terminal can have.
    let total = u64::try_from(total_rows).unwrap_or(u64::MAX);
    let height = u64::try_from(list_height).unwrap_or(u64::MAX);
    let handle_height = usize::try_from((height * height / total).max(1)).unwrap_or(list_height);
    let handle_height = handle_height.min(list_height);

    let max_offset = total_rows - list_height;
    let handle_travel = list_height - handle_height;
    let clamped = offset.min(max_offset);
    let handle_top = if max_offset == 0 {
        0
    } else {
        usize::try_from(
            u64::try_from(clamped).unwrap_or(u64::MAX) * u64::try_from(handle_travel).unwrap_or(0)
                / u64::try_from(max_offset).unwrap_or(1),
        )
        .unwrap_or(0)
    };

    Some(Scrollbar {
        track_height: list_height,
        handle_height,
        handle_top,
    })
}

/// Draw the scrollbar in the last column of the list.
pub fn render(frame: &mut Frame, scrollbar: &Scrollbar, x: u16, y: u16) {
    let height = u16::try_from(scrollbar.track_height).unwrap_or(u16::MAX);
    if height == 0 {
        return;
    }

    let lines: Vec<Line<'_>> = (0..scrollbar.track_height)
        .map(|row| Line::from(scrollbar.track_symbol(row)))
        .collect();

    frame.render_widget(
        Paragraph::new(lines).style(Style::default().fg(theme::MUTED)),
        Rect::new(x, y, 1, height),
    );
}

#[cfg(test)]
mod tests {
    use super::{Scrollbar, geometry};

    #[test]
    fn a_short_list_has_no_scrollbar() {
        assert_eq!(geometry(0, 10, 0), None);
        assert_eq!(geometry(10, 10, 0), None);
        assert_eq!(geometry(5, 0, 0), None);
    }

    #[test]
    fn the_handle_is_at_least_one_row_and_tracks_the_offset() {
        let top = geometry(100, 10, 0).expect("scrollable");
        assert_eq!(
            top,
            Scrollbar {
                track_height: 10,
                handle_height: 1,
                handle_top: 0
            }
        );

        let bottom = geometry(100, 10, 90).expect("scrollable");
        assert_eq!(bottom.handle_top, 9);

        let middle = geometry(100, 10, 45).expect("scrollable");
        assert_eq!(middle.handle_top, 4);
    }

    #[test]
    fn the_handle_grows_with_the_viewport_ratio() {
        let scrollbar = geometry(20, 10, 0).expect("scrollable");
        assert_eq!(scrollbar.handle_height, 5);
        assert_eq!(scrollbar.handle_top, 0);

        let at_end = geometry(20, 10, 10).expect("scrollable");
        assert_eq!(at_end.handle_height, 5);
        assert_eq!(at_end.handle_top, 5);
    }

    #[test]
    fn an_offset_past_the_end_clamps() {
        let scrollbar = geometry(100, 10, 1_000).expect("scrollable");
        assert_eq!(scrollbar.handle_top, 9);
    }

    #[test]
    fn handle_rows_use_the_bar_symbol() {
        let scrollbar = geometry(20, 10, 0).expect("scrollable");
        let symbols: String = (0..scrollbar.track_height)
            .map(|row| scrollbar.track_symbol(row))
            .collect();
        assert_eq!(symbols, "│││││     ");
    }
}
