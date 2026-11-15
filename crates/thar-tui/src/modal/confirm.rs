//! The yes/no confirmation screen.
//!
//! Ported from `components/ConfirmModal.tsx` and `components/Button.tsx`. The
//! screen is data-carrying: [`ConfirmRequest`] holds the follow-up [`Action`]s,
//! so the app can apply them after the modal releases its borrow. That keeps
//! the confirmation generic (delete, archive, paste) without a callback or a
//! second modal registry entry.
//!
//! Layout follows the Ink body: one row per wrapped message line, one blank
//! margin row, then the button row (`body_rows = lines + 2`). The buttons are
//! centred in equal halves of the modal width, which is also the click map:
//! the left half confirms and the right half cancels. Hover is label-exact,
//! like `getHoveredButtonIndex`.

use ratatui::Frame;
use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::layout::{Alignment, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::Span;
use ratatui::widgets::Paragraph;
use thar_core::TodoId;

use crate::input::{MouseInput, MouseKind};
use crate::modal::geometry::{self, ModalRect, ModalWidth};
use crate::modal::text;
use crate::modal::{Action, Modal, ModalId, Outcome};
use crate::theme;

/// One confirmation, including what to do on either answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfirmRequest {
    /// Title on the modal border.
    pub title: String,
    /// Question shown above the buttons.
    pub message: String,
    /// Action applied after the confirmation closes.
    pub confirm: Box<Action>,
    /// Optional action applied after a cancel.
    pub cancel: Option<Box<Action>>,
}

impl ConfirmRequest {
    /// A confirmation with a follow-up action.
    #[must_use]
    pub fn new(title: impl Into<String>, message: impl Into<String>, confirm: Action) -> Self {
        Self {
            title: title.into(),
            message: message.into(),
            confirm: Box::new(confirm),
            cancel: None,
        }
    }

    /// The delete confirmation, with the Ink wording for one or many todos.
    #[must_use]
    pub fn delete(ids: Vec<TodoId>) -> Self {
        let many = ids.len() > 1;
        let title = if many { "Delete Todos" } else { "Delete Todo" };
        let message = if many {
            format!("Are you sure you want to delete {} todos?", ids.len())
        } else {
            "Are you sure you want to delete this todo?".to_owned()
        };
        Self::new(title, message, Action::Delete { ids })
    }

    /// The archive confirmation.
    #[must_use]
    pub fn archive() -> Self {
        Self::new(
            "Archive Completed",
            "Archive all completed todos to done.txt?",
            Action::ArchiveCompleted,
        )
    }

    /// The multi-line paste confirmation shown above ten lines.
    #[must_use]
    pub fn paste(count: usize, lines: Vec<String>) -> Self {
        Self::new(
            "Paste Multiple Todos",
            format!("Are you sure you want to paste {count} todos?"),
            Action::PasteLines { lines },
        )
    }
}

/// Labels of the two buttons, in order.
pub const BUTTON_LABELS: [&str; 2] = ["Confirm", "Cancel"];

/// The confirmation screen.
pub struct ConfirmModal {
    request: ConfirmRequest,
    selected: usize,
    hovered: Option<usize>,
    terminal_width: u16,
    terminal_height: u16,
}

impl ConfirmModal {
    /// A confirmation sized for the terminal it will open in.
    #[must_use]
    pub fn new(request: ConfirmRequest, terminal_width: u16, terminal_height: u16) -> Self {
        Self {
            request,
            selected: 0,
            hovered: None,
            terminal_width,
            terminal_height,
        }
    }

    /// The request this screen will apply.
    #[must_use]
    pub fn request(&self) -> &ConfirmRequest {
        &self.request
    }

    /// Highlighted button (0 confirm, 1 cancel).
    #[must_use]
    pub fn selected(&self) -> usize {
        self.selected
    }

    fn width_for(&self) -> ModalWidth {
        ModalWidth::Percent(50)
    }

    /// Message lines at the current terminal width.
    fn message_lines(&self) -> Vec<String> {
        text::wrap(&self.request.message, self.content_width())
    }

    /// Content width shared by wrapping and rendering.
    ///
    /// The modal box keeps one border column plus one padding column on each
    /// side, so the usable text is four columns narrower than the box.
    fn content_width(&self) -> u16 {
        self.width_for()
            .resolve(self.terminal_width)
            .saturating_sub(4)
    }

    fn button_row(&self) -> u16 {
        // One blank margin row above the buttons, matching the Ink modal's
        // `buttonRowIndex = lines + 1`.
        u16::try_from(self.message_lines().len())
            .unwrap_or(u16::MAX)
            .saturating_add(1)
    }

    fn geometry(&self) -> ModalRect {
        geometry::resolve(
            Rect::new(0, 0, self.terminal_width, self.terminal_height),
            self.width_for(),
            self.body_rows(),
        )
    }

    fn move_by(&mut self, delta: i32) {
        let count = i32::try_from(BUTTON_LABELS.len()).unwrap_or(2);
        let current = i32::try_from(self.selected).unwrap_or(0);
        let next = (current + delta).rem_euclid(count);
        self.selected = usize::try_from(next).unwrap_or(0);
    }

    fn activate(&self, index: usize) -> Outcome {
        if index == 0 {
            Outcome::Actions(vec![Action::Close, (*self.request.confirm).clone()])
        } else if let Some(cancel) = self.request.cancel.as_deref() {
            Outcome::Actions(vec![Action::Close, cancel.clone()])
        } else {
            Outcome::Close
        }
    }

    /// Relative cell column inside the modal for a 1-based mouse column.
    fn relative_column(&self, rect: ModalRect, mouse: MouseInput) -> Option<u16> {
        let column = mouse.x.checked_sub(1)?;
        let start = rect.area.x;
        let end = rect.area.x.saturating_add(rect.area.width);
        (start..end).contains(&column).then_some(column - start)
    }

    /// Label-exact hover hit test, matching `getHoveredButtonIndex`.
    fn hovered_at(&self, rect: ModalRect, mouse: MouseInput) -> Option<usize> {
        let row = geometry::body_row(rect, mouse)?;
        if row != self.button_row() {
            return None;
        }
        let column = self.relative_column(rect, mouse)?;

        let modal_width = rect.area.width;
        let left_half = modal_width / 2;
        let right_half = modal_width - left_half;
        for (index, label) in BUTTON_LABELS.iter().enumerate() {
            let rendered = format!("« {label} »");
            let label_width = u16::try_from(rendered.chars().count()).unwrap_or(modal_width);
            let (start, width) = if index == 0 {
                (0, left_half)
            } else {
                (left_half, right_half)
            };
            let offset = start.saturating_add(width.saturating_sub(label_width) / 2);
            let end = offset.saturating_add(label_width);
            if (offset..end).contains(&column) {
                return Some(index);
            }
        }
        None
    }
}

impl Modal for ConfirmModal {
    fn id(&self) -> ModalId {
        ModalId::Confirm
    }

    fn title(&self) -> &str {
        &self.request.title
    }

    fn width(&self) -> ModalWidth {
        self.width_for()
    }

    fn body_rows(&self) -> u16 {
        u16::try_from(self.message_lines().len())
            .unwrap_or(u16::MAX)
            .saturating_add(2)
    }

    fn resize(&mut self, width: u16, height: u16) {
        self.terminal_width = width;
        self.terminal_height = height;
    }

    fn handle_key(&mut self, key: KeyEvent) -> Outcome {
        match key.code {
            KeyCode::Esc => return self.activate(1),
            KeyCode::Tab => {
                self.move_by(if key.modifiers.contains(KeyModifiers::SHIFT) {
                    -1
                } else {
                    1
                });
                return Outcome::Continue;
            }
            KeyCode::Left => {
                self.move_by(-1);
                return Outcome::Continue;
            }
            KeyCode::Right => {
                self.move_by(1);
                return Outcome::Continue;
            }
            KeyCode::Enter | KeyCode::Char(' ') => {
                return self.activate(self.hovered.unwrap_or(self.selected));
            }
            _ => {}
        }
        Outcome::Continue
    }

    fn handle_mouse(&mut self, mouse: MouseInput) -> Outcome {
        let rect = self.geometry();
        match mouse.kind {
            MouseKind::Move => {
                self.hovered = self.hovered_at(rect, mouse);
                Outcome::Continue
            }
            MouseKind::LeftClick => {
                let Some(row) = geometry::body_row(rect, mouse) else {
                    return Outcome::Continue;
                };
                if row != self.button_row() {
                    return Outcome::Continue;
                }
                let Some(column) = self.relative_column(rect, mouse) else {
                    return Outcome::Continue;
                };
                let index = if column < rect.area.width / 2 { 0 } else { 1 };
                self.hovered = Some(index);
                self.selected = index;
                self.activate(index)
            }
            _ => Outcome::Continue,
        }
    }

    fn render(&self, frame: &mut Frame, rect: ModalRect) {
        let base = Style::default()
            .fg(theme::FOREGROUND)
            .bg(theme::MODAL_BACKGROUND);
        let content_x = rect.body.x.saturating_add(2);
        let content_width = self.content_width();

        for (index, line) in self.message_lines().iter().enumerate() {
            let offset = u16::try_from(index).unwrap_or(u16::MAX);
            if offset >= rect.body.height {
                break;
            }
            let area = Rect::new(
                content_x,
                rect.body.y.saturating_add(offset),
                content_width,
                1,
            );
            frame.render_widget(Paragraph::new(Span::styled(line.clone(), base)), area);
        }

        let button_y = rect.body.y.saturating_add(self.button_row());
        if button_y >= rect.body.y.saturating_add(rect.body.height) {
            return;
        }
        let modal_width = rect.area.width;
        let left_half = modal_width / 2;
        let right_half = modal_width - left_half;

        for (index, label) in BUTTON_LABELS.iter().enumerate() {
            let active = self.selected == index || self.hovered == Some(index);
            let rendered = if active {
                format!("« {label} »")
            } else {
                format!("‹ {label} ›")
            };
            let label_width = u16::try_from(rendered.chars().count()).unwrap_or(modal_width);
            let (half_start, half_width) = if index == 0 {
                (0, left_half)
            } else {
                (left_half, right_half)
            };
            let offset = half_start.saturating_add(half_width.saturating_sub(label_width) / 2);
            let area = Rect::new(
                rect.area.x.saturating_add(offset),
                button_y,
                label_width.min(rect.area.width.saturating_sub(offset)),
                1,
            );
            let color = if self.hovered == Some(index) {
                theme::WARNING
            } else if self.selected == index {
                theme::FOREGROUND
            } else {
                theme::MUTED
            };
            let style = base.fg(color).add_modifier(if active {
                Modifier::BOLD
            } else {
                Modifier::empty()
            });
            frame.render_widget(
                Paragraph::new(Span::styled(rendered, style)).alignment(Alignment::Center),
                area,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{BUTTON_LABELS, ConfirmModal, ConfirmRequest};
    use crate::input::{MouseInput, MouseKind};
    use crate::modal::{Action, Modal, ModalId, Outcome};
    use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    use thar_core::TodoId;

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn modal() -> ConfirmModal {
        ConfirmModal::new(ConfirmRequest::archive(), 100, 30)
    }

    fn actions(outcome: Outcome) -> Vec<Action> {
        match outcome {
            Outcome::Actions(actions) => actions,
            _ => panic!("expected actions"),
        }
    }

    #[test]
    fn the_exact_confirmation_strings_match_the_ink_commands() {
        let one = ConfirmRequest::delete(vec![TodoId::new(1)]);
        assert_eq!(one.title, "Delete Todo");
        assert_eq!(one.message, "Are you sure you want to delete this todo?");
        assert_eq!(
            *one.confirm,
            Action::Delete {
                ids: vec![TodoId::new(1)]
            }
        );

        let many = ConfirmRequest::delete(vec![TodoId::new(1), TodoId::new(2)]);
        assert_eq!(many.title, "Delete Todos");
        assert_eq!(many.message, "Are you sure you want to delete 2 todos?");

        let archive = ConfirmRequest::archive();
        assert_eq!(archive.title, "Archive Completed");
        assert_eq!(archive.message, "Archive all completed todos to done.txt?");

        let paste = ConfirmRequest::paste(12, vec!["one".to_owned()]);
        assert_eq!(paste.title, "Paste Multiple Todos");
        assert_eq!(paste.message, "Are you sure you want to paste 12 todos?");
    }

    #[test]
    fn enter_confirms_and_escape_cancels() {
        let mut modal = modal();
        assert_eq!(modal.id(), ModalId::Confirm);
        assert_eq!(modal.title(), "Archive Completed");
        assert_eq!(modal.body_rows(), 3); // message, margin, buttons

        assert_eq!(
            actions(modal.handle_key(key(KeyCode::Enter))),
            vec![Action::Close, Action::ArchiveCompleted]
        );
        assert!(matches!(
            modal.handle_key(key(KeyCode::Esc)),
            Outcome::Close
        ));
    }

    #[test]
    fn tab_left_and_right_navigate_and_space_activates() {
        let mut modal = modal();
        assert_eq!(modal.selected(), 0);
        modal.handle_key(key(KeyCode::Tab));
        assert_eq!(modal.selected(), 1);
        modal.handle_key(key(KeyCode::Tab));
        assert_eq!(modal.selected(), 0);
        modal.handle_key(key(KeyCode::Left));
        assert_eq!(modal.selected(), 1);
        modal.handle_key(key(KeyCode::Right));
        assert_eq!(modal.selected(), 0);

        modal.handle_key(key(KeyCode::Tab));
        assert!(matches!(
            modal.handle_key(key(KeyCode::Char(' '))),
            Outcome::Close
        ));
        assert_eq!(BUTTON_LABELS, ["Confirm", "Cancel"]);
    }

    #[test]
    fn message_wrapping_sets_the_button_row() {
        let long = "a ".repeat(80);
        let modal = ConfirmModal::new(
            ConfirmRequest::new("Long", long, Action::ToggleHiddenView),
            80,
            30,
        );
        // 50% of 80 = 40 wide, 36 content columns, so 160 characters need 5
        // lines (79 * 2 = 158 plus the trailing space). The body is 5 + 2.
        assert_eq!(modal.body_rows(), 7);
    }

    #[test]
    fn clicking_the_left_half_confirms_and_the_right_half_cancels() {
        let mut modal = modal();
        let rect = modal.geometry();
        let button_y = rect.body.y + modal.button_row();
        let left = MouseInput {
            kind: MouseKind::LeftClick,
            x: rect.area.x + 2,
            y: button_y + 1,
            shift: false,
        };
        assert_eq!(
            actions(modal.handle_mouse(left)),
            vec![Action::Close, Action::ArchiveCompleted]
        );

        let right = MouseInput {
            kind: MouseKind::LeftClick,
            x: rect.area.x + rect.area.width - 3,
            y: button_y + 1,
            shift: false,
        };
        assert!(matches!(modal.handle_mouse(right), Outcome::Close));
    }

    #[test]
    fn hover_is_label_exact_and_does_not_change_the_selection() {
        let mut modal = modal();
        let rect = modal.geometry();
        let button_y = rect.body.y + modal.button_row();

        // The left half's centre lands on the Confirm label.
        let hover = MouseInput {
            kind: MouseKind::Move,
            x: rect.area.x + rect.area.width / 4 + 1,
            y: button_y + 1,
            shift: false,
        };
        assert!(matches!(modal.handle_mouse(hover), Outcome::Continue));
        assert_eq!(modal.hovered, Some(0));
        assert_eq!(modal.selected(), 0);

        // A cell between the labels is not a hover.
        let gap = MouseInput {
            kind: MouseKind::Move,
            x: rect.area.x + 1,
            y: button_y + 1,
            shift: false,
        };
        modal.handle_mouse(gap);
        assert_eq!(modal.hovered, None);
    }
}
