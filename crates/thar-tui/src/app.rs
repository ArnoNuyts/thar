//! Application state for the read-only TUI.
//!
//! The state is deliberately split from the event loop and from rendering:
//! `thar-cli` owns the terminal, `input` maps events to [`crate::input::Command`]s,
//! and `view` reads this struct. Everything here is a plain state transition,
//! so the whole app can be driven by `TestBackend` + synthetic events without a
//! real terminal.
//!
//! # Read-only and write modes
//!
//! The binary is read-only unless `--write` is passed. In read-only mode the
//! mutating keys are rejected in [`crate::input`] with one bounded toast. In
//! write mode they call the mutation API here, which records one undo step per
//! command and schedules a debounced save. The actual filesystem write lives
//! in `thar-cli`/`thar-store`; this crate only queues [`Effect`]s.

use std::time::{Duration, Instant};

use ratatui::crossterm::event::KeyEvent;
use thar_core::{MAX_PASTE_TODOS, MAX_TODOS, Priority, Todo, TodoDate, TodoId};

use crate::display::sanitize_for_display;
use crate::history::History;
use crate::input::MouseInput;
use crate::layout::Layout;
use crate::list::{ListModel, ListRow};
use crate::modal::{self, Action, ConfirmRequest, ModalId, Outcome, Stack, TagKind, UpdateModel};
use crate::search::{OwnedView, view_for};
use crate::suggest::{Suggestions, TagSources};

/// Debounce before a mutation is written, matching the Ink app.
pub const SAVE_DEBOUNCE: Duration = Duration::from_millis(50);

/// Lines above which a clipboard paste asks for confirmation, matching
/// `useTodoCommands`.
pub const PASTE_CONFIRM_THRESHOLD: usize = 10;

/// Backoff before retrying a failed save.
pub const SAVE_RETRY: Duration = Duration::from_secs(1);

/// Toast shown when a write-enabled session lost its file.
pub const NOT_SAVED_MESSAGE: &str = "Not saved: read-only";

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
    /// Row index for each load-order todo id, or `None` when filtered out.
    /// Kept in step with `list` by [`App::recompute_rows`].
    row_of: Vec<Option<usize>>,
    /// Local calendar day used by the overdue and threshold rules.
    pub today: TodoDate,
    /// Current search query, before normalization.
    pub query: String,
    /// Cursor position in `query`, in characters (not bytes).
    pub query_cursor: usize,
    /// True while the search bar has keyboard focus.
    pub search_focused: bool,
    /// Filtered project/context suggestions for the search bar.
    pub search_suggestions: Suggestions,
    /// Tag sources cached from the current list.
    tag_sources: TagSources,
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
    /// last good list in memory and refuses to write until a reload succeeds.
    pub load_error: Option<String>,
    /// True when the process should exit.
    pub should_quit: bool,
    /// False only when `--write` was passed and the file loaded cleanly.
    pub read_only: bool,
    /// Next id handed to a todo created in this session.
    next_id: u64,
    /// Undo/redo snapshots.
    pub history: History,
    /// The one active modal, if any.
    pub modals: Stack,
    /// Update information supplied by the host. `None` means the list's `u`
    /// key cannot open the update screen; CP7 does not check for updates.
    pub update_model: Option<UpdateModel>,
    /// True when the in-memory list differs from the last saved bytes.
    pub dirty: bool,
    /// When the first unsaved mutation happened, for the save debounce.
    pub dirty_at: Option<Instant>,
    /// The last save failure, kept until the next successful save.
    pub save_error: Option<String>,
    /// Earliest time to retry a failed save.
    save_retry_at: Option<Instant>,
    /// Host effects produced by a command and drained by the event loop.
    pub effects: Vec<Effect>,
}

/// An operation that needs the host (filesystem or clipboard).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Effect {
    /// Append every completed todo to `done.txt`, then remove them.
    ArchiveCompleted,
    /// Copy this exact text to the clipboard.
    Copy(String),
    /// Read the clipboard and add its lines as todos.
    Paste,
}

impl App {
    /// Create the app for an already-loaded, read-only todo list.
    #[must_use]
    pub fn new(filename: impl Into<String>, todos: Vec<Todo>, today: TodoDate) -> Self {
        let views: Vec<OwnedView> = todos.iter().map(view_for).collect();
        let tag_sources = TagSources::collect(&todos);
        let next_id = todos
            .iter()
            .map(|todo| todo.id.value().saturating_add(1))
            .max()
            .unwrap_or(0);

        let mut app = Self {
            filename: filename.into(),
            todos,
            views,
            list: ListModel::default(),
            row_of: Vec::new(),
            today,
            query: String::new(),
            query_cursor: 0,
            search_focused: false,
            search_suggestions: Suggestions::new(),
            tag_sources,
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
            next_id,
            history: History::default(),
            modals: Stack::default(),
            update_model: None,
            dirty: false,
            dirty_at: None,
            save_error: None,
            save_retry_at: None,
            effects: Vec::new(),
        };
        app.recompute_rows();
        app.cursor = app.first_todo_id();
        crate::nav::reflow(&mut app);
        app
    }

    /// Replace the whole list (initial load or a reload) and reset selection
    /// metadata that refers to the previous list.
    pub fn set_todos(&mut self, todos: Vec<Todo>) {
        self.todos = todos;
        self.views = self.todos.iter().map(view_for).collect();
        self.tag_sources = TagSources::collect(&self.todos);
        self.refresh_search_suggestions();
        self.range.clear();
        self.anchor = None;
        self.cursor = None;
        self.next_id = self
            .todos
            .iter()
            .map(|todo| todo.id.value().saturating_add(1))
            .max()
            .unwrap_or(0);
        self.history.clear();
        self.dirty = false;
        self.dirty_at = None;
        self.save_error = None;
        self.modals.close();
        self.recompute_rows();
        self.cursor = self.first_todo_id();
        crate::nav::reflow(self);
    }

    /// Apply a successful file reload: replace the list and leave the read-only
    /// recovery state.
    ///
    /// [`App::set_todos`] already clears both undo stacks, the pending save and
    /// the save error; the external file wins over unsaved in-memory edits.
    /// Clearing `load_error` re-enables writes through [`App::writable`], which
    /// is the Ink app's recovery path after a fixed file.
    pub fn reloaded(&mut self, todos: Vec<Todo>) {
        self.set_todos(todos);
        self.load_error = None;
    }

    /// Clear a previous reload failure after the file was rewritten with the
    /// bytes this session already accepts.
    ///
    /// This is the "same bytes restored" recovery path: there is no new list to
    /// adopt, but [`App::writable`] must turn true again and the banner must
    /// disappear.
    pub fn recovered(&mut self) {
        self.load_error = None;
        self.save_error = None;
        self.save_retry_at = None;
    }

    /// Record a failed file reload.
    ///
    /// The last good list stays in memory, but it must not be written: the
    /// pending save is cancelled and [`App::writable`] turns false until a
    /// later reload succeeds. The message is already bounded by the caller and
    /// is shown as one toast.
    pub fn reload_failed(&mut self, message: impl Into<String>) {
        let message = message.into();
        self.load_error = Some(message.clone());
        self.dirty = false;
        self.dirty_at = None;
        self.save_retry_at = None;
        self.save_error = None;
        self.push_toast(message);
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
    ///
    /// Only the rows and the id-to-row map change; selection and scrolling are
    /// reconciled by [`crate::nav::rebuild`], which is the single
    /// `reconcileNavState` implementation. Calling this directly would leave a
    /// cursor pointing at a row that no longer exists.
    pub(crate) fn recompute_rows(&mut self) {
        self.list = ListModel::build(
            &self.todos,
            &self.views,
            &self.query,
            self.show_hidden,
            self.today,
        );

        self.row_of = vec![None; self.todos.len()];
        for (row, entry) in self.list.rows.iter().enumerate() {
            if let Some(index) = entry.todo_index()
                && let Some(slot) = self.row_of.get_mut(index)
            {
                *slot = Some(row);
            }
        }

        self.clamp_offset();
    }

    /// Replace the query, move the cursor to its end, and reconcile selection.
    pub fn set_query(&mut self, query: impl Into<String>) {
        self.query = query.into();
        self.query_cursor = self.query.chars().count();
        self.refresh_search_suggestions();
        crate::nav::rebuild(self);
    }

    /// Toggle the hidden-todo view, reconcile selection, and toast the state.
    ///
    /// The message describes the state the user is leaving, matching the Ink
    /// app's `showHidden ? "Hidden todos hidden" : "Hidden todos shown"`.
    pub fn toggle_hidden_view(&mut self) {
        let was_showing = self.show_hidden;
        self.show_hidden = !self.show_hidden;
        crate::nav::rebuild(self);
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
    ///
    /// `row_of` is indexed in O(1) by the todo's current vector position; the
    /// position lookup itself is O(n) because ids are stable and no longer
    /// equal their index.
    #[must_use]
    pub fn row_for(&self, id: TodoId) -> Option<usize> {
        let index = self.index_of(id);
        self.todos
            .get(index)
            .filter(|todo| todo.id == id)
            .and_then(|_| self.row_of.get(index).copied().flatten())
    }

    /// Current position of a todo id in load order.
    ///
    /// Ids are stable for the life of the session but no longer equal the
    /// index: create/delete/paste shift the vector. A missing id returns
    /// `usize::MAX`, which callers treat as "not found".
    #[must_use]
    pub fn index_of(&self, id: TodoId) -> usize {
        self.todos
            .iter()
            .position(|todo| todo.id == id)
            .unwrap_or(usize::MAX)
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

    /// Update the terminal size and re-derive the scroll offset.
    ///
    /// The event loop calls this before every draw; an unchanged size must be a
    /// no-op, otherwise reflowing would pull a wheel-scrolled viewport back to
    /// the cursor on every frame.
    pub fn resize(&mut self, width: u16, height: u16) {
        if width == self.width && height == self.height {
            return;
        }
        self.width = width;
        self.height = height;
        self.modals.resize(width, height);
        crate::nav::reflow(self);
    }

    /// Set today's date, rebuilding the overdue/threshold verdicts only when
    /// the day actually changed (midnight rollover).
    pub fn set_today(&mut self, today: TodoDate) {
        if today == self.today {
            return;
        }
        self.today = today;
        crate::nav::rebuild(self);
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

    // ---- CP7: mutation, history, save and modal plumbing -------------------

    /// True when a command may change the file.
    #[must_use]
    pub fn writable(&self) -> bool {
        !self.read_only && self.load_error.is_none()
    }

    /// Allocate a stable id for a todo created in this session.
    fn allocate_id(&mut self) -> TodoId {
        let id = TodoId::new(self.next_id);
        self.next_id = self.next_id.saturating_add(1);
        id
    }

    /// Gate a mutating command.
    ///
    /// A read-only binary refuses the command. A write-enabled session whose
    /// last load failed still mutates in memory but never saves, matching the
    /// Ink app's read-only recovery state.
    fn begin_mutation(&mut self) -> bool {
        if self.read_only {
            self.push_toast(crate::input::READ_ONLY_MESSAGE);
            return false;
        }
        true
    }

    /// Snapshot the current list before a mutation.
    fn record_history(&mut self) {
        self.history.record(&self.todos);
    }

    /// Mark the list dirty at `now` so the event loop schedules a save.
    pub fn mark_dirty(&mut self) {
        self.dirty = true;
        self.dirty_at = Some(Instant::now());
        self.save_retry_at = None;
    }

    /// Finish a mutation: reconcile the row model and schedule a save.
    fn finish_mutation(&mut self) {
        self.tag_sources = TagSources::collect(&self.todos);
        self.refresh_search_suggestions();
        crate::nav::rebuild(self);
        if self.load_error.is_some() {
            self.push_toast(NOT_SAVED_MESSAGE);
        } else {
            self.mark_dirty();
        }
    }

    /// Refresh the search bar's suggestion list from the current query.
    pub fn refresh_search_suggestions(&mut self) {
        if self.search_focused {
            self.search_suggestions
                .update(&self.tag_sources, &self.query, self.query_cursor);
        } else {
            self.search_suggestions.clear();
        }
    }

    /// Close the search suggestion popup without changing the filter.
    pub fn clear_search_suggestions(&mut self) {
        self.search_suggestions.clear();
    }

    /// The search popup anchor and filtered list, if one should be drawn.
    #[must_use]
    pub fn search_overlay(&self, layout: Layout) -> Option<crate::suggest::Overlay<'_>> {
        if !self.search_focused || !self.search_suggestions.is_open() {
            return None;
        }
        let start = self.search_suggestions.start();
        let before: String = self.query.chars().take(start).collect();
        let width = u16::try_from(ratatui::text::Line::from(sanitize_for_display(&before)).width())
            .unwrap_or(u16::MAX);
        Some(crate::suggest::Overlay {
            anchor: crate::suggest::Anchor {
                x: 3_u16.saturating_add(width),
                y: layout.search_border_row(),
            },
            suggestions: &self.search_suggestions,
        })
    }

    /// Apply `update` to every todo whose id is in `ids`.
    ///
    /// One call records one undo step, even when it touches many todos, which
    /// is the Ink provider's grouping.
    pub fn update_ids<F>(&mut self, ids: &[TodoId], mut update: F)
    where
        F: FnMut(&Todo) -> Todo,
    {
        if ids.is_empty() || !self.begin_mutation() {
            return;
        }
        self.record_history();
        for id in ids {
            if let Some(index) = self.todos.iter().position(|todo| todo.id == *id) {
                let updated = update(&self.todos[index]);
                self.views[index] = view_for(&updated);
                self.todos[index] = updated;
            }
        }
        self.finish_mutation();
    }

    /// Append one todo per line and select the first added todo.
    ///
    /// Returns the new ids; an empty result means the command was refused.
    pub fn add_todos(&mut self, texts: &[String]) -> Vec<TodoId> {
        if texts.is_empty() || !self.begin_mutation() {
            return Vec::new();
        }
        if self.todos.len().saturating_add(texts.len()) > MAX_TODOS {
            self.push_toast(format!("Too many todos; the limit is {MAX_TODOS}"));
            return Vec::new();
        }

        self.record_history();
        let today = self.today;
        let mut added = Vec::with_capacity(texts.len());
        for text in texts {
            let id = self.allocate_id();
            let todo = Todo::parse_line(text, id).set_creation_date(today);
            self.views.push(view_for(&todo));
            self.todos.push(todo);
            added.push(id);
        }
        self.finish_mutation();
        if let Some(first) = added.first().copied() {
            self.cursor = Some(first);
            self.range.clear();
            self.anchor = None;
            crate::nav::reflow(self);
        }
        added
    }

    /// Delete every todo whose id is in `ids`.
    pub fn remove_ids(&mut self, ids: &[TodoId]) {
        if ids.is_empty() || !self.begin_mutation() {
            return;
        }
        self.record_history();
        self.todos.retain(|todo| !ids.contains(&todo.id));
        self.views = self.todos.iter().map(view_for).collect();
        self.finish_mutation();
    }

    /// Flip open/done on `ids`, appending the recurrence copies.
    pub fn toggle_ids(&mut self, ids: &[TodoId]) {
        if ids.is_empty() || !self.begin_mutation() {
            return;
        }
        self.record_history();
        let today = self.today;
        let mut recurring = Vec::new();
        let mut errors = Vec::new();

        for id in ids {
            if let Some(index) = self.todos.iter().position(|todo| todo.id == *id) {
                let next_id = self.allocate_id();
                let result = self.todos[index].toggle_state(today, next_id);
                self.views[index] = view_for(&result.updated);
                self.todos[index] = result.updated;
                if let Some(copy) = result.recurring {
                    recurring.push(copy);
                }
                if let Some(error) = result.recurrence_error {
                    errors.push(error.message().to_owned());
                }
            }
        }

        for copy in recurring {
            self.views.push(view_for(&copy));
            self.todos.push(copy);
        }

        self.finish_mutation();
        if let Some(error) = errors.first() {
            self.push_toast(error.clone());
        }
    }

    /// Set or clear a priority on `ids`.
    pub fn set_priority_ids(&mut self, ids: &[TodoId], priority: Option<char>) {
        let priority = priority.and_then(Priority::new);
        self.update_ids(ids, |todo| todo.clone().set_priority(priority));
    }

    /// Set or remove `due:` on `ids`.
    pub fn set_due_ids(&mut self, ids: &[TodoId], date: Option<TodoDate>) {
        self.update_ids(ids, |todo| match date {
            Some(date) => todo.clone().set_due(date),
            None => todo.clone().remove_due(),
        });
    }

    /// Set or remove `t:` on `ids`.
    pub fn set_threshold_ids(&mut self, ids: &[TodoId], date: Option<TodoDate>) {
        self.update_ids(ids, |todo| match date {
            Some(date) => todo.clone().set_threshold(date),
            None => todo.clone().remove_threshold(),
        });
    }

    /// Set or remove `rec:` on `ids`.
    pub fn set_recurrence_ids(&mut self, ids: &[TodoId], value: Option<String>) {
        self.update_ids(ids, |todo| match value.as_deref() {
            Some(value) => todo.clone().set_recurrence(value),
            None => todo.clone().remove_recurrence(),
        });
    }

    /// Add a project or context token to `ids`.
    pub fn add_tag_ids(&mut self, ids: &[TodoId], kind: TagKind, name: &str) {
        self.update_ids(ids, |todo| match kind {
            TagKind::Project => todo.clone().add_project(name),
            TagKind::Context => todo.clone().add_context(name),
        });
    }

    /// Remove a project or context token from `ids`.
    pub fn remove_tag_ids(&mut self, ids: &[TodoId], kind: TagKind, name: &str) {
        self.update_ids(ids, |todo| match kind {
            TagKind::Project => todo.clone().remove_project(name),
            TagKind::Context => todo.clone().remove_context(name),
        });
    }

    /// Undo one mutation.
    pub fn undo(&mut self) -> bool {
        if self.read_only {
            self.push_toast(crate::input::READ_ONLY_MESSAGE);
            return false;
        }
        let Some(previous) = self.history.undo(&self.todos) else {
            return false;
        };
        self.todos = previous;
        self.views = self.todos.iter().map(view_for).collect();
        self.finish_mutation();
        true
    }

    /// Redo one undo.
    pub fn redo(&mut self) -> bool {
        if self.read_only {
            self.push_toast(crate::input::READ_ONLY_MESSAGE);
            return false;
        }
        let Some(next) = self.history.redo(&self.todos) else {
            return false;
        };
        self.todos = next;
        self.views = self.todos.iter().map(view_for).collect();
        self.finish_mutation();
        true
    }

    /// Serialized lines for `ids`, in load order, joined by `\n`.
    #[must_use]
    pub fn copy_text(&self, ids: &[TodoId]) -> String {
        self.todos
            .iter()
            .filter(|todo| ids.contains(&todo.id))
            .map(Todo::serialize)
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Copies of the todos with `ids`, in load order.
    #[must_use]
    pub fn todos_by_ids(&self, ids: &[TodoId]) -> Vec<Todo> {
        self.todos
            .iter()
            .filter(|todo| ids.contains(&todo.id))
            .cloned()
            .collect()
    }

    /// Ids of every completed todo, in load order.
    #[must_use]
    pub fn completed_ids(&self) -> Vec<TodoId> {
        self.todos
            .iter()
            .filter(|todo| todo.is_done())
            .map(|todo| todo.id)
            .collect()
    }

    /// Split clipboard text into todo lines and add them, confirming above ten.
    ///
    /// The clipboard read stays in the terminal (it needs the host); this
    /// method owns the limits and the confirmation so both are testable
    /// without a clipboard. A batch larger than [`MAX_PASTE_TODOS`] is
    /// rejected before any confirmation, matching `validateTodoBatch` in
    /// `useTodoCommands`.
    pub fn receive_clipboard(&mut self, text: &str) {
        let lines: Vec<String> = text
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_owned)
            .collect();
        if lines.is_empty() {
            return;
        }
        if lines.len() > MAX_PASTE_TODOS {
            self.push_toast(format!(
                "Too many todos in one paste; the limit is {MAX_PASTE_TODOS}"
            ));
            return;
        }
        if lines.len() > PASTE_CONFIRM_THRESHOLD {
            self.modals.open(modal::registry_menu::confirm(
                ConfirmRequest::paste(lines.len(), lines),
                self.width,
                self.height,
            ));
            return;
        }
        self.apply_action(Action::PasteLines { lines });
    }

    /// Take the host effects queued by commands.
    pub fn take_effects(&mut self) -> Vec<Effect> {
        std::mem::take(&mut self.effects)
    }

    /// Deadline of the pending debounced save.
    ///
    /// A failed save keeps the list dirty and pushes the deadline out by
    /// [`SAVE_RETRY`], so a transient filesystem error retries instead of
    /// silently dropping the edit.
    #[must_use]
    pub fn save_deadline(&self) -> Option<Instant> {
        let debounce = self.dirty_at.map(|at| at + SAVE_DEBOUNCE);
        match (debounce, self.save_retry_at) {
            (Some(debounce), Some(retry)) => Some(debounce.max(retry)),
            (Some(debounce), None) => Some(debounce),
            (None, Some(retry)) => Some(retry),
            (None, None) => None,
        }
    }

    /// Poll timeout until the pending save, for the event loop.
    #[must_use]
    pub fn save_timeout(&self, now: Instant) -> Option<Duration> {
        if !self.dirty {
            return None;
        }
        self.save_deadline()
            .map(|deadline| deadline.saturating_duration_since(now))
    }

    /// True when the debounced save should run now.
    #[must_use]
    pub fn save_due(&self, now: Instant) -> bool {
        self.dirty && self.save_deadline().is_some_and(|deadline| now >= deadline)
    }

    /// Record a successful save.
    pub fn mark_saved(&mut self) {
        self.dirty = false;
        self.dirty_at = None;
        self.save_retry_at = None;
        self.save_error = None;
    }

    /// Record a save failure, keep the list dirty, and schedule a retry.
    ///
    /// The toast is shown once per distinct message; a retrying save on the
    /// same error does not spam the action bar.
    pub fn mark_save_failed(&mut self, message: impl Into<String>) {
        let message = message.into();
        let changed = self.save_error.as_deref() != Some(message.as_str());
        self.dirty = true;
        self.save_retry_at = Some(Instant::now() + SAVE_RETRY);
        self.save_error = Some(message.clone());
        if changed {
            self.push_toast(format!("Save failed: {message}"));
        }
    }

    /// Route a key press to the active modal.
    ///
    /// Returns true when a modal consumed the key, so the list keymap never
    /// sees it.
    pub fn handle_modal_key(&mut self, key: KeyEvent) -> bool {
        let Some(modal) = self.modals.top_mut() else {
            return false;
        };
        let outcome = modal.handle_key(key);
        self.apply_outcome(outcome);
        true
    }

    /// Route a mouse event to the active modal.
    pub fn handle_modal_mouse(&mut self, mouse: MouseInput) -> bool {
        let Some(modal) = self.modals.top_mut() else {
            return false;
        };
        let outcome = modal.handle_mouse(mouse);
        self.apply_outcome(outcome);
        true
    }

    /// Route a bracketed paste to the active modal.
    pub fn handle_modal_paste(&mut self, text: &str) -> bool {
        let Some(modal) = self.modals.top_mut() else {
            return false;
        };
        let outcome = modal.handle_paste(text);
        self.apply_outcome(outcome);
        true
    }

    fn apply_outcome(&mut self, outcome: Outcome) {
        match outcome {
            Outcome::Continue => {}
            Outcome::Close => self.modals.close(),
            Outcome::Replace(modal) => self.modals.open(modal),
            Outcome::Actions(actions) => {
                for action in actions {
                    self.apply_action(action);
                }
            }
        }
    }

    /// Open a screen by id.
    pub fn open_modal(&mut self, id: ModalId) {
        self.clear_search_suggestions();
        match modal::registry::open(self, id) {
            Some(modal) => self.modals.open(modal),
            None => self.push_toast("That screen is not available in this build yet"),
        }
    }

    /// Apply one modal action.
    pub fn apply_action(&mut self, action: Action) {
        match action {
            Action::Close => self.modals.close(),
            Action::Toast(message) => self.push_toast(message),
            Action::Open(id) => self.open_modal(id),
            Action::AddTodos(texts) => {
                let _ = self.add_todos(&texts);
                self.modals.close();
            }
            Action::UpdateText { ids, text } => {
                self.update_ids(&ids, |todo| todo.clone().set_text(&text, true));
                self.modals.close();
            }
            Action::Delete { ids } => {
                self.remove_ids(&ids);
                self.modals.close();
            }
            Action::Toggle { ids } => {
                self.toggle_ids(&ids);
                self.modals.close();
            }
            Action::ToggleHidden { ids } => {
                self.update_ids(&ids, |todo| todo.clone().toggle_hidden());
                self.modals.close();
            }
            Action::SetDue { ids, date } => {
                self.set_due_ids(&ids, date);
                self.modals.close();
            }
            Action::SetThreshold { ids, date } => {
                self.set_threshold_ids(&ids, date);
                self.modals.close();
            }
            Action::SetPriority { ids, priority } => {
                self.set_priority_ids(&ids, priority);
                self.modals.close();
            }
            Action::SetRecurrence { ids, value } => {
                self.set_recurrence_ids(&ids, value);
                self.modals.close();
            }
            Action::AddTag { ids, kind, name } => {
                self.add_tag_ids(&ids, kind, &name);
                self.modals.close();
            }
            Action::RemoveTag { ids, kind, name } => {
                self.remove_tag_ids(&ids, kind, &name);
                self.modals.close();
            }
            Action::Undo => {
                self.undo();
                self.modals.close();
            }
            Action::Redo => {
                self.redo();
                self.modals.close();
            }
            Action::ToggleHiddenView => {
                self.toggle_hidden_view();
                self.modals.close();
            }
            Action::Copy { ids } => {
                let text = self.copy_text(&ids);
                if text.is_empty() {
                    self.push_toast("Nothing to copy");
                } else {
                    self.effects.push(Effect::Copy(text));
                }
                self.modals.close();
            }
            Action::Paste => {
                self.effects.push(Effect::Paste);
                self.modals.close();
            }
            Action::PasteLines { lines } => {
                let added = self.add_todos(&lines);
                if !added.is_empty() && self.writable() {
                    self.push_toast(format!("Pasted {} todo(s)", added.len()));
                }
                self.modals.close();
            }
            Action::ArchiveCompleted => {
                self.effects.push(Effect::ArchiveCompleted);
                self.modals.close();
            }
            Action::Confirm(request) => {
                self.modals.open(modal::registry_menu::confirm(
                    request,
                    self.width,
                    self.height,
                ));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{App, SAVE_DEBOUNCE};
    use crate::modal::{Action, Modal};
    use ratatui::crossterm::event::KeyEvent;
    use std::time::{Duration, Instant};
    use thar_core::{Todo, TodoDate, TodoId};

    fn app(lines: &[&str]) -> App {
        let todos = lines
            .iter()
            .enumerate()
            .map(|(index, line)| Todo::parse_line(line, TodoId::new(index as u64)))
            .collect();
        let mut app = App::new(
            "todo.txt",
            todos,
            TodoDate::parse("2026-11-15").expect("valid date"),
        );
        app.read_only = false;
        app
    }

    #[test]
    fn read_only_refuses_mutations() {
        let mut app = app(&["one"]);
        app.read_only = true;
        app.toggle_ids(
            &app.selected_todos()
                .iter()
                .map(|todo| todo.id)
                .collect::<Vec<_>>(),
        );
        assert!(!app.todos[0].is_done());
        assert!(!app.dirty);
        assert_eq!(
            app.toast_message(Instant::now()),
            Some(crate::input::READ_ONLY_MESSAGE)
        );
    }

    #[test]
    fn toggle_records_one_undo_step_and_marks_dirty() {
        let mut app = app(&["one", "two"]);
        let ids = vec![app.todos[0].id, app.todos[1].id];
        app.toggle_ids(&ids);
        assert!(app.todos.iter().all(Todo::is_done));
        assert!(app.dirty && app.dirty_at.is_some());
        assert_eq!(app.history.undo_len(), 1);
        assert_eq!(app.history.redo_len(), 0);

        assert!(app.undo());
        assert!(app.todos.iter().all(|todo| !todo.is_done()));
        assert_eq!(app.history.redo_len(), 1);
        assert!(app.redo());
        assert!(app.todos.iter().all(Todo::is_done));
    }

    #[test]
    fn create_assigns_stable_ids_and_delete_keeps_the_rest() {
        let mut app = app(&["one", "two"]);
        let added = app.add_todos(&["three".to_owned(), "four".to_owned()]);
        assert_eq!(added.len(), 2);
        assert_ne!(added[0], app.todos[0].id);
        assert_ne!(added[1], added[0]);
        assert_eq!(app.todos[2].id, added[0]);
        assert_eq!(app.cursor, Some(added[0]));

        app.remove_ids(&[app.todos[1].id]);
        assert_eq!(app.todos.len(), 3);
        assert!(app.todos.iter().any(|todo| todo.id == added[1]));
        assert!(app.todos.iter().all(|todo| todo.id != TodoId::new(1)));
    }

    #[test]
    fn priority_due_and_tags_go_through_one_history_step() {
        let mut app = app(&["one"]);
        let ids = vec![app.todos[0].id];
        app.set_priority_ids(&ids, Some('B'));
        assert_eq!(
            app.todos[0].priority.map(|priority| priority.as_char()),
            Some('B')
        );
        app.set_due_ids(&ids, Some(TodoDate::parse("2026-12-01").unwrap()));
        assert_eq!(app.todos[0].date_tag("due"), TodoDate::parse("2026-12-01"));
        app.add_tag_ids(&ids, crate::modal::TagKind::Project, "thar");
        assert!(app.todos[0].text.contains("+thar"));
        assert_eq!(app.history.undo_len(), 3);
    }

    #[test]
    fn recurrence_toggle_appends_the_next_instance() {
        let mut app = app(&["water plants rec:1w due:2026-11-10"]);
        let id = app.todos[0].id;
        app.toggle_ids(&[id]);
        assert!(app.todos[0].is_done());
        assert_eq!(app.todos.len(), 2);
        let copy = &app.todos[1];
        assert!(!copy.is_done());
        assert_eq!(copy.date_tag("due"), TodoDate::parse("2026-11-22"));
    }

    #[test]
    fn the_save_deadline_is_the_debounce_from_the_first_mutation() {
        let mut app = app(&["one"]);
        assert_eq!(app.save_deadline(), None);
        app.toggle_ids(&[app.todos[0].id]);
        let deadline = app.save_deadline().expect("deadline");
        assert!(app.save_timeout(Instant::now()).is_some());
        assert!(!app.save_due(deadline - Duration::from_millis(1)));
        assert!(app.save_due(deadline));
        app.mark_saved();
        assert!(!app.dirty && app.save_deadline().is_none());
        assert!(SAVE_DEBOUNCE >= Duration::from_millis(1));
    }

    #[test]
    fn a_large_paste_confirms_before_adding_anything() {
        let mut app = app(&["one"]);
        let text = (1..=11)
            .map(|index| format!("pasted {index}"))
            .collect::<Vec<_>>()
            .join("\n");

        app.receive_clipboard(&text);
        assert_eq!(app.todos.len(), 1, "nothing is added before confirmation");
        let modal = app.modals.top().expect("paste confirmation");
        assert_eq!(modal.title(), "Paste Multiple Todos");
        assert_eq!(
            app.modals.top().map(|modal| modal.id()),
            Some(crate::modal::ModalId::Confirm)
        );

        let enter = KeyEvent::new(
            ratatui::crossterm::event::KeyCode::Enter,
            ratatui::crossterm::event::KeyModifiers::NONE,
        );
        assert!(app.handle_modal_key(enter));
        assert_eq!(app.todos.len(), 12);
        assert!(!app.modals.is_open());
        assert!(app.dirty);
        assert_eq!(app.toast_message(Instant::now()), Some("Pasted 11 todo(s)"));
    }

    #[test]
    fn a_ten_line_paste_adds_without_a_confirmation() {
        let mut app = app(&["one"]);
        let text = (1..=10)
            .map(|index| format!("pasted {index}"))
            .collect::<Vec<_>>()
            .join("\n");
        app.receive_clipboard(&text);
        assert_eq!(app.todos.len(), 11);
        assert!(!app.modals.is_open());
    }

    #[test]
    fn a_paste_over_the_hard_limit_is_rejected_with_one_message() {
        let mut app = app(&["one"]);
        let text = (1..=101)
            .map(|index| format!("pasted {index}"))
            .collect::<Vec<_>>()
            .join("\n");
        app.receive_clipboard(&text);
        assert_eq!(app.todos.len(), 1);
        assert!(!app.modals.is_open());
        let message = app.toast_message(Instant::now()).expect("toast");
        assert!(message.contains("limit is 100"), "{message}");
    }

    #[test]
    fn the_delete_confirmation_carries_the_delete_action() {
        let mut app = app(&["one", "two"]);
        let ids = vec![app.todos[1].id];
        app.apply_action(Action::Confirm(crate::modal::ConfirmRequest::delete(
            ids.clone(),
        )));
        assert_eq!(
            app.modals.top().map(|modal| modal.id()),
            Some(crate::modal::ModalId::Confirm)
        );
        assert_eq!(app.modals.top().map(Modal::title), Some("Delete Todo"));

        let enter = KeyEvent::new(
            ratatui::crossterm::event::KeyCode::Enter,
            ratatui::crossterm::event::KeyModifiers::NONE,
        );
        app.handle_modal_key(enter);
        assert_eq!(app.todos.len(), 1);
        assert_eq!(app.todos[0].text, "one");
    }

    #[test]
    fn the_archive_confirmation_queues_the_host_effect() {
        let mut app = app(&["x 2026-11-01 done", "open"]);
        app.apply_action(Action::Confirm(crate::modal::ConfirmRequest::archive()));
        let enter = KeyEvent::new(
            ratatui::crossterm::event::KeyCode::Enter,
            ratatui::crossterm::event::KeyModifiers::NONE,
        );
        app.handle_modal_key(enter);
        assert_eq!(app.take_effects(), vec![crate::Effect::ArchiveCompleted]);
        assert!(!app.modals.is_open());
    }

    #[test]
    fn the_update_model_is_absent_by_default() {
        let app = app(&["one"]);
        assert!(app.update_model.is_none());
    }

    #[test]
    fn a_failed_save_stays_dirty_and_retries_after_the_backoff() {
        let mut app = app(&["one"]);
        app.toggle_ids(&[app.todos[0].id]);
        app.mark_save_failed("disk full");
        assert!(app.dirty, "a failed save must not drop the edit");
        assert_eq!(app.save_error.as_deref(), Some("disk full"));
        assert!(!app.save_due(Instant::now()));
        assert!(app.save_due(Instant::now() + super::SAVE_RETRY + Duration::from_millis(1)));
        app.mark_saved();
        assert!(!app.dirty);
        assert!(app.save_error.is_none());
    }
}
