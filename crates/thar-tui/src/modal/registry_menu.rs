//! Menus, confirmations, clipboard and archive (CP7 menu workstream).
//!
//! This module owns every CP7 screen that is a list of commands or a yes/no
//! answer. The menus and the update screen are built from the app snapshot;
//! the confirmation carries its follow-up actions in
//! [`ConfirmRequest`](super::confirm::ConfirmRequest), so it is opened directly
//! by [`confirm`] instead of through [`open`].

use crate::app::App;

use super::confirm::{ConfirmModal, ConfirmRequest};
use super::menu::Menu;
use super::update::UpdateModal;
use super::{Modal, ModalId};

/// Build a menu or update screen.
///
/// `Confirm` is deliberately absent: it needs a [`ConfirmRequest`] that the
/// modal host passes to [`confirm`].
#[must_use]
pub fn open(app: &App, id: ModalId) -> Option<Box<dyn Modal>> {
    match id {
        ModalId::TodoMenu => Some(Box::new(Menu::single(
            selected_ids(app),
            app.width,
            app.height,
        ))),
        ModalId::MultiSelectMenu => Some(Box::new(Menu::multi(
            selected_ids(app),
            app.width,
            app.height,
        ))),
        ModalId::Update => app.update_model.clone().map(|model| {
            Box::new(UpdateModal::new(model, app.width, app.height)) as Box<dyn Modal>
        }),
        _ => None,
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

/// Ids of the current selection, in load order.
fn selected_ids(app: &App) -> Vec<thar_core::TodoId> {
    app.selected_todos().iter().map(|todo| todo.id).collect()
}
