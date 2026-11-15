//! Due/threshold dates and the calendar (CP7 date workstream).
//!
//! This stub returns `None` until that workstream lands; the list keymap still
//! routes `d`/`t` here, so the host shows one bounded "not available" toast.

use crate::app::App;

use super::{Modal, ModalId};

/// Build a date screen.
#[must_use]
pub fn open(_app: &App, _id: ModalId) -> Option<Box<dyn Modal>> {
    None
}
