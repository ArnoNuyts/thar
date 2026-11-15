//! The overlay layer: one active modal above the list.
//!
//! The base frame is drawn by [`crate::view::render`], then this module clears
//! the modal rectangle and draws its chrome. The surrounding list stays
//! visible, matching the Ink modal (there is no backdrop dimming). Suggestion
//! popups are drawn by their owning editor workstream and sit above this layer.
//!
//! # Chrome
//!
//! The Ink `Modal` is not a box: it is a 50%-wide surface with one cell of list
//! background as padding, a thick primary bar down the left edge, and a title
//! chip with a primary background. The body sits on `COLORS.modalBackground`
//! (`#262626`); the title row and the outer padding keep the list background
//! (`#181818`). Matching that split is the difference between the old UI and a
//! generic bordered dialog.

use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Borders, Clear, Paragraph};

use crate::app::App;
use crate::modal;
use crate::theme;
use crate::view::suggestion;

/// The thick left accent bar.
const BAR: &str = "┃";

/// Draw the active modal, if any.
pub fn render(frame: &mut Frame, app: &App) {
    let Some(active) = app.modals.top() else {
        return;
    };

    let rect = modal::geometry::resolve(frame.area(), active.width(), active.body_rows());
    let area = rect.area;

    // The whole 50% box is opaque: the list background fills the outer
    // padding, exactly like the Ink box's `backgroundColor`.
    frame.render_widget(Clear, area);
    frame.render_widget(
        Block::default().style(Style::default().bg(theme::BACKGROUND)),
        area,
    );

    // The content box starts one row below the title and runs through the
    // bottom padding row. It carries the thick bar on its left edge.
    if let Some(surface) = content_surface(area) {
        frame.render_widget(
            Block::default()
                .borders(Borders::LEFT)
                .border_type(BorderType::Thick)
                .border_style(Style::default().fg(theme::PRIMARY))
                .style(
                    Style::default()
                        .bg(theme::MODAL_BACKGROUND)
                        .fg(theme::FOREGROUND),
                ),
            surface,
        );
    }

    render_title(frame, area, active.title());

    active.render(frame, rect);

    if let Some(overlay) = active.suggestion_overlay(rect) {
        suggestion::render(frame, &overlay, frame.area());
    }
}

/// The rows that belong to the content box, including its top and bottom
/// padding: everything below the title row and above the outer bottom padding.
fn content_surface(area: Rect) -> Option<Rect> {
    let width = area.width.checked_sub(2)?;
    let height = area.height.checked_sub(3)?;
    (width > 0 && height > 0).then(|| {
        Rect::new(
            area.x.saturating_add(1),
            area.y.saturating_add(2),
            width,
            height,
        )
    })
}

/// Draw the title row: the accent bar and the primary title chip.
fn render_title(frame: &mut Frame, area: Rect, title: &str) {
    if title.is_empty() || area.height < 2 || area.width < 3 {
        return;
    }

    // The title row has no content background, so the bar sits on the list
    // background rather than on the modal surface.
    frame.render_widget(
        Paragraph::new(Span::styled(
            BAR,
            Style::default().fg(theme::PRIMARY).bg(theme::BACKGROUND),
        )),
        Rect::new(area.x.saturating_add(1), area.y.saturating_add(1), 1, 1),
    );

    let text = format!(" {title} ");
    let available = area.width.saturating_sub(3);
    let width = u16::try_from(Line::from(text.as_str()).width())
        .unwrap_or(u16::MAX)
        .min(available);
    if width == 0 {
        return;
    }

    frame.render_widget(
        Paragraph::new(Span::styled(
            text,
            Style::default()
                .fg(theme::INVERSE_FOREGROUND)
                .bg(theme::PRIMARY),
        )),
        Rect::new(area.x.saturating_add(2), area.y.saturating_add(1), width, 1),
    );
}

#[cfg(test)]
mod tests {
    use super::content_surface;
    use ratatui::layout::Rect;

    #[test]
    fn the_content_surface_skips_the_outer_padding_and_title_row() {
        let area = Rect::new(20, 6, 40, 12);
        let surface = content_surface(area).expect("surface");
        assert_eq!(surface, Rect::new(21, 8, 38, 9));
    }

    #[test]
    fn a_tiny_modal_has_no_content_surface() {
        assert_eq!(content_surface(Rect::new(0, 0, 2, 4)), None);
        assert_eq!(content_surface(Rect::new(0, 0, 10, 3)), None);
    }
}
