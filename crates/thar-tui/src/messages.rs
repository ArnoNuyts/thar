//! Bounded user-facing messages shared by the input layer and the app.
//!
//! This is a leaf module: it depends on nothing else in the crate, so
//! [`crate::app`] and [`crate::input`] both use these strings without importing
//! each other.

/// Message shown for every command that would modify `todo.txt`.
pub const READ_ONLY_MESSAGE: &str = "Read-only: thar-rs cannot modify todo.txt";

/// Bounded message when `u` is pressed without update information.
pub const NO_UPDATE_MESSAGE: &str = "No update available";
