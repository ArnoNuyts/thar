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
use ratatui::layout::{Alignment, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::Span;
use ratatui::widgets::Paragraph;

use crate::event::MouseInput;
use crate::modal::geometry::{self, ModalRect};
use crate::theme;

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

    let count = u16::try_from(labels.len()).unwrap_or(u16::MAX);
    let left = rect.body.x.saturating_add(1);
    let width = rect.body.width.saturating_sub(2);
    let slice = width / count;

    for (index, label) in labels.iter().enumerate() {
        let active = selected == index || hovered == Some(index);
        let rendered = if active {
            format!("« {label} »")
        } else {
            format!("‹ {label} ›")
        };
        let offset = u16::try_from(index)
            .unwrap_or(u16::MAX)
            .saturating_mul(slice);
        let slot = if index + 1 == labels.len() {
            width.saturating_sub(offset)
        } else {
            slice
        };
        let area = Rect::new(left.saturating_add(offset), y, slot, 1);
        if area.width == 0 {
            continue;
        }

        // A decorated label that does not fit falls back to the bare label; a
        // tiny terminal clips rather than painting over the frame.
        let text = if u16::try_from(rendered.chars().count()).unwrap_or(u16::MAX) <= slot {
            rendered
        } else {
            (*label).to_owned()
        };
        let text: String = text.chars().take(usize::from(slot)).collect();
        let color = if hovered == Some(index) {
            theme::WARNING
        } else if selected == index {
            theme::FOREGROUND
        } else {
            theme::MUTED
        };
        let style = Style::default()
            .bg(theme::MODAL_BACKGROUND)
            .fg(color)
            .add_modifier(if active {
                Modifier::BOLD
            } else {
                Modifier::empty()
            });
        frame.render_widget(
            Paragraph::new(Span::styled(text, style)).alignment(Alignment::Center),
            area,
        );
    }
}

/// The button under `mouse` when the pointer is on body row `row`.
///
/// The row is split into one equal slice per label, which is the click map as
/// well as the hover map: the whole slice is a target, not only the glyphs.
#[must_use]
pub(crate) fn hit(rect: ModalRect, row: u16, labels: &[&str], mouse: MouseInput) -> Option<usize> {
    if labels.is_empty() || geometry::body_row(rect, mouse) != Some(row) {
        return None;
    }
    let column = geometry::body_column(rect, mouse)?.saturating_sub(1);
    let width = usize::from(rect.body.width.saturating_sub(2).max(1));
    let column = usize::from(column).min(width - 1);
    Some((column * labels.len() / width).min(labels.len() - 1))
}

#[cfg(test)]
mod tests {
    use ratatui::Terminal;
    use ratatui::backend::TestBackend;
    use ratatui::layout::Rect;

    use super::hit;
    use crate::event::{MouseInput, MouseKind};
    use crate::modal::geometry::{self, ModalWidth};

    fn mouse(kind: MouseKind, x: u16, y: u16) -> MouseInput {
        MouseInput {
            kind,
            x,
            y,
            shift: false,
        }
    }

    #[test]
    fn the_row_is_split_into_equal_slices() {
        let rect = geometry::resolve(Rect::new(0, 0, 80, 24), ModalWidth::Percent(50), 5);
        let labels = ["Save", "Cancel"];
        let row = 2;
        let y = rect.body.y + row + 1;
        // Body column 0..=32 is the left slice, 33.. is the right one.
        assert_eq!(
            hit(
                rect,
                row,
                &labels,
                mouse(MouseKind::Move, rect.body.x + 1, y)
            ),
            Some(0)
        );
        assert_eq!(
            hit(
                rect,
                row,
                &labels,
                mouse(MouseKind::Move, rect.body.x + rect.body.width - 1, y)
            ),
            Some(1)
        );
        assert_eq!(hit(rect, row, &labels, mouse(MouseKind::Move, 1, y)), None);
        assert_eq!(
            hit(
                rect,
                row + 1,
                &labels,
                mouse(MouseKind::Move, rect.body.x + 1, y)
            ),
            None
        );
    }

    #[test]
    fn the_three_action_row_splits_proportionally() {
        let rect = geometry::resolve(Rect::new(0, 0, 100, 30), ModalWidth::Percent(70), 6);
        let labels = ["Update now", "Later", "Skip this version"];
        let y = rect.body.y + 5 + 1;
        let width = rect.body.width.saturating_sub(2);
        let at = |column: u16| {
            hit(
                rect,
                5,
                &labels,
                mouse(MouseKind::Move, rect.body.x + 1 + column, y),
            )
        };
        assert_eq!(at(0), Some(0));
        assert_eq!(at(width / 2), Some(1));
        assert_eq!(at(width - 1), Some(2));
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
