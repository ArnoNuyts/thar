//! Centred modal geometry and hit-testing.
//!
//! The Ink modal is a 50%-wide (or fixed-width) box with three chrome rows
//! above the body (outer padding, title, body padding) and two below. Mouse
//! coordinates are 1-based terminal cells, the same convention the base layout
//! and `input::handle_mouse` use.
//!
//! The functions here are pure and independent of the active screen, so a
//! screen's mouse test and the renderer read the same rectangle.

use ratatui::layout::Rect;

use crate::input::MouseInput;

/// Rows above the body: outer padding, the title row, and body padding.
pub const TOP_CHROME: u16 = 3;
/// Rows below the body: body padding and outer padding.
pub const BOTTOM_CHROME: u16 = 2;

/// Width of a modal.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModalWidth {
    /// A percentage of the terminal width, clamped to at least one cell.
    Percent(u16),
    /// A fixed number of cells.
    Cells(u16),
}

impl ModalWidth {
    /// Resolve the width for a terminal `available` cells wide.
    #[must_use]
    pub fn resolve(self, available: u16) -> u16 {
        match self {
            Self::Percent(percent) => {
                let width = u32::from(available) * u32::from(percent) / 100;
                u16::try_from(width).unwrap_or(available).max(1)
            }
            Self::Cells(cells) => cells.max(1),
        }
    }
}

/// The resolved rectangle of one modal.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ModalRect {
    /// The whole modal box, including chrome.
    pub area: Rect,
    /// The body rows, where the screen draws.
    pub body: Rect,
}

/// Resolve a centred modal rectangle inside `terminal`.
#[must_use]
pub fn resolve(terminal: Rect, width: ModalWidth, body_rows: u16) -> ModalRect {
    let modal_width = width.resolve(terminal.width).min(terminal.width.max(1));
    let height = TOP_CHROME
        .saturating_add(body_rows)
        .saturating_add(BOTTOM_CHROME)
        .min(terminal.height.max(1));

    let left = terminal.width.saturating_sub(modal_width).saturating_div(2);
    // The Ink box puts the spare row above when the free space is odd.
    let top = terminal
        .height
        .saturating_sub(height)
        .saturating_add(1)
        .saturating_div(2);

    let area = Rect::new(
        terminal.x.saturating_add(left),
        terminal.y.saturating_add(top),
        modal_width,
        height,
    );
    let body_height = height.saturating_sub(TOP_CHROME + BOTTOM_CHROME);
    let body = Rect::new(
        area.x,
        area.y.saturating_add(TOP_CHROME),
        area.width,
        body_height.min(body_rows),
    );
    ModalRect { area, body }
}

/// Body-relative row for a 1-based mouse row, if it lands on a body row.
#[must_use]
pub fn body_row(rect: ModalRect, mouse: MouseInput) -> Option<u16> {
    let y = mouse.y.checked_sub(1)?;
    let start = rect.body.y;
    let end = rect.body.y.saturating_add(rect.body.height);
    (start..end).contains(&y).then_some(y.saturating_sub(start))
}

/// Body-relative zero-based column for a 1-based mouse column.
#[must_use]
pub fn body_column(rect: ModalRect, mouse: MouseInput) -> Option<u16> {
    let x = mouse.x.checked_sub(1)?;
    let start = rect.body.x;
    let end = rect.body.x.saturating_add(rect.body.width);
    (start..end).contains(&x).then_some(x.saturating_sub(start))
}

/// True when the mouse is inside the modal box.
#[must_use]
pub fn contains(rect: ModalRect, mouse: MouseInput) -> bool {
    let x = mouse.x.saturating_sub(1);
    let y = mouse.y.saturating_sub(1);
    rect.area.contains(ratatui::layout::Position::new(x, y))
}

#[cfg(test)]
mod tests {
    use super::{ModalWidth, TOP_CHROME, body_column, body_row, resolve};
    use crate::input::{MouseInput, MouseKind};
    use ratatui::layout::Rect;

    fn mouse(x: u16, y: u16) -> MouseInput {
        MouseInput {
            kind: MouseKind::LeftClick,
            x,
            y,
            shift: false,
        }
    }

    #[test]
    fn percent_widths_and_centring_match_the_ink_box() {
        let rect = resolve(Rect::new(0, 0, 100, 30), ModalWidth::Percent(50), 6);
        assert_eq!(rect.area.width, 50);
        assert_eq!(rect.area.x, 25);
        // 3 + 6 + 2 = 11 rows; (30 - 11 + 1) / 2 = 10.
        assert_eq!(rect.area.height, 11);
        assert_eq!(rect.area.y, 10);
        assert_eq!(rect.body.y, 10 + TOP_CHROME);
        assert_eq!(rect.body.height, 6);
    }

    #[test]
    fn fixed_widths_and_tiny_terminals_are_clamped() {
        let rect = resolve(Rect::new(0, 0, 10, 4), ModalWidth::Cells(40), 20);
        assert_eq!(rect.area.width, 10);
        assert_eq!(rect.area.height, 4);
        assert!(rect.body.height <= rect.area.height);
    }

    #[test]
    fn body_hit_testing_uses_one_based_coordinates() {
        let rect = resolve(Rect::new(0, 0, 100, 30), ModalWidth::Percent(50), 6);
        let first = mouse(rect.body.x + 1, rect.body.y + 1);
        assert_eq!(body_row(rect, first), Some(0));
        assert_eq!(body_column(rect, first), Some(0));
        assert_eq!(body_row(rect, mouse(1, 1)), None);
    }
}
