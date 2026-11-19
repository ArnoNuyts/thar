//! `thar-tui`: the ratatui front end for Thar (read-only by default, writes
//! with `--write`).
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
//! - [`event`] is the leaf terminal-event module shared by input and modals;
//! - [`editor`] is the one-line text editor behind the create/edit screen and
//!   the search bar;
//! - [`messages`] holds the bounded user-facing strings shared by input and
//!   the app;
//! - [`search_bar`] owns the query, its cursor and the suggestion popup;
//! - [`suggest`] collects project/context tag sources and drives the
//!   suggestion list;
//! - [`modal`] owns the one active screen, its geometry, and the action
//!   vocabulary;
//! - `history` keeps the undo/redo snapshots, sharing unchanged todos;
//! - `entry` pairs each todo handle with its cached search view;
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
//! unless `--write` is passed, and the read-only source scan still proves that
//! the read-only path links no writer.

pub mod app;
pub mod calendar;
pub mod display;
pub mod editor;
mod entry;
pub mod event;
mod history;
pub mod input;
pub mod layout;
pub mod list;
pub mod messages;
pub mod modal;
pub mod nav;
pub mod search;
pub mod search_bar;
pub mod suggest;
pub mod theme;
pub mod view;

pub use app::{App, Effect, Todos};
pub use layout::Layout;
pub use list::{ListModel, ListRow};
pub use modal::{
    Action, ConfirmRequest, InstallKind, Modal, ModalId, OpenError, Outcome, TagKind, UpdateModel,
};
pub use search_bar::SearchBar;
