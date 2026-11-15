//! One dispatch table for the modal screens.
//!
//! Each workstream owns one `registry_*` module and fills only its own match
//! arms. This file is the stable composition point, so a feature branch never
//! has to edit another branch's screen list.

use crate::app::App;

use super::{Modal, ModalId};
use super::{registry_date, registry_editor, registry_menu, registry_meta};

/// Build the requested screen from the current app snapshot.
///
/// A screen is built with its initial data copied in (selected ids, today,
/// reference todo values), so it can be driven by key events without borrowing
/// the app. `None` means the screen is not available in this build.
#[must_use]
pub fn open(app: &App, id: ModalId) -> Option<Box<dyn Modal>> {
    registry_editor::open(app, id)
        .or_else(|| registry_date::open(app, id))
        .or_else(|| registry_meta::open(app, id))
        .or_else(|| registry_menu::open(app, id))
}
