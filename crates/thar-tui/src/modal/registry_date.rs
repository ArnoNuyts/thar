//! Due/threshold dates and the calendar (CP7 date workstream).
//!
//! The list keymap routes `d`/`t` here. Both screens are built from the current
//! selection and day, so they can be driven without borrowing the app.

use crate::app::App;

use super::date::{DateKind, SetDateModal};
use super::{Modal, ModalId};

/// Build a date screen.
#[must_use]
pub fn open(app: &App, id: ModalId) -> Option<Box<dyn Modal>> {
    match id {
        ModalId::SetDueDate => Some(Box::new(SetDateModal::new(app, DateKind::Due))),
        ModalId::SetThresholdDate => Some(Box::new(SetDateModal::new(app, DateKind::Threshold))),
        _ => None,
    }
}
