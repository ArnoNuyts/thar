//! Application state for the read-only TUI.
//!
//! The state is deliberately split from the event loop and from rendering:
//! `thar-cli` owns the terminal, `input` maps events to [`crate::input::Command`]s,
//! and `view` reads this struct. Everything here is a plain state transition,
//! so the whole app can be driven by `TestBackend` + synthetic events without a
//! real terminal.
//!
//! # Read-only invariant
//!
//! CP6's binary links no writer. `App` has no save path and no history; the
//! mutating keys are rejected in [`crate::input`] with one bounded toast.
//! [`App::read_only`] exists so the action bar can show the `READ-ONLY` badge
//! and so CP7 can flip it when `--write` lands.

use std::time::{Duration, Instant};

use thar_core::{ReadLimits, Todo, TodoDate, TodoId};

use crate::layout::Layout;
use crate::list::{ListModel, ListRow};
use crate::search::{OwnedView, view_for};

/// How long a toast stays visible, matching `ToasterProvider`.
pub const TOAST_DURATION: Duration = Duration::from_millis(2_000);

/// A bounded, transient status message shown on the right of the action bar.
#[derive(Clone, Debug)]
pub struct Toast {
    /// Message text. Never contains todo content from the file.
    pub message: String,
    /// When the toast was shown.
    pub shown_at: Instant,
}

impl Toast {
    /// Remaining time, or `None` once [`TOAST_DURATION`] has elapsed.
    #[must_use]
    pub fn remaining(&self, now: Instant) -> Option<Duration> {
        TOAST_DURATION.checked_sub(now.saturating_duration_since(self.shown_at))
    }
}

/// The complete TUI state.
pub struct App {
    /// Path shown in diagnostics (never rendered as a row).
    pub filename: String,
    /// Todos in load order; row indexes point into this vector.
    pub todos: Vec<Todo>,
    /// Cached search views, aligned with `todos`.
    pub views: Vec<OwnedView>,
    /// The current row model (sorted, filtered, searched, grouped).
    pub list: ListModel,
    /// Local calendar day used by the overdue and threshold rules.
    pub today: TodoDate,
    /// Current search query, before normalization.
    pub query: String,
    /// Cursor position in `query`, in characters (not bytes).
    pub query_cursor: usize,
    /// True while the search bar has keyboard focus.
    pub search_focused: bool,
    /// True when hidden todos are included in the list.
    pub show_hidden: bool,
    /// Cursor todo.
    pub cursor: Option<TodoId>,
    /// Anchor of a shift-selection.
    pub anchor: Option<TodoId>,
    /// Selected todo ids for a range selection (empty means "cursor only").
    pub range: Vec<TodoId>,
    /// First visible row.
    pub offset: usize,
    /// Terminal width, updated on every draw/resize.
    pub width: u16,
    /// Terminal height, updated on every draw/resize.
    pub height: u16,
    /// Current toast, if any.
    pub toast: Option<Toast>,
    /// A bounded read failure, shown once in the action bar; the app keeps the
    /// last good list in memory and stays read-only.
    pub load_error: Option<String>,
    /// True when the process should exit.
    pub should_quit: bool,
    /// Always true for CP6; CP7 flips it when `--write` is passed.
    pub read_only: bool,
}

impl App {
    /// Create the app for an already-loaded, read-only todo list.
    #[must_use]
    pub fn new(filename: impl Into<String>, todos: Vec<Todo>, today: TodoDate) -> Self {
        let views: Vec<OwnedView> = todos.iter().map(view_for).collect();
        let list = ListModel::build(&todos, &views, "", false, today);

        let mut app = Self {
            filename: filename.into(),
            todos,
            views,
            list,
            today,
            query: String::new(),
            query_cursor: 0,
            search_focused: false,
            show_hidden: false,
            cursor: None,
            anchor: None,
            range: Vec::new(),
            offset: 0,
            width: 80,
            height: 24,
            toast: None,
            load_error: None,
            should_quit: false,
            read_only: true,
        };
        app.cursor = app.first_todo_id();
        app.clamp_offset();
        app
    }

    /// Replace the whole list (initial load or a reload) and reset selection
    /// metadata that refers to the previous list.
    pub fn set_todos(&mut self, todos: Vec<Todo>) {
        self.todos = todos;
        self.views = self.todos.iter().map(view_for).collect();
        self.range.clear();
        self.anchor = None;
        self.rebuild_list();
        self.cursor = self
            .cursor
            .filter(|id| self.row_for(*id).is_some())
            .or_else(|| self.first_todo_id());
        self.clamp_offset();
    }

    /// Current terminal size and rows.
    #[must_use]
    pub fn layout(&self) -> Layout {
        Layout::new(self.width, self.height, self.search_visible())
    }

    /// The search bar is visible while focused or while it holds a query.
    #[must_use]
    pub fn search_visible(&self) -> bool {
        self.search_focused || !self.query.is_empty()
    }

    /// Rebuild the row model from the current todos, views, query and flags.
    pub fn rebuild_list(&mut self) {
        self.list = ListModel::build(
            &self.todos,
            &self.views,
            &self.query,
            self.show_hidden,
            self.today,
        );
        self.cursor = self
            .cursor
            .filter(|id| self.row_for(*id).is_some())
            .or_else(|| self.first_todo_id());
        let visible: Vec<usize> = self
            .list
            .rows
            .iter()
            .filter_map(ListRow::todo_index)
            .collect();
        self.range = self
            .range
            .iter()
            .copied()
            .filter(|id| visible.contains(&usize::try_from(id.value()).unwrap_or(usize::MAX)))
            .collect();
        self.clamp_offset();
    }

    /// Replace the query and move the cursor to its end.
    pub fn set_query(&mut self, query: impl Into<String>) {
        self.query = query.into();
        self.query_cursor = self.query.chars().count();
        self.rebuild_list();
    }

    /// Toggle the hidden-todo view and toast the new state.
    ///
    /// The message describes the state the user is leaving, matching the Ink
    /// app's `showHidden ? "Hidden todos hidden" : "Hidden todos shown"`.
    pub fn toggle_hidden_view(&mut self) {
        let was_showing = self.show_hidden;
        self.show_hidden = !self.show_hidden;
        self.rebuild_list();
        self.push_toast(if was_showing {
            "Hidden todos hidden"
        } else {
            "Hidden todos shown"
        });
    }

    /// Rows currently in the row model.
    #[must_use]
    pub fn rows(&self) -> &[ListRow] {
        &self.list.rows
    }

    /// Rows visible in the list viewport.
    #[must_use]
    pub fn visible_rows(&self) -> &[ListRow] {
        self.list.visible(self.offset, self.visible_height())
    }

    /// Number of list rows that fit right now.
    #[must_use]
    pub fn visible_height(&self) -> usize {
        self.layout().list_height as usize
    }

    /// Row index for a todo id, if it is visible.
    #[must_use]
    pub fn row_for(&self, id: TodoId) -> Option<usize> {
        self.list
            .rows
            .iter()
            .position(|row| row.todo_index() == Some(self.index_of(id)))
    }

    /// Load-order index of a todo id, if the id is in range.
    #[must_use]
    pub fn index_of(&self, id: TodoId) -> usize {
        usize::try_from(id.value()).unwrap_or(usize::MAX)
    }

    /// Todo for a load-order index.
    #[must_use]
    pub fn todo_at(&self, index: usize) -> Option<&Todo> {
        self.todos.get(index)
    }

    /// Todo for an id.
    #[must_use]
    pub fn todo_by_id(&self, id: TodoId) -> Option<&Todo> {
        self.todos.iter().find(|todo| todo.id == id)
    }

    /// The cursor todo, if it is still visible.
    #[must_use]
    pub fn selected_todo(&self) -> Option<&Todo> {
        self.cursor.and_then(|id| self.todo_by_id(id))
    }

    /// The selected todos: the range when one is active, otherwise the cursor.
    #[must_use]
    pub fn selected_todos(&self) -> Vec<&Todo> {
        if self.range.is_empty() {
            return self.selected_todo().into_iter().collect();
        }

        self.todos
            .iter()
            .filter(|todo| self.range.contains(&todo.id))
            .collect()
    }

    /// True when a todo is in the shift-selection range.
    #[must_use]
    pub fn is_selected_in_range(&self, id: TodoId) -> bool {
        self.range.contains(&id)
    }

    /// First todo id in the row model.
    #[must_use]
    pub fn first_todo_id(&self) -> Option<TodoId> {
        self.list.rows.iter().find_map(|row| {
            row.todo_index()
                .and_then(|index| self.todos.get(index))
                .map(|todo| todo.id)
        })
    }

    /// Last todo id in the row model.
    #[must_use]
    pub fn last_todo_id(&self) -> Option<TodoId> {
        self.list.rows.iter().rev().find_map(|row| {
            row.todo_index()
                .and_then(|index| self.todos.get(index))
                .map(|todo| todo.id)
        })
    }

    /// Number of digits in the largest todo number, for row alignment.
    #[must_use]
    pub fn max_todo_number_digits(&self) -> usize {
        let count = self.list.rows.iter().filter(|row| row.is_todo()).count();
        count.max(1).to_string().len()
    }

    /// Maximum scroll offset for the current row count and viewport.
    #[must_use]
    pub fn max_offset(&self) -> usize {
        self.list.len().saturating_sub(self.visible_height())
    }

    /// Clamp the scroll offset to the current row count.
    pub fn clamp_offset(&mut self) {
        self.offset = self.offset.min(self.max_offset());
    }

    /// Keep the cursor row inside the viewport.
    ///
    /// This is the TUI's simple equivalent of the Ink app's scroll-padding
    /// rule; the full range-aware version arrives with the navigation parity
    /// work in [`crate::nav`].
    pub fn ensure_cursor_visible(&mut self) {
        let Some(row) = self.cursor.and_then(|id| self.row_for(id)) else {
            return;
        };
        let height = self.visible_height();
        if height == 0 {
            return;
        }
        if row < self.offset {
            self.offset = row;
        } else if row >= self.offset + height {
            self.offset = row + 1 - height;
        }
        self.clamp_offset();
    }

    /// Update the terminal size and keep the offset valid.
    pub fn resize(&mut self, width: u16, height: u16) {
        self.width = width;
        self.height = height;
        self.clamp_offset();
        self.ensure_cursor_visible();
    }

    /// Set today's date, rebuilding the overdue/threshold verdicts only when
    /// the day actually changed (midnight rollover).
    pub fn set_today(&mut self, today: TodoDate) {
        if today == self.today {
            return;
        }
        self.today = today;
        self.rebuild_list();
        self.ensure_cursor_visible();
    }

    /// Show a bounded toast now.
    pub fn push_toast(&mut self, message: impl Into<String>) {
        self.push_toast_at(message, Instant::now());
    }

    /// Show a toast with an explicit clock, for deterministic tests.
    pub fn push_toast_at(&mut self, message: impl Into<String>, now: Instant) {
        self.toast = Some(Toast {
            message: message.into(),
            shown_at: now,
        });
    }

    /// The toast text if it is still visible at `now`.
    #[must_use]
    pub fn toast_message(&self, now: Instant) -> Option<&str> {
        self.toast
            .as_ref()
            .filter(|toast| toast.remaining(now).is_some())
            .map(|toast| toast.message.as_str())
    }

    /// Drop an expired toast so the event loop's poll timeout cannot stay at
    /// zero after it expires.
    pub fn expire_toast(&mut self, now: Instant) {
        if self
            .toast
            .as_ref()
            .is_some_and(|toast| toast.remaining(now).is_none())
        {
            self.toast = None;
        }
    }

    /// How long until the toast expires, for the event loop's poll timeout.
    #[must_use]
    pub fn toast_timeout(&self, now: Instant) -> Option<Duration> {
        self.toast.as_ref().and_then(|toast| toast.remaining(now))
    }

    /// Human-readable name of the current core mode, shown in `--version`
    /// output by CP6's CLI.
    #[must_use]
    pub fn todo_count(&self) -> usize {
        self.todos.len()
    }
}

/// Limits accepted by [`App::new`]'s loader. Kept here so the CLI and tests
/// share the same default.
pub const READ_LIMITS: ReadLimits = ReadLimits::DEFAULT;
