//! The yes/no confirmation screen.
//!
//! Ported from `components/ConfirmModal.tsx` and `components/Button.tsx`. The
//! screen is data-carrying: [`ConfirmRequest`] holds the follow-up [`Action`]s,
//! so the app can apply them after the modal releases its borrow. That keeps
//! the confirmation generic (delete, archive, paste) without a callback or a
//! second modal registry entry.
//!
//! Layout follows the Ink body: one row per wrapped message line, one blank
//! margin row, then the button row (`body_rows = lines + 2`). The buttons use
//! the shared [`super::buttons`] row, so the whole left half confirms and the
//! whole right half cancels, and hover/click behave like the create/edit and
//! update screens.

use ratatui::Frame;
use ratatui::crossterm::event::{KeyCode, KeyEvent};
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::Span;
use ratatui::widgets::Paragraph;
use thar_core::TodoId;

use crate::event::MouseInput;
use crate::modal::buttons::Row;
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
    pub fn paste(lines: Vec<String>) -> Self {
        Self::new(
            "Paste Multiple Todos",
            format!("Are you sure you want to paste {} todos?", lines.len()),
            Action::PasteLines { lines },
        )
    }
}

/// Labels of the two buttons, in order.
pub const BUTTON_LABELS: [&str; 2] = ["Confirm", "Cancel"];

/// The confirmation screen.
pub struct ConfirmModal {
    request: ConfirmRequest,
    /// Shared button row: 0 confirms, 1 cancels.
    buttons: Row,
    terminal_width: u16,
    terminal_height: u16,
}

impl ConfirmModal {
    /// A confirmation sized for the terminal it will open in.
    #[must_use]
    pub fn new(request: ConfirmRequest, terminal_width: u16, terminal_height: u16) -> Self {
        Self {
            request,
            buttons: Row::default(),
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
        self.buttons.selected
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
    /// The modal box keeps one outer padding column on each side, the
    /// accent-bar column, and one content-padding column on each side, so the
    /// usable text is five columns narrower than the box.
    fn content_width(&self) -> u16 {
        self.width_for()
            .resolve(self.terminal_width)
            .saturating_sub(5)
    }

    /// The button row is the shared look and hit map; see [`super::buttons`].
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

    fn activate(&self, index: usize) -> Outcome {
        if index == 0 {
            Outcome::Actions(vec![Action::Close, (*self.request.confirm).clone()])
        } else if let Some(cancel) = self.request.cancel.as_deref() {
            Outcome::Actions(vec![Action::Close, cancel.clone()])
        } else {
            Outcome::Close
        }
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
        if key.code == KeyCode::Esc {
            return self.activate(1);
        }
        self.buttons
            .on_key(key, BUTTON_LABELS.len())
            .map_or(Outcome::Continue, |index| self.activate(index))
    }

    fn handle_mouse(&mut self, mouse: MouseInput) -> Outcome {
        let rect = self.geometry();
        self.buttons
            .on_mouse(rect, self.button_row(), BUTTON_LABELS.len(), mouse)
            .map_or(Outcome::Continue, |index| self.activate(index))
    }

    fn render(&self, frame: &mut Frame, rect: ModalRect) {
        let base = Style::default()
            .fg(theme::FOREGROUND)
            .bg(theme::MODAL_BACKGROUND);
        let content_x = rect.body.x.saturating_add(1);
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

        super::buttons::render(
            frame,
            rect,
            self.button_row(),
            &BUTTON_LABELS,
            self.buttons.selected,
            self.buttons.hovered,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::{BUTTON_LABELS, ConfirmModal, ConfirmRequest};
    use crate::event::{MouseInput, MouseKind};
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

        let paste = ConfirmRequest::paste((0..12).map(|index| format!("todo {index}")).collect());
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
    fn backtab_moves_the_selection_back() {
        let mut modal = modal();
        // Tab to Cancel, then Shift+Tab (BackTab) returns to Confirm.
        modal.handle_key(key(KeyCode::Tab));
        assert_eq!(modal.selected(), 1);
        assert!(matches!(
            modal.handle_key(key(KeyCode::BackTab)),
            Outcome::Continue
        ));
        assert_eq!(modal.selected(), 0);
        // A second BackTab wraps backwards to Cancel.
        modal.handle_key(key(KeyCode::BackTab));
        assert_eq!(modal.selected(), 1);
    }

    #[test]
    fn message_wrapping_sets_the_button_row() {
        let long = "a ".repeat(80);
        let modal = ConfirmModal::new(
            ConfirmRequest::new("Long", long, Action::ToggleHiddenView),
            80,
            30,
        );
        // 50% of 80 = 40 wide, 35 content columns, so 160 characters need 5
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
            x: rect.area.x + 3,
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
    fn hover_uses_the_whole_half_and_does_not_change_the_selection() {
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
        assert_eq!(modal.buttons.hovered, Some(0));
        assert_eq!(modal.selected(), 0);

        // The whole half is a hover target, not only the glyphs: a cell well
        // left of the centred label still highlights Confirm.
        let empty_part = MouseInput {
            kind: MouseKind::Move,
            x: rect.body.x + 1,
            y: button_y + 1,
            shift: false,
        };
        modal.handle_mouse(empty_part);
        assert_eq!(modal.buttons.hovered, Some(0));

        // Off the button row there is no hover.
        let elsewhere = MouseInput {
            kind: MouseKind::Move,
            x: rect.body.x + 1,
            y: button_y,
            shift: false,
        };
        modal.handle_mouse(elsewhere);
        assert_eq!(modal.buttons.hovered, None);
    }

    fn modal_with_cancel() -> ConfirmModal {
        let mut request = ConfirmRequest::archive();
        request.cancel = Some(Box::new(Action::ToggleHiddenView));
        ConfirmModal::new(request, 100, 30)
    }

    #[test]
    fn enter_uses_the_keyboard_selection_even_with_a_stale_hover() {
        let mut modal = modal_with_cancel();
        let rect = modal.geometry();
        let button_y = rect.body.y + modal.button_row();
        let hover_confirm = MouseInput {
            kind: MouseKind::Move,
            x: rect.body.x + 1,
            y: button_y + 1,
            shift: false,
        };

        // Hover Confirm, then Tab to Cancel: Enter must activate Cancel, not
        // the pointer hover. The hover still paints Confirm, which is why the
        // activation reads the selection instead of `hovered`.
        assert!(matches!(
            modal.handle_mouse(hover_confirm),
            Outcome::Continue
        ));
        assert_eq!(modal.buttons.hovered, Some(0));
        assert!(matches!(
            modal.handle_key(key(KeyCode::Tab)),
            Outcome::Continue
        ));
        assert_eq!(modal.selected(), 1);
        assert_eq!(modal.buttons.hovered, Some(0));
        assert_eq!(
            actions(modal.handle_key(key(KeyCode::Enter))),
            vec![Action::Close, Action::ToggleHiddenView]
        );

        // Left does the same.
        let mut modal = modal_with_cancel();
        assert!(matches!(
            modal.handle_mouse(hover_confirm),
            Outcome::Continue
        ));
        assert_eq!(modal.buttons.hovered, Some(0));
        modal.handle_key(key(KeyCode::Left));
        assert_eq!(modal.selected(), 1);
        assert_eq!(modal.buttons.hovered, Some(0));
        assert_eq!(
            actions(modal.handle_key(key(KeyCode::Enter))),
            vec![Action::Close, Action::ToggleHiddenView]
        );
    }
}
