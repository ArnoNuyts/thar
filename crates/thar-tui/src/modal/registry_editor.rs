//! Create/edit screens and the text editor (CP7 editor workstream).
//!
//! The screen itself lives in `create_edit`; this registry file is the one line
//! the modal host needs. Both ids route here, and any other id returns `None`
//! so the host shows its bounded "not available" toast instead.

use crate::app::App;

use super::{Modal, ModalId, create_edit};

/// Build an editor screen.
#[must_use]
pub fn open(app: &App, id: ModalId) -> Option<Box<dyn Modal>> {
    match id {
        ModalId::CreateTodo => Some(create_edit::create(app)),
        ModalId::EditTodo => Some(create_edit::edit(app)),
        _ => None,
    }
}
