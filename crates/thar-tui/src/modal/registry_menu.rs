//! Menus, confirmations, clipboard and archive (CP7 menu workstream).
//!
//! This stub returns `None` until that workstream lands; the list keymap still
//! routes the keys here, so the host shows one bounded "not available" toast.

use crate::app::App;

use super::{Modal, ModalId};

/// Build a menu/confirm screen.
#[must_use]
pub fn open(_app: &App, _id: ModalId) -> Option<Box<dyn Modal>> {
    None
}
