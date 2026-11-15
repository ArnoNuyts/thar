//! Priority/recurrence/tag screens (CP7 meta workstream).
//!
//! The list keymap routes `A`..`F`, `r`, `+` and `@` here. Every screen is
//! built from the current selection, so it can be driven without borrowing the
//! app. The update screen belongs to its own workstream and stays unavailable.

use crate::app::App;

use super::priority::SetPriorityModal;
use super::recurrence::SetRecurrenceModal;
use super::tag::TagModal;
use super::{Modal, ModalId, TagKind};

/// Build a meta screen.
#[must_use]
pub fn open(app: &App, id: ModalId) -> Option<Box<dyn Modal>> {
    match id {
        ModalId::SetPriority => Some(Box::new(SetPriorityModal::new(app))),
        ModalId::SetRecurrence => Some(Box::new(SetRecurrenceModal::new(app))),
        ModalId::AddProject => Some(Box::new(TagModal::new(app, TagKind::Project))),
        ModalId::AddContext => Some(Box::new(TagModal::new(app, TagKind::Context))),
        _ => None,
    }
}
