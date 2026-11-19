//! The shared `‹ Label ›` button row.
//!
//! Every screen renders its buttons through [`render`] and resolves a mouse
//! position through [`hit`], so the create/edit screen, the confirmation and
//! the update screen look the same and share the same hit map: each label owns
//! an equal slice of the content row, the active label is bold and wrapped in
//! `« … »`, and a hovered label uses the warning colour.
//!
//! This is the Rust side of `components/Button.tsx` and
//! `Button.Group equalWidth`: the row is centred and every button takes one
//! equal slice of the modal width.

use ratatui::Frame;
use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::layout::{Alignment, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::Span;
use ratatui::widgets::Paragraph;

use crate::event::{MouseInput, MouseKind};
use crate::modal::geometry::{self, ModalRect};
use crate::theme;

/// Selection and hover state for one button row.
///
/// The confirmation, update and create/edit screens all store this, so they
/// share one activation rule: Enter and Space run [`Row::selected`], and a
/// pointer hover only changes the paint. A left click still activates the
/// button under the pointer.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Row {
    /// The button Enter and Space activate.
    pub(crate) selected: usize,
    /// The button under the pointer, painted in the warning colour.
    pub(crate) hovered: Option<usize>,
}

impl Row {
    /// Apply one key press, returning the button to activate.
    ///
    /// Tab, BackTab, Left and Right move the selection and return `None`;
    /// Enter and Space return [`Row::selected`], ignoring any hover.
    pub(crate) fn on_key(&mut self, key: KeyEvent, count: usize) -> Option<usize> {
        match key.code {
            KeyCode::Tab => {
                let forward = !key.modifiers.contains(KeyModifiers::SHIFT);
                self.selected = cycle(self.selected, count, forward);
                None
            }
            KeyCode::BackTab | KeyCode::Left => {
                self.selected = cycle(self.selected, count, false);
                None
            }
            KeyCode::Right => {
                self.selected = cycle(self.selected, count, true);
                None
            }
            KeyCode::Enter | KeyCode::Char(' ') => Some(self.selected),
            _ => None,
        }
    }

    /// Apply one mouse event against body row `row`, returning the button to
    /// activate on a left click.
    ///
    /// Moves only update [`Row::hovered`]; a click sets the hover and the
    /// selection to the button under the pointer.
    pub(crate) fn on_mouse(
        &mut self,
        rect: ModalRect,
        row: u16,
        count: usize,
        mouse: MouseInput,
    ) -> Option<usize> {
        match mouse.kind {
            MouseKind::Move => {
                self.hovered = hit(rect, row, count, mouse);
                None
            }
            MouseKind::LeftClick => {
                let index = hit(rect, row, count, mouse)?;
                self.hovered = Some(index);
                self.selected = index;
                Some(index)
            }
            _ => None,
        }
    }
}

/// Move `index` by one in `count` buttons, wrapping at both ends.
///
/// Returns 0 for an empty row so callers need no separate guard.
pub(crate) fn cycle(index: usize, count: usize, forward: bool) -> usize {
    if count == 0 {
        return 0;
    }
    let index = index % count;
    if forward {
        (index + 1) % count
    } else {
        (index + count - 1) % count
    }
}

/// Offset and width of button `index` in a `width`-wide content row.
///
/// Every button takes `(width / count).max(1)` columns except the last, which
/// takes the remainder so the drawn row covers every content column. The same
/// span is used by [`render`] and [`hit`], so the paint and the hit map cannot
/// drift apart.
fn span(index: usize, count: usize, width: u16) -> (u16, u16) {
    if count == 0 {
        return (0, width);
    }
    let per_slice = u16::try_from(count).unwrap_or(u16::MAX);
    let slice = (width / per_slice).max(1);
    let offset = u16::try_from(index)
        .unwrap_or(u16::MAX)
        .saturating_mul(slice);
    let slot_width = if index + 1 == count {
        width.saturating_sub(offset)
    } else {
        slice
    };
    (offset, slot_width)
}

/// Draw one button row at body row `row`.
pub(crate) fn render(
    frame: &mut Frame,
    rect: ModalRect,
    row: u16,
    labels: &[&str],
    selected: usize,
    hovered: Option<usize>,
) {
    if labels.is_empty() {
        return;
    }
    let y = rect.body.y.saturating_add(row);
    if y >= rect.body.y.saturating_add(rect.body.height) {
        return;
    }

    let count = labels.len();
    let left = rect.body.x.saturating_add(1);
    let width = rect.body.width.saturating_sub(2);

    for (index, label) in labels.iter().enumerate() {
        let active = selected == index || hovered == Some(index);
        let rendered = if active {
            format!("« {label} »")
        } else {
            format!("‹ {label} ›")
        };
        let (offset, slot_width) = span(index, count, width);
        let area = Rect::new(left.saturating_add(offset), y, slot_width, 1);
        if area.width == 0 {
            continue;
        }

        // A decorated label that does not fit falls back to the bare label; a
        // tiny terminal clips rather than painting over the frame.
        let text = if u16::try_from(rendered.chars().count()).unwrap_or(u16::MAX) <= slot_width {
            rendered
        } else {
            (*label).to_owned()
        };
        let text: String = text.chars().take(usize::from(slot_width)).collect();
        let style = if hovered == Some(index) {
            theme::HOVER_STYLE.bg(theme::MODAL_BACKGROUND)
        } else {
            let color = if selected == index {
                theme::FOREGROUND
            } else {
                theme::MUTED
            };
            Style::default()
                .bg(theme::MODAL_BACKGROUND)
                .fg(color)
                .add_modifier(if selected == index {
                    Modifier::BOLD
                } else {
                    Modifier::empty()
                })
        };
        frame.render_widget(
            Paragraph::new(Span::styled(text, style)).alignment(Alignment::Center),
            area,
        );
    }
}

/// The button index that owns `column` in a `width`-wide content row.
///
/// The row is split into `count` slices of `(width / count).max(1)` columns;
/// the last slice extends to the end of the row, so the hit map is exactly the
/// painted slot map. Callers reject an empty row first.
fn slot(column: u16, width: u16, count: usize) -> usize {
    (0..count)
        .find(|index| {
            let (offset, slot_width) = span(*index, count, width);
            (offset..offset.saturating_add(slot_width)).contains(&column)
        })
        // A body narrower than the labels paints no cell for the last slice;
        // keep the old fallback of assigning the column to the last button.
        .unwrap_or_else(|| count.saturating_sub(1))
}

/// The button under `mouse` when the pointer is on body row `row`.
///
/// The row is split into one equal slice per label, which is the click map as
/// well as the hover map: the whole slice is a target, not only the glyphs.
#[must_use]
pub(crate) fn hit(rect: ModalRect, row: u16, count: usize, mouse: MouseInput) -> Option<usize> {
    if count == 0 || geometry::body_row(rect, mouse) != Some(row) {
        return None;
    }
    let column = geometry::body_column(rect, mouse)?.saturating_sub(1);
    Some(slot(column, rect.body.width.saturating_sub(2), count))
}

#[cfg(test)]
mod tests {
    use ratatui::Terminal;
    use ratatui::backend::TestBackend;
    use ratatui::layout::Rect;

    use super::hit;
    use crate::event::{MouseInput, MouseKind};
    use crate::modal::geometry::{self, ModalRect, ModalWidth};
    use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

    fn mouse(kind: MouseKind, x: u16, y: u16) -> MouseInput {
        MouseInput {
            kind,
            x,
            y,
            shift: false,
        }
    }

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    #[test]
    fn the_row_is_split_into_equal_slices() {
        let rect = geometry::resolve(Rect::new(0, 0, 80, 24), ModalWidth::Percent(50), 5);
        let row = 2;
        let y = rect.body.y + row + 1;
        // Body column 0..=16 is the left slice, 17.. is the right one.
        assert_eq!(
            hit(rect, row, 2, mouse(MouseKind::Move, rect.body.x + 1, y)),
            Some(0)
        );
        assert_eq!(
            hit(
                rect,
                row,
                2,
                mouse(MouseKind::Move, rect.body.x + rect.body.width - 1, y)
            ),
            Some(1)
        );
        assert_eq!(hit(rect, row, 2, mouse(MouseKind::Move, 1, y)), None);
        assert_eq!(
            hit(rect, row + 1, 2, mouse(MouseKind::Move, rect.body.x + 1, y)),
            None
        );
    }

    #[test]
    fn the_three_action_row_splits_proportionally() {
        let rect = geometry::resolve(Rect::new(0, 0, 100, 30), ModalWidth::Percent(70), 6);
        let y = rect.body.y + 5 + 1;
        let width = rect.body.width.saturating_sub(2);
        let at = |column: u16| {
            hit(
                rect,
                5,
                3,
                mouse(MouseKind::Move, rect.body.x + 1 + column, y),
            )
        };
        assert_eq!(at(0), Some(0));
        assert_eq!(at(width / 2), Some(1));
        assert_eq!(at(width - 1), Some(2));
    }

    #[test]
    fn the_hit_map_matches_the_drawn_slots_at_the_known_boundaries() {
        // (body width, label count, content column, expected button). The
        // neighbours of each boundary prove the slice edge, not just the
        // middle: 63 columns split 31/32 and 64 split 21/21/22.
        for (width, count, column, expected) in [
            (63_u16, 2_usize, 30_u16, 0_usize),
            (63, 2, 31, 1),
            (64, 3, 20, 0),
            (64, 3, 21, 1),
            (64, 3, 41, 1),
            (64, 3, 42, 2),
            (64, 3, 63, 2),
        ] {
            let rect = ModalRect {
                area: Rect::new(0, 0, width + 5, 5),
                body: Rect::new(2, 0, width + 2, 3),
            };
            let row = 1;
            assert_eq!(
                hit(
                    rect,
                    row,
                    count,
                    mouse(
                        MouseKind::Move,
                        rect.body.x + 2 + column,
                        rect.body.y + row + 1
                    )
                ),
                Some(expected),
                "width={width} count={count} column={column}"
            );
        }
    }

    #[test]
    fn cycle_wraps_in_both_directions() {
        assert_eq!(super::cycle(0, 3, true), 1);
        assert_eq!(super::cycle(2, 3, true), 0);
        assert_eq!(super::cycle(0, 3, false), 2);
        assert_eq!(super::cycle(1, 3, false), 0);
        assert_eq!(super::cycle(7, 3, true), 2);
        assert_eq!(super::cycle(0, 0, true), 0);
    }

    #[test]
    fn the_row_activates_the_keyboard_selection_not_the_hover() {
        let mut row = super::Row {
            selected: 0,
            hovered: Some(2),
        };
        assert_eq!(row.on_key(key(KeyCode::Right), 3), None);
        assert_eq!(row.selected, 1);
        assert_eq!(row.hovered, Some(2), "a keyboard move keeps the paint");
        assert_eq!(row.on_key(key(KeyCode::Enter), 3), Some(1));
        assert_eq!(row.on_key(key(KeyCode::Char(' ')), 3), Some(1));
        assert_eq!(row.on_key(key(KeyCode::BackTab), 3), None);
        assert_eq!(row.selected, 0);
        assert_eq!(row.on_key(key(KeyCode::Esc), 3), None);
    }

    #[test]
    fn the_active_label_is_bracketed_and_bold() {
        let rect = geometry::resolve(Rect::new(0, 0, 80, 24), ModalWidth::Percent(50), 5);
        let mut terminal = Terminal::new(TestBackend::new(80, 24)).expect("test terminal");
        terminal
            .draw(|frame| {
                super::render(frame, rect, 2, &["Save", "Cancel"], 0, Some(1));
            })
            .expect("draw succeeds");
        let buffer = terminal.backend().buffer();
        let y = rect.body.y + 2;
        let row: String = (rect.body.x..rect.body.x + rect.body.width)
            .map(|x| buffer[(x, y)].symbol())
            .collect();
        assert!(row.contains("« Save »"), "{row:?}");
        assert!(row.contains("« Cancel »"), "{row:?}");
        let hovered = (rect.body.x..rect.body.x + rect.body.width)
            .find(|x| buffer[(*x, y)].symbol() == "C")
            .expect("Cancel label");
        assert_eq!(buffer[(hovered, y)].style().fg, Some(crate::theme::WARNING));
    }
}
