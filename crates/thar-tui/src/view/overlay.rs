//! The overlay layer: one active modal above the list.
//!
//! The base frame is drawn by [`crate::view::render`], then this module clears
//! the modal rectangle and draws its chrome. The surrounding list stays
//! visible, matching the Ink modal (there is no backdrop dimming). Suggestion
//! popups are drawn by their owning editor workstream and sit above this layer.

use ratatui::Frame;
use ratatui::layout::Alignment;
use ratatui::style::{Modifier, Style};
use ratatui::text::Line;
use ratatui::widgets::{Block, Borders, Clear};

use crate::app::App;
use crate::modal;
use crate::theme;
use crate::view::suggestion;

/// Draw the active modal, if any.
pub fn render(frame: &mut Frame, app: &App) {
    let Some(active) = app.modals.top() else {
        return;
    };

    let rect = modal::geometry::resolve(frame.area(), active.width(), active.body_rows());

    frame.render_widget(Clear, rect.area);
    frame.render_widget(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(theme::PRIMARY))
            .style(
                Style::default()
                    .bg(theme::MODAL_BACKGROUND)
                    .fg(theme::FOREGROUND),
            )
            .title(
                Line::from(active.title())
                    .alignment(Alignment::Center)
                    .style(
                        Style::default()
                            .fg(theme::PRIMARY)
                            .add_modifier(Modifier::BOLD),
                    ),
            ),
        rect.area,
    );

    active.render(frame, rect);

    if let Some(overlay) = active.suggestion_overlay(rect) {
        suggestion::render(frame, &overlay, frame.area());
    }
}
