//! One exhaustive dispatch table for every modal screen.
//!
//! The `match` is intentionally exhaustive: adding a [`ModalId`] fails to
//! compile here until its screen is wired up, which is cheaper than a runtime
//! "not available" toast hidden behind a wildcard arm.
//!
//! The returned error distinguishes a screen that this build cannot construct
//! from a screen that needs data the caller owns:
//!
//! - [`OpenError::Unavailable`] means the host did not supply what the screen
//!   needs (today that is only the update model);
//! - [`OpenError::NeedsRequest`] means the screen is opened through
//!   [`confirm`] after an [`crate::modal::Action::Confirm`], not by id, so
//!   requesting it by id is a no-op rather than a bogus "unavailable" toast.

use crate::app::App;

use super::confirm::{ConfirmModal, ConfirmRequest};
use super::create_edit;
use super::date::{DateKind, SetDateModal};
use super::menu::Menu;
use super::priority::SetPriorityModal;
use super::recurrence::SetRecurrenceModal;
use super::tag::TagModal;
use super::update::UpdateModal;
use super::{Modal, ModalId, TagKind};

/// Why [`open`] could not build a screen.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenError {
    /// The screen exists but the host did not supply its data.
    Unavailable,
    /// The screen needs a request and is opened through [`confirm`].
    NeedsRequest,
}

/// Build the requested screen from the current app snapshot.
///
/// A screen is built with its initial data copied in (selected ids, today,
/// reference todo values), so it can be driven by key events without borrowing
/// the app.
///
/// # Errors
///
/// Returns [`OpenError::Unavailable`] when the screen needs host data that is
/// absent, and [`OpenError::NeedsRequest`] for [`ModalId::Confirm`].
pub fn open(app: &App, id: ModalId) -> Result<Box<dyn Modal>, OpenError> {
    let width = app.width();
    let height = app.height();
    match id {
        ModalId::CreateTodo => Ok(create_edit::create(app)),
        ModalId::EditTodo => Ok(create_edit::edit(app)),
        ModalId::TodoMenu => Ok(Box::new(Menu::single(app.selected_ids(), width, height))),
        ModalId::MultiSelectMenu => Ok(Box::new(Menu::multi(app.selected_ids(), width, height))),
        ModalId::SetDueDate => Ok(Box::new(SetDateModal::new(app, DateKind::Due))),
        ModalId::SetThresholdDate => Ok(Box::new(SetDateModal::new(app, DateKind::Threshold))),
        ModalId::SetRecurrence => Ok(Box::new(SetRecurrenceModal::new(app))),
        ModalId::SetPriority => Ok(Box::new(SetPriorityModal::new(app))),
        ModalId::AddProject => Ok(Box::new(TagModal::new(app, TagKind::Project))),
        ModalId::AddContext => Ok(Box::new(TagModal::new(app, TagKind::Context))),
        ModalId::Update => app
            .update_model()
            .cloned()
            .map(|model| Box::new(UpdateModal::new(model, width, height)) as Box<dyn Modal>)
            .ok_or(OpenError::Unavailable),
        ModalId::Confirm => Err(OpenError::NeedsRequest),
    }
}

/// Build a confirmation screen from a request.
#[must_use]
pub fn confirm(
    request: ConfirmRequest,
    terminal_width: u16,
    terminal_height: u16,
) -> Box<dyn Modal> {
    Box::new(ConfirmModal::new(request, terminal_width, terminal_height))
}

#[cfg(test)]
mod tests {
    use super::{OpenError, open};
    use crate::app::App;
    use crate::modal::ModalId;
    use thar_core::{Todo, TodoDate, TodoId};

    fn app(lines: &[&str]) -> App {
        let todos = lines
            .iter()
            .enumerate()
            .map(|(index, line)| Todo::parse_line(line, TodoId::new(index as u64)))
            .collect();
        App::new(
            "todo.txt",
            todos,
            "2026-11-15".parse::<TodoDate>().expect("valid date"),
        )
    }

    #[test]
    fn every_modal_id_is_handled_without_a_wildcard() {
        let app = app(&["one +thar @home"]);
        let mut unavailable = Vec::new();
        for id in ModalId::ALL {
            match open(&app, id) {
                Ok(modal) => assert_eq!(modal.id(), id, "{id:?} built another screen"),
                Err(error) => unavailable.push((id, error)),
            }
        }
        // Only the host-supplied update screen is unavailable, and Confirm
        // needs its request instead of reporting that it does not exist.
        assert_eq!(
            unavailable,
            [
                (ModalId::Update, OpenError::Unavailable),
                (ModalId::Confirm, OpenError::NeedsRequest)
            ]
        );
    }

    #[test]
    fn confirm_never_reports_the_not_available_toast() {
        let mut app = app(&["one"]);
        app.open_modal(ModalId::Confirm);
        assert!(!app.modals().is_open());
        assert_eq!(
            app.toast_message(std::time::Instant::now()),
            None,
            "Confirm must be a silent no-op"
        );

        app.open_modal(ModalId::Update);
        assert_eq!(
            app.toast_message(std::time::Instant::now()),
            Some("That screen is not available in this build yet")
        );
    }
}
