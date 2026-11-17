//! Terminal event types shared by the input and modal layers.
//!
//! The host (`thar-cli`) translates crossterm events into these plain values so
//! that every layer below the terminal can be driven by synthetic events. The
//! module deliberately has no dependency on [`crate::app`], [`crate::input`] or
//! [`crate::modal`], which breaks the former `app -> modal -> input -> app`
//! module cycle: modals and input both depend on this leaf module instead.

use std::time::{Duration, Instant};

use thar_core::TodoId;

/// Window for treating two clicks as a double-click, matching the Ink list.
pub const DOUBLE_CLICK_WINDOW: Duration = Duration::from_millis(350);

/// Mouse event kinds the TUI cares about.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MouseKind {
    /// Wheel up.
    WheelUp,
    /// Wheel down.
    WheelDown,
    /// Left button press.
    LeftClick,
    /// Motion with no button change.
    Move,
}

/// A mouse event in 1-based terminal coordinates.
///
/// Crossterm reports 0-based cells (column/row), so the host adds one before it
/// builds this value; everything below the host works in 1-based cells.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MouseInput {
    /// Event kind.
    pub kind: MouseKind,
    /// 1-based column.
    pub x: u16,
    /// 1-based row.
    pub y: u16,
    /// Shift modifier (shift-click extends the range).
    pub shift: bool,
}

/// A pending click, used for the double-click window.
///
/// Every left click records its position; only a click that landed on a todo
/// row carries its id. A following click counts as a double-click when it is
/// within [`DOUBLE_CLICK_WINDOW`] and repeats either the todo or the cell.
#[derive(Clone, Copy, Debug)]
pub struct LastClick {
    /// Clicked todo id, or `None` when the click did not land on a todo row.
    pub todo_id: Option<TodoId>,
    /// 1-based column.
    pub x: u16,
    /// 1-based row.
    pub y: u16,
    /// Arrival time.
    pub at: Instant,
}
