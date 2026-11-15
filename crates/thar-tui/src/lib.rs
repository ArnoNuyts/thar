//! `thar-tui`: the ratatui front end for Thar (CP6 read-only, CP7 writes).
//!
//! The crate is split so each layer can be tested without a terminal:
//!
//! - [`app`] owns the state, the mutation API, and the save debounce;
//! - [`calendar`] is the Monday-first month grid used by the date modal;
//! - [`display`] escapes control characters before anything reaches the
//!   terminal;
//! - [`list`] builds the owned row model from the `thar-core` domain;
//! - [`nav`] moves the cursor, selection, and viewport;
//! - [`input`] maps crossterm keys/mouse events to commands and applies them;
//! - [`modal`] owns the one active screen, its geometry, and the action
//!   vocabulary;
//! - [`history`] keeps the undo/redo snapshots;
//! - [`view`] draws one frame;
//! - [`layout`] is the geometry shared by rendering and hit-testing;
//! - [`search`] provides the native host's search normalization.
//!
//! The binary lives in `thar-cli` (`thar-rs`). Keeping the domain, state and
//! rendering out of the binary is what makes the PTY tests and the
//! `TestBackend` snapshots possible.
//!
//! # Write path
//!
//! This crate has no filesystem API: it queues [`app::Effect`]s and lets the
//! host (`thar-cli` + `thar-store`) do the writing. The binary is read-only
//! unless `--write` is passed, and the CP6 source scan still proves that the
//! read-only path links no writer.

#![forbid(unsafe_code)]
#![deny(missing_docs)]

pub mod app;
pub mod calendar;
pub mod display;
pub mod history;
pub mod input;
pub mod layout;
pub mod list;
pub mod modal;
pub mod nav;
pub mod search;
pub mod theme;
pub mod view;

pub use app::{App, Effect};
pub use history::History;
pub use layout::Layout;
pub use list::{ListModel, ListRow};
pub use modal::{
    Action, ConfirmRequest, InstallKind, Modal, ModalId, Outcome, TagKind, UpdateModel,
};
