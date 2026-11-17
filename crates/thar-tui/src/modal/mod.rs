//! The modal host shared by every CP7 workstream.
//!
//! CP7 has eleven screens over one list. They all obey the same rules: one is
//! active at a time, it owns the keyboard, Escape closes it, and it returns an
//! [`Action`] instead of touching the todo list itself. Keeping those rules in
//! one place lets each screen live in its own module and be tested with plain
//! key events.
//!
//! Rendering is split the same way: this module resolves the centred rectangle
//! and draws the chrome, then asks the active [`Modal`] to draw its body. The
//! per-screen modules never compute terminal geometry.
//!
//! The CP6 layout module deliberately keeps the base rows (search bar, list,
//! action bar) untouched; overlays live here and use their own hit-testing.

pub mod confirm;
pub mod geometry;
pub mod menu;
pub mod registry;
pub mod text;
pub mod update;

mod create_edit;
mod date;
mod priority;
mod recurrence;
mod tag;

use ratatui::Frame;
use ratatui::crossterm::event::KeyEvent;
use thar_core::{Priority, Recurrence, TodoDate, TodoId};

use crate::event::MouseInput;

pub use confirm::ConfirmRequest;
pub use geometry::{ModalRect, ModalWidth};
pub use registry::OpenError;
pub use update::{InstallKind, UpdateModel};

/// Every screen CP7 can show.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ModalId {
    /// Create a todo.
    CreateTodo,
    /// Edit the cursor todo's text.
    EditTodo,
    /// The single-todo command menu.
    TodoMenu,
    /// The range-selection command menu.
    MultiSelectMenu,
    /// Set or reset `due:`.
    SetDueDate,
    /// Set or reset `t:`.
    SetThresholdDate,
    /// Set or reset `rec:`.
    SetRecurrence,
    /// Set or clear a priority.
    SetPriority,
    /// Add or remove `+project` tokens.
    AddProject,
    /// Add or remove `@context` tokens.
    AddContext,
    /// The update-available screen.
    Update,
    /// A yes/no confirmation.
    Confirm,
}

impl ModalId {
    /// Every screen id, for exhaustive registry tests.
    pub const ALL: [Self; 12] = [
        Self::CreateTodo,
        Self::EditTodo,
        Self::TodoMenu,
        Self::MultiSelectMenu,
        Self::SetDueDate,
        Self::SetThresholdDate,
        Self::SetRecurrence,
        Self::SetPriority,
        Self::AddProject,
        Self::AddContext,
        Self::Update,
        Self::Confirm,
    ];
}

/// Which kind of `+`/`@` token a tag editor changes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TagKind {
    /// A `+project`.
    Project,
    /// An `@context`.
    Context,
}

/// A state change requested by a modal.
///
/// Actions are data, not callbacks: the app applies them after the modal has
/// released its borrow, which keeps the modal testable and the write path in
/// one place.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Action {
    /// Close the active modal.
    Close,
    /// Show a bounded toast and keep the modal open.
    Toast(String),
    /// Replace the active modal with another screen.
    Open(ModalId),
    /// Add one todo per line and select the last one.
    AddTodos(Vec<String>),
    /// Replace the text of each todo, preserving its tags.
    UpdateText {
        /// Todos to update.
        ids: Vec<TodoId>,
        /// New body text.
        text: String,
    },
    /// Delete the given todos.
    Delete {
        /// Todos to delete.
        ids: Vec<TodoId>,
    },
    /// Flip open/done and append recurring copies.
    Toggle {
        /// Todos to toggle.
        ids: Vec<TodoId>,
    },
    /// Flip the `h:` tag on the given todos.
    ToggleHidden {
        /// Todos to toggle.
        ids: Vec<TodoId>,
    },
    /// Set `due:`, or remove it when `date` is `None`.
    SetDue {
        /// Todos to update.
        ids: Vec<TodoId>,
        /// The new due date.
        date: Option<TodoDate>,
    },
    /// Set `t:`, or remove it when `date` is `None`.
    SetThreshold {
        /// Todos to update.
        ids: Vec<TodoId>,
        /// The new threshold date.
        date: Option<TodoDate>,
    },
    /// Set a priority, or clear it when `priority` is `None`.
    SetPriority {
        /// Todos to update.
        ids: Vec<TodoId>,
        /// The new priority.
        priority: Option<Priority>,
    },
    /// Set `rec:`, or remove it when `value` is `None`.
    SetRecurrence {
        /// Todos to update.
        ids: Vec<TodoId>,
        /// The new recurrence value.
        value: Option<Recurrence>,
    },
    /// Add a project or context token.
    AddTag {
        /// Todos to update.
        ids: Vec<TodoId>,
        /// Project or context.
        kind: TagKind,
        /// Token name without the prefix.
        name: String,
    },
    /// Remove a project or context token.
    RemoveTag {
        /// Todos to update.
        ids: Vec<TodoId>,
        /// Project or context.
        kind: TagKind,
        /// Token name without the prefix.
        name: String,
    },
    /// Undo the last mutation.
    Undo,
    /// Redo the last undo.
    Redo,
    /// Include or exclude hidden todos.
    ToggleHiddenView,
    /// Copy the selected todos to the clipboard.
    Copy {
        /// Todos to copy.
        ids: Vec<TodoId>,
    },
    /// Paste todos from the clipboard.
    Paste,
    /// Add already-read clipboard lines, with the paste toast.
    PasteLines {
        /// Non-empty todo lines.
        lines: Vec<String>,
    },
    /// Archive every completed todo to `done.txt`.
    ArchiveCompleted,
    /// Open a yes/no confirmation carrying the follow-up actions.
    Confirm(ConfirmRequest),
}

/// What a modal wants the host to do after one event.
pub enum Outcome {
    /// Stay open.
    Continue,
    /// Close without an action.
    Close,
    /// Close and apply these actions in order.
    Actions(Vec<Action>),
}

/// One screen.
pub trait Modal {
    /// Stable identifier.
    fn id(&self) -> ModalId;
    /// Title shown on the top border.
    fn title(&self) -> &str;
    /// Width of the centred box.
    fn width(&self) -> ModalWidth {
        ModalWidth::Percent(50)
    }
    /// Number of body rows, excluding chrome.
    fn body_rows(&self) -> u16;
    /// Handle one key press.
    fn handle_key(&mut self, key: KeyEvent) -> Outcome;
    /// Handle one mouse event.
    fn handle_mouse(&mut self, _mouse: MouseInput) -> Outcome {
        Outcome::Continue
    }
    /// Data for a suggestion popup drawn above this modal, if any.
    fn suggestion_overlay(&self, _rect: ModalRect) -> Option<crate::suggest::Overlay<'_>> {
        None
    }
    /// Handle a bracketed paste.
    fn handle_paste(&mut self, _text: &str) -> Outcome {
        Outcome::Continue
    }
    /// Keep the screen's geometry in step with a terminal resize.
    fn resize(&mut self, _width: u16, _height: u16) {}
    /// Draw the body into the rectangle resolved by [`geometry::resolve`].
    fn render(&self, frame: &mut Frame, rect: ModalRect);
}

/// The one active modal, if any.
#[derive(Default)]
pub struct Stack {
    active: Option<Box<dyn Modal>>,
}

impl Stack {
    /// Replace any active modal with `modal`.
    pub fn open(&mut self, modal: Box<dyn Modal>) {
        self.active = Some(modal);
    }

    /// Close the active modal.
    pub fn close(&mut self) {
        self.active = None;
    }

    /// True while a modal owns the keyboard.
    #[must_use]
    pub fn is_open(&self) -> bool {
        self.active.is_some()
    }

    /// The active modal, if any.
    #[must_use]
    pub fn top(&self) -> Option<&(dyn Modal + 'static)> {
        self.active.as_deref()
    }

    /// The active modal, mutably.
    #[must_use]
    pub fn top_mut(&mut self) -> Option<&mut (dyn Modal + 'static)> {
        self.active.as_deref_mut()
    }

    /// Forward a terminal resize to the active modal, if any.
    pub fn resize(&mut self, width: u16, height: u16) {
        if let Some(modal) = self.active.as_deref_mut() {
            modal.resize(width, height);
        }
    }
}

impl core::fmt::Debug for Stack {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self.active.as_ref() {
            Some(modal) => formatter
                .debug_struct("Stack")
                .field("active", &modal.id())
                .finish(),
            None => formatter
                .debug_struct("Stack")
                .field("active", &None::<ModalId>)
                .finish(),
        }
    }
}
