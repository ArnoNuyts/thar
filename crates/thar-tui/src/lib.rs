//! `thar-tui`: the read-only ratatui front end for Thar (CP6).
//!
//! The crate is split so each layer can be tested without a terminal:
//!
//! - [`app`] owns the state and the read-only invariant;
//! - [`display`] escapes control characters before anything reaches the
//!   terminal;
//! - [`list`] builds the owned row model from the `thar-core` domain;
//! - [`nav`] moves the cursor, selection, and viewport;
//! - [`input`] maps crossterm keys/mouse events to commands and applies them;
//! - [`editor`] is the one-line text editor behind the create/edit screen;
//! - [`suggest`] collects project/context tag sources and drives the
//!   suggestion list;
//! - [`view`] draws one frame;
//! - [`layout`] is the geometry shared by rendering and hit-testing;
//! - [`search`] provides the native host's search normalization.
//!
//! The binary lives in `thar-cli` (`thar-rs`). Keeping the domain, state and
//! rendering out of the binary is what makes the PTY tests and the
//! `TestBackend` snapshots possible.
//!
//! # Read-only
//!
//! There is no write API in this crate and no serializer call: CP6's binary
//! cannot modify `todo.txt`. [`input::Command::Rejected`] acknowledges every
//! mutating key with one bounded toast.

#![forbid(unsafe_code)]
#![deny(missing_docs)]

pub mod app;
pub mod display;
pub mod editor;
pub mod history;
pub mod input;
pub mod layout;
pub mod list;
pub mod modal;
pub mod nav;
pub mod search;
pub mod suggest;
pub mod theme;
pub mod view;

pub use app::{App, Effect};
pub use history::History;
pub use layout::Layout;
pub use list::{ListModel, ListRow};
pub use modal::{Action, Modal, ModalId, Outcome, TagKind};
