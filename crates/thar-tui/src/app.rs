//! Application state for the read-only TUI.
//!
//! The state is deliberately split from the event loop and from rendering:
//! `thar-cli` owns the terminal, `input` maps events to [`crate::input::Command`]s,
//! and `view` reads this struct through its accessors. Everything here is a
//! plain state transition, so the whole app can be driven by `TestBackend` +
//! synthetic events without a real terminal.
//!
//! # Invariants
//!
//! The per-todo entries, the row model and the id-to-row map are written only
//! by `App` and its private helpers. External callers read them through
//! [`App::todos`], [`App::rows`] and the id/row lookups; they mutate them
//! through the mutation API, which records history, reconciles the selection
//! and schedules the save in one place.
//!
//! Each `TodoEntry` owns one `Rc<Todo>` handle and the search view cached for
//! it, so the handle and the view for a todo are replaced together and a row
//! build cannot see them out of step. A mutation replaces only the touched
//! entry, so an undo snapshot shares every untouched todo with the live list
//! instead of deep-cloning the whole file.
//!
//! # Read-only and write modes
//!
//! The binary is read-only unless `--write` is passed. In read-only mode the
//! mutating keys are rejected in [`crate::input`] with one bounded toast. In
//! write mode they call the mutation API here, which records one undo step per
//! command and schedules a debounced save. The actual filesystem write lives
//! in `thar-cli`/`thar-store`; this crate only queues [`Effect`]s.
//!
//! Every mutation and modal action takes an explicit [`Instant`], so the save
//! debounce and retry state are deterministic in tests. Convenience toasts that
//! are not part of the save state may still use the host clock.

use std::ops::Index;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::{Duration, Instant};

use ratatui::crossterm::event::KeyEvent;
use thar_core::{
    MAX_PASTE_TODOS, Priority, Recurrence, Todo, TodoDate, TodoId, TodoInputError, js_trim,
    validate_todo_batch,
};

use crate::display::sanitize_for_display;
use crate::entry::TodoEntry;
use crate::event::MouseInput;
use crate::history::History;
use crate::layout::Layout;
use crate::list::{ListModel, ListRow};
use crate::messages::READ_ONLY_MESSAGE;
use crate::modal::{
    self, Action, ConfirmRequest, ModalId, OpenError, Outcome, Stack, TagKind, UpdateModel,
};
use crate::search_bar::SearchBar;
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

/// The cursor, anchor and range of the list selection.
///
/// `range` is empty for a cursor-only selection. The three fields move
/// together: [`crate::nav`] is the only writer outside `App`, and it keeps the
/// anchor and range consistent with the cursor.
#[derive(Debug, Default)]
pub(crate) struct Selection {
    pub(crate) cursor: Option<TodoId>,
    pub(crate) anchor: Option<TodoId>,
    pub(crate) range: Vec<TodoId>,
}

/// A borrowed, allocation-free view of the app's todos.
///
/// [`App::todos`] returns this instead of collecting a `Vec<&Todo>`, so a caller
/// that indexes, iterates, or counts the list does not allocate. The view also
/// implements [`Iterator`] and [`ExactSizeIterator`] over the todo references;
/// [`Todos::iter`] returns a fresh view from the start.
#[derive(Clone, Copy, Debug)]
pub struct Todos<'a> {
    todos: &'a [TodoEntry],
    position: usize,
}

impl<'a> Todos<'a> {
    /// Number of todos in the view.
    #[must_use]
    pub fn len(&self) -> usize {
        self.todos.len()
    }

    /// True when the list holds no todos.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.todos.is_empty()
    }

    /// The todo at a load-order index.
    #[must_use]
    pub fn get(&self, index: usize) -> Option<&'a Todo> {
        self.todos.get(index).map(TodoEntry::todo)
    }

    /// A fresh iterator over every todo, in load order.
    #[must_use]
    pub fn iter(&self) -> Todos<'a> {
        Todos {
            todos: self.todos,
            position: 0,
        }
    }
}

impl<'a> Iterator for Todos<'a> {
    type Item = &'a Todo;

    fn next(&mut self) -> Option<Self::Item> {
        let todo = self.todos.get(self.position)?;
        self.position += 1;
        Some(todo.todo())
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        let remaining = self.todos.len().saturating_sub(self.position);
        (remaining, Some(remaining))
    }
}

impl ExactSizeIterator for Todos<'_> {}

impl Index<usize> for Todos<'_> {
    type Output = Todo;

    fn index(&self, index: usize) -> &Todo {
        self.todos[index].todo()
    }
}

/// The save lifecycle of the in-memory list.
///
/// `Clean` means the list matches the last accepted bytes. `Pending` is the
/// debounce window after the most recent unsaved mutation (a trailing
/// debounce, matching [`App::mark_dirty`]). `Retrying` keeps the list dirty
/// after a failed save and delays the next attempt by [`SAVE_RETRY`]
/// while holding the last error. A new mutation resets the debounce window but
/// keeps the last error so the status bar does not forget a failure the user
/// has already seen.
///
/// This is the data only: the transitions live on [`App`], which is the only
/// owner of the enum.
#[derive(Debug, Default)]
pub(crate) enum SaveState {
    /// No unsaved mutation.
    #[default]
    Clean,
    /// The most recent mutation happened at `since`; the save is debounced
    /// from there.
    Pending {
        /// Time of the most recent unsaved mutation.
        since: Instant,
        /// The last save error, kept across the new debounce window.
        error: Option<String>,
    },
    /// A save failed; retry at `at` and show `error`.
    Retrying {
        /// Earliest retry time.
        at: Instant,
        /// Save error message; the action bar bounds it when drawing.
        error: String,
    },
}

/// The complete TUI state.
pub struct App {
    filename: PathBuf,
    /// One entry per todo: the shared handle plus its cached search view.
    /// History snapshots share untouched handles with the live list, and every
    /// mutation replaces only the entry it changed.
    entries: Vec<TodoEntry>,
    list: ListModel,
    row_of: Vec<Option<usize>>,
    today: TodoDate,
    /// Search bar: query, cursor, focus and suggestions.
    search: SearchBar,
    tag_sources: TagSources,
    show_hidden: bool,
    /// Cursor, anchor and range. Shared with `crate::nav`, the one module that
    /// implements the selection transitions; no other crate sees this field.
    pub(crate) selection: Selection,
    /// First row drawn in the list viewport. Written by `crate::nav` only.
    pub(crate) offset: usize,
    width: u16,
    height: u16,
    toast: Option<Toast>,
    load_error: Option<String>,
    should_quit: bool,
    read_only: bool,
    next_id: u64,
    history: History,
    modals: Stack,
    update_model: Option<UpdateModel>,
    save: SaveState,
    effects: Vec<Effect>,
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
    pub fn new(filename: impl Into<PathBuf>, todos: Vec<Todo>, today: TodoDate) -> Self {
        let tag_sources = TagSources::collect(&todos);
        let next_id = todos
            .iter()
            .map(|todo| todo.id.value().saturating_add(1))
            .max()
            .unwrap_or(0);
        let entries: Vec<TodoEntry> = todos.into_iter().map(TodoEntry::new).collect();

        let mut app = Self {
            filename: filename.into(),
            entries,
            list: ListModel::default(),
            row_of: Vec::new(),
            today,
            search: SearchBar::default(),
            tag_sources,
            show_hidden: false,
            selection: Selection::default(),
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
            save: SaveState::Clean,
            effects: Vec::new(),
        };
        app.recompute_rows();
        app.selection.cursor = app.first_todo_id();
        crate::nav::reflow(&mut app);
        app
    }

    // ---- read-only accessors ----------------------------------------------

    /// Path shown in diagnostics (never rendered as a row).
    #[must_use]
    pub fn filename(&self) -> &Path {
        &self.filename
    }

    /// Todos in load order; row indexes point into the underlying list.
    ///
    /// The return value borrows the list without allocating: index it
    /// (`app.todos()[0]`), iterate it, or ask for [`Todos::len`].
    #[must_use]
    pub fn todos(&self) -> Todos<'_> {
        Todos {
            todos: &self.entries,
            position: 0,
        }
    }

    /// Current search query, before normalization.
    #[must_use]
    pub fn query(&self) -> String {
        self.search.query()
    }

    /// The current query as characters, without a second allocation.
    #[must_use]
    pub(crate) fn query_chars(&self) -> &[char] {
        self.search.chars()
    }

    /// Cursor position in the query, in characters (not bytes).
    #[must_use]
    pub fn query_cursor(&self) -> usize {
        self.search.cursor()
    }

    /// True while the search bar has keyboard focus.
    #[must_use]
    pub fn search_focused(&self) -> bool {
        self.search.focused()
    }

    /// Filtered project/context suggestions for the search bar.
    #[must_use]
    pub(crate) fn search_suggestions(&self) -> &Suggestions {
        self.search.suggestions()
    }

    /// Cursor todo id.
    #[must_use]
    pub fn cursor(&self) -> Option<TodoId> {
        self.selection.cursor
    }

    /// Anchor of a shift-selection.
    #[must_use]
    pub fn anchor(&self) -> Option<TodoId> {
        self.selection.anchor
    }

    /// Selected todo ids for a range selection (empty means "cursor only").
    #[must_use]
    pub fn range(&self) -> &[TodoId] {
        &self.selection.range
    }

    /// First visible row.
    #[must_use]
    pub fn offset(&self) -> usize {
        self.offset
    }

    /// Terminal width, updated on every draw/resize.
    #[must_use]
    pub fn width(&self) -> u16 {
        self.width
    }

    /// Terminal height, updated on every draw/resize.
    #[must_use]
    pub fn height(&self) -> u16 {
        self.height
    }

    /// Local calendar day used by the overdue and threshold rules.
    #[must_use]
    pub(crate) fn today(&self) -> TodoDate {
        self.today
    }

    /// True when hidden todos are included in the list.
    #[must_use]
    pub(crate) fn show_hidden(&self) -> bool {
        self.show_hidden
    }

    /// True when the session may not modify the file.
    #[must_use]
    pub fn is_read_only(&self) -> bool {
        self.read_only
    }

    /// Set the read-only flag.
    pub fn set_read_only(&mut self, read_only: bool) {
        self.read_only = read_only;
    }

    /// A bounded read failure, if any.
    #[must_use]
    pub fn load_error(&self) -> Option<&str> {
        self.load_error.as_deref()
    }

    /// Replace the bounded read error.
    pub fn set_load_error(&mut self, error: Option<String>) {
        self.load_error = error;
    }

    /// True when the process should exit.
    #[must_use]
    pub fn should_quit(&self) -> bool {
        self.should_quit
    }

    /// Ask the event loop to exit.
    pub(crate) fn set_should_quit(&mut self) {
        self.should_quit = true;
    }

    /// Update information supplied by the host.
    #[must_use]
    pub(crate) fn update_model(&self) -> Option<&UpdateModel> {
        self.update_model.as_ref()
    }

    /// Replace the update information supplied by the host.
    pub fn set_update_model(&mut self, model: Option<UpdateModel>) {
        self.update_model = model;
    }

    /// The one active modal, if any.
    #[must_use]
    pub fn modals(&self) -> &Stack {
        &self.modals
    }

    /// Number of undo steps, for tests and diagnostics.
    #[must_use]
    pub fn undo_len(&self) -> usize {
        self.history.undo_len()
    }

    /// True when the in-memory list differs from the last saved bytes.
    #[must_use]
    pub fn is_dirty(&self) -> bool {
        !matches!(self.save, SaveState::Clean)
    }

    /// The last save failure, kept until the next successful save.
    #[must_use]
    pub(crate) fn save_error(&self) -> Option<&str> {
        match &self.save {
            SaveState::Clean => None,
            SaveState::Pending { error, .. } => error.as_deref(),
            SaveState::Retrying { error, .. } => Some(error),
        }
    }

    /// Set the cursor id, without reconciling the row model.
    ///
    /// This is a test/integration hook; the UI moves the cursor through
    /// [`crate::nav`], which also scrolls and reconciles the range.
    pub fn set_cursor(&mut self, cursor: Option<TodoId>) {
        self.selection.cursor = cursor;
    }

    /// Replace the shift-selection range.
    ///
    /// This is a test/integration hook; the UI builds ranges through
    /// [`crate::nav`].
    pub fn set_range(&mut self, ids: Vec<TodoId>) {
        self.selection.range = ids;
    }

    /// Focus or blur the search bar without reflowing the list.
    ///
    /// This is a test/integration hook. The UI uses [`App::focus_search`] and
    /// [`App::blur_search`], which keep the row model, suggestions, and scroll
    /// offset in step.
    pub fn set_search_focused(&mut self, focused: bool) {
        if focused {
            self.search.focus();
        } else {
            self.search.blur();
        }
    }

    /// Set the scroll offset, clamped to the current maximum.
    ///
    /// The UI scrolls through [`crate::nav`]; this hook keeps tests from
    /// depending on a key sequence to park the viewport.
    pub fn set_offset(&mut self, offset: usize) {
        self.offset = offset;
        self.clamp_offset();
    }

    // ---- list state -------------------------------------------------------

    /// Replace the whole list (initial load or a reload) and reset selection
    /// metadata that refers to the previous list.
    pub(crate) fn set_todos(&mut self, todos: Vec<Todo>) {
        self.entries = todos.into_iter().map(TodoEntry::new).collect();
        self.tag_sources = TagSources::collect(self.entries.iter().map(TodoEntry::todo));
        self.refresh_search_suggestions();
        self.selection.range.clear();
        self.selection.anchor = None;
        self.selection.cursor = None;
        self.next_id = self
            .entries
            .iter()
            .map(|entry| entry.todo().id.value().saturating_add(1))
            .max()
            .unwrap_or(0);
        self.history.clear();
        self.save = SaveState::Clean;
        self.modals.close();
        self.recompute_rows();
        self.selection.cursor = self.first_todo_id();
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
        self.save = SaveState::Clean;
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
        self.save = SaveState::Clean;
        self.push_toast(message);
    }

    /// Current terminal size and rows.
    #[must_use]
    pub fn layout(&self) -> Layout {
        Layout::new(self.width, self.height, self.search_visible())
    }

    /// The search bar is visible while focused or while it holds a query.
    #[must_use]
    pub(crate) fn search_visible(&self) -> bool {
        self.search.visible()
    }

    /// Rebuild the row model from the current entries, query and flags.
    ///
    /// Only the rows and the id-to-row map change; selection and scrolling are
    /// reconciled by [`crate::nav::rebuild`], which is the single
    /// `reconcileNavState` implementation. Calling this directly would leave a
    /// cursor pointing at a row that no longer exists.
    pub(crate) fn recompute_rows(&mut self) {
        let query = self.search.query();
        self.list = ListModel::from_entries(&self.entries, &query, self.show_hidden, self.today);

        self.row_of = vec![None; self.entries.len()];
        for (row, entry) in self.list.rows.iter().enumerate() {
            if let Some(index) = entry.todo_index()
                && let Some(slot) = self.row_of.get_mut(index)
            {
                *slot = Some(row);
            }
        }

        self.clamp_offset();
    }

    /// Focus the search bar, refresh its suggestions, and reflow the list.
    ///
    /// The focused bar takes two rows, so the list height changes; the reflow
    /// keeps the cursor row visible at the new height.
    pub(crate) fn focus_search(&mut self) {
        let was_visible = self.search_visible();
        self.search.focus();
        self.refresh_search_suggestions();
        if self.search_visible() != was_visible {
            crate::nav::reflow(self);
        } else {
            self.clamp_offset();
        }
    }

    /// Blur the search bar, keeping the query, and reflow or clamp the list.
    ///
    /// This is the production blur path (the mouse row click uses it too), so
    /// the row model and viewport stay consistent.
    pub(crate) fn blur_search(&mut self) {
        let was_visible = self.search_visible();
        self.search.blur();
        if self.search_visible() != was_visible {
            crate::nav::reflow(self);
        } else {
            self.clamp_offset();
        }
    }

    /// Blur the search bar, clear the query, and rebuild the row model.
    pub(crate) fn clear_search(&mut self) {
        self.search.blur();
        self.search.clear();
        crate::nav::rebuild(self);
    }

    /// Edit the query, then rebuild the row model and refresh suggestions.
    ///
    /// Every query edit goes through here, so a caller cannot forget either
    /// step. Cursor-only moves use [`App::move_query_cursor`] instead.
    pub(crate) fn edit_query(&mut self, edit: impl FnOnce(&mut SearchBar)) {
        edit(&mut self.search);
        crate::nav::rebuild(self);
        self.refresh_search_suggestions();
    }

    /// Move the query cursor without changing the query.
    ///
    /// The filter is unchanged, so only the suggestion list is refreshed.
    pub(crate) fn move_query_cursor(&mut self, edit: impl FnOnce(&mut SearchBar)) {
        edit(&mut self.search);
        self.refresh_search_suggestions();
    }

    /// Move the suggestion highlight up (`direction < 0`) or down.
    pub(crate) fn select_suggestion(&mut self, direction: isize) {
        if direction < 0 {
            self.search.suggestion_previous();
        } else {
            self.search.suggestion_next();
        }
    }

    /// Apply the highlighted suggestion to the query and rebuild the filter.
    pub(crate) fn apply_suggestion(&mut self) {
        if self.search.suggestion_apply() {
            crate::nav::rebuild(self);
            self.refresh_search_suggestions();
        }
    }

    /// Replace the query, move the cursor to its end, and reconcile selection.
    pub fn set_query(&mut self, query: impl Into<String>) {
        self.edit_query(|search| search.set_query(query));
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
        let index = self.index_of(id)?;
        self.row_of.get(index).copied().flatten()
    }

    /// Current position of a todo id in load order.
    ///
    /// Ids are stable for the life of the session but no longer equal the
    /// index: create/delete/paste shift the vector. A missing id returns
    /// `None`.
    #[must_use]
    pub(crate) fn index_of(&self, id: TodoId) -> Option<usize> {
        self.entries.iter().position(|entry| entry.todo().id == id)
    }

    /// Todo for a load-order index.
    #[must_use]
    pub(crate) fn todo_at(&self, index: usize) -> Option<&Todo> {
        self.entries.get(index).map(TodoEntry::todo)
    }

    /// Todo for an id.
    #[must_use]
    pub(crate) fn todo_by_id(&self, id: TodoId) -> Option<&Todo> {
        self.entries
            .iter()
            .find(|entry| entry.todo().id == id)
            .map(TodoEntry::todo)
    }

    /// The cursor todo, if it is still visible.
    #[must_use]
    pub fn selected_todo(&self) -> Option<&Todo> {
        self.selection.cursor.and_then(|id| self.todo_by_id(id))
    }

    /// The selected todos: the range when one is active, otherwise the cursor.
    #[must_use]
    pub fn selected_todos(&self) -> Vec<&Todo> {
        if self.selection.range.is_empty() {
            return self.selected_todo().into_iter().collect();
        }

        self.entries
            .iter()
            .filter(|entry| self.selection.range.contains(&entry.todo().id))
            .map(TodoEntry::todo)
            .collect()
    }

    /// True when a todo is in the shift-selection range.
    #[must_use]
    pub(crate) fn is_selected_in_range(&self, id: TodoId) -> bool {
        self.selection.range.contains(&id)
    }

    /// First todo id in the row model.
    #[must_use]
    pub(crate) fn first_todo_id(&self) -> Option<TodoId> {
        self.list.rows.iter().find_map(|row| {
            row.todo_index()
                .and_then(|index| self.entries.get(index))
                .map(|entry| entry.todo().id)
        })
    }

    /// Last todo id in the row model.
    #[must_use]
    pub(crate) fn last_todo_id(&self) -> Option<TodoId> {
        self.list.rows.iter().rev().find_map(|row| {
            row.todo_index()
                .and_then(|index| self.entries.get(index))
                .map(|entry| entry.todo().id)
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
    pub(crate) fn clamp_offset(&mut self) {
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
    pub(crate) fn push_toast_at(&mut self, message: impl Into<String>, now: Instant) {
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

    /// Replace every entry from a restored history snapshot.
    ///
    /// The snapshot already holds the original allocations, so the entries share
    /// them; only the cached search views are derived again.
    fn set_shared_entries(&mut self, todos: Vec<Rc<Todo>>) {
        self.entries = todos.into_iter().map(TodoEntry::from_shared).collect();
    }

    /// Append one parsed todo and its search view.
    fn push_todo(&mut self, todo: Todo) {
        self.entries.push(TodoEntry::new(todo));
    }

    /// Replace one todo and its search view at `index`.
    ///
    /// Only the touched entry gets a fresh handle; every other todo stays
    /// shared with the history snapshot that preceded the mutation.
    fn replace_todo(&mut self, index: usize, todo: Todo) {
        self.entries[index].replace(todo);
    }

    /// Gate a mutating command.
    ///
    /// A read-only binary refuses the command. A write-enabled session whose
    /// last load failed still mutates in memory but never saves, matching the
    /// Ink app's read-only recovery state.
    fn begin_mutation(&mut self, now: Instant) -> bool {
        if self.read_only {
            self.push_toast_at(READ_ONLY_MESSAGE, now);
            return false;
        }
        true
    }

    /// Snapshot the current list before a mutation.
    fn record_history(&mut self) {
        self.history
            .record(self.entries.iter().map(TodoEntry::shared));
    }

    /// Mark the list dirty at `now`, starting a fresh debounce window.
    ///
    /// The last error is preserved: a mutation after a failed save re-enables
    /// the retry deadline, but it does not make the failure disappear.
    pub(crate) fn mark_dirty(&mut self, now: Instant) {
        let error = self.save_error().map(str::to_owned);
        self.save = SaveState::Pending { since: now, error };
    }

    /// Finish a mutation: reconcile the row model and schedule a save.
    fn finish_mutation(&mut self, now: Instant) {
        self.tag_sources = TagSources::collect(self.entries.iter().map(TodoEntry::todo));
        self.refresh_search_suggestions();
        crate::nav::rebuild(self);
        if self.load_error.is_some() {
            self.push_toast_at(NOT_SAVED_MESSAGE, now);
        } else {
            self.mark_dirty(now);
        }
    }

    /// Refresh the search bar's suggestion list from the current query.
    pub(crate) fn refresh_search_suggestions(&mut self) {
        if self.search.focused() {
            self.search.refresh(&self.tag_sources);
        } else {
            self.search.clear_suggestions();
        }
    }

    /// Close the search suggestion popup without changing the filter.
    pub(crate) fn clear_search_suggestions(&mut self) {
        self.search.clear_suggestions();
    }

    /// The search popup anchor and filtered list, if one should be drawn.
    #[must_use]
    pub(crate) fn search_overlay(&self, layout: Layout) -> Option<crate::suggest::Overlay<'_>> {
        if !self.search.focused() || !self.search.suggestions().is_open() {
            return None;
        }
        let suggestions = self.search.suggestions();
        let start = suggestions.start();
        let before: String = self.query_chars().iter().take(start).collect();
        let width = u16::try_from(ratatui::text::Line::from(sanitize_for_display(&before)).width())
            .unwrap_or(u16::MAX);
        Some(crate::suggest::Overlay {
            anchor: crate::suggest::Anchor {
                x: 3_u16.saturating_add(width),
                y: layout.search_border_row(),
            },
            suggestions,
        })
    }

    /// Apply `update` to every todo whose id is in `ids`.
    ///
    /// One call records one undo step, even when it touches many todos, which
    /// is the Ink provider's grouping.
    pub(crate) fn update_ids<F>(&mut self, ids: &[TodoId], now: Instant, mut update: F)
    where
        F: FnMut(&Todo) -> Todo,
    {
        if ids.is_empty() || !self.begin_mutation(now) {
            return;
        }
        self.record_history();
        for id in ids {
            if let Some(index) = self.index_of(*id) {
                let updated = update(self.entries[index].todo());
                self.replace_todo(index, updated);
            }
        }
        self.finish_mutation(now);
    }

    /// Append one todo per line and select the last added todo when visible.
    ///
    /// The batch is validated as a whole by
    /// [`thar_core::validate_todo_batch`] before any history is recorded, so a
    /// rejected line adds nothing. An empty batch, a read-only session, and a
    /// command refused by the mutation gate all return `Ok(vec![])`; the gate
    /// has already shown its own toast.
    ///
    /// The cursor moves to the last added todo only when that todo is present
    /// in the current row model. A new todo filtered out by the active search
    /// or hidden by the hidden view leaves the cursor on a visible todo.
    ///
    /// # Errors
    ///
    /// Returns the [`TodoInputError`] from [`thar_core::validate_todo_batch`]:
    /// the batch limit, the list capacity, or the first bad line.
    pub fn add_todos(
        &mut self,
        texts: &[String],
        now: Instant,
    ) -> Result<Vec<TodoId>, TodoInputError> {
        if texts.is_empty() || !self.begin_mutation(now) {
            return Ok(Vec::new());
        }
        validate_todo_batch(texts, self.entries.len(), MAX_PASTE_TODOS)?;

        self.record_history();
        let today = self.today;
        let mut added = Vec::with_capacity(texts.len());
        for text in texts {
            let id = self.allocate_id();
            let todo = Todo::parse_line(text, id).set_creation_date(today);
            self.push_todo(todo);
            added.push(id);
        }
        self.finish_mutation(now);
        if let Some(last) = added.last().copied() {
            if self.row_for(last).is_some() {
                self.selection.cursor = Some(last);
                self.selection.range.clear();
                self.selection.anchor = None;
            }
            crate::nav::reflow(self);
        }
        Ok(added)
    }

    /// Delete every todo whose id is in `ids`.
    pub fn remove_ids(&mut self, ids: &[TodoId], now: Instant) {
        if ids.is_empty() || !self.begin_mutation(now) {
            return;
        }
        self.record_history();
        self.entries.retain(|entry| !ids.contains(&entry.todo().id));
        self.finish_mutation(now);
    }

    /// Flip open/done on `ids`, appending the recurrence copies.
    pub(crate) fn toggle_ids(&mut self, ids: &[TodoId], now: Instant) {
        if ids.is_empty() || !self.begin_mutation(now) {
            return;
        }
        self.record_history();
        let today = self.today;
        let mut recurring = Vec::new();
        let mut errors = Vec::new();

        for id in ids {
            if let Some(index) = self.index_of(*id) {
                let next_id = self.allocate_id();
                let outcome = self.entries[index].todo().toggle_state(today, next_id);
                self.replace_todo(index, outcome.updated);
                match outcome.recurring {
                    Ok(Some(copy)) => recurring.push(copy),
                    Ok(None) => {}
                    Err(error) => errors.push(error.to_string()),
                }
            }
        }

        for copy in recurring {
            self.push_todo(copy);
        }

        self.finish_mutation(now);
        if let Some(error) = errors.first() {
            self.push_toast_at(error.clone(), now);
        }
    }

    /// Set or clear a priority on `ids`.
    pub(crate) fn set_priority_ids(
        &mut self,
        ids: &[TodoId],
        priority: Option<Priority>,
        now: Instant,
    ) {
        self.update_ids(ids, now, |todo| todo.clone().set_priority(priority));
    }

    /// Set or remove `due:` on `ids`.
    pub(crate) fn set_due_ids(&mut self, ids: &[TodoId], date: Option<TodoDate>, now: Instant) {
        self.update_ids(ids, now, |todo| match date {
            Some(date) => todo.clone().set_due(date),
            None => todo.clone().remove_due(),
        });
    }

    /// Set or remove `t:` on `ids`.
    pub(crate) fn set_threshold_ids(
        &mut self,
        ids: &[TodoId],
        date: Option<TodoDate>,
        now: Instant,
    ) {
        self.update_ids(ids, now, |todo| match date {
            Some(date) => todo.clone().set_threshold(date),
            None => todo.clone().remove_threshold(),
        });
    }

    /// Set or remove `rec:` on `ids`.
    pub(crate) fn set_recurrence_ids(
        &mut self,
        ids: &[TodoId],
        value: Option<Recurrence>,
        now: Instant,
    ) {
        self.update_ids(ids, now, |todo| match value {
            Some(value) => todo.clone().set_recurrence(value),
            None => todo.clone().remove_recurrence(),
        });
    }

    /// Add a project or context token to `ids`.
    pub(crate) fn add_tag_ids(&mut self, ids: &[TodoId], kind: TagKind, name: &str, now: Instant) {
        self.update_ids(ids, now, |todo| match kind {
            TagKind::Project => todo.clone().add_project(name),
            TagKind::Context => todo.clone().add_context(name),
        });
    }

    /// Remove a project or context token from `ids`.
    pub(crate) fn remove_tag_ids(
        &mut self,
        ids: &[TodoId],
        kind: TagKind,
        name: &str,
        now: Instant,
    ) {
        self.update_ids(ids, now, |todo| match kind {
            TagKind::Project => todo.clone().remove_project(name),
            TagKind::Context => todo.clone().remove_context(name),
        });
    }

    /// Undo one mutation.
    pub fn undo(&mut self, now: Instant) -> bool {
        if self.read_only {
            self.push_toast_at(READ_ONLY_MESSAGE, now);
            return false;
        }
        let mut current: Vec<Rc<Todo>> = self
            .entries
            .iter()
            .map(|entry| Rc::clone(entry.shared()))
            .collect();
        if !self.history.undo(&mut current) {
            return false;
        }
        self.set_shared_entries(current);
        self.finish_mutation(now);
        true
    }

    /// Redo one undo.
    pub fn redo(&mut self, now: Instant) -> bool {
        if self.read_only {
            self.push_toast_at(READ_ONLY_MESSAGE, now);
            return false;
        }
        let mut current: Vec<Rc<Todo>> = self
            .entries
            .iter()
            .map(|entry| Rc::clone(entry.shared()))
            .collect();
        if !self.history.redo(&mut current) {
            return false;
        }
        self.set_shared_entries(current);
        self.finish_mutation(now);
        true
    }

    /// Serialized lines for `ids`, in load order, joined by `\n`.
    #[must_use]
    pub(crate) fn copy_text(&self, ids: &[TodoId]) -> String {
        self.entries
            .iter()
            .map(TodoEntry::todo)
            .filter(|todo| ids.contains(&todo.id))
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Copies of the todos with `ids`, in load order.
    #[must_use]
    pub fn todos_by_ids(&self, ids: &[TodoId]) -> Vec<Todo> {
        self.entries
            .iter()
            .map(TodoEntry::todo)
            .filter(|todo| ids.contains(&todo.id))
            .cloned()
            .collect()
    }

    /// Ids of every completed todo, in load order.
    #[must_use]
    pub fn completed_ids(&self) -> Vec<TodoId> {
        self.entries
            .iter()
            .map(TodoEntry::todo)
            .filter(|todo| todo.is_done())
            .map(|todo| todo.id)
            .collect()
    }

    /// Split clipboard text into todo lines and add them, confirming above ten.
    ///
    /// The clipboard read stays in the terminal (it needs the host); this
    /// method owns the limits and the confirmation so both are testable
    /// without a clipboard. Lines are split, `thar_core::js_trim`-trimmed and
    /// empty lines dropped, then the whole batch is validated by
    /// [`thar_core::validate_todo_batch`] before anything is added or a
    /// confirmation opens. That makes the paste path share the core rules: a
    /// leading date, an over-long line, a control character, and a batch over
    /// [`thar_core::MAX_PASTE_TODOS`] are all rejected with the core message
    /// under the `Paste failed:` prefix.
    ///
    /// A batch above [`PASTE_CONFIRM_THRESHOLD`] (but within the core limit)
    /// opens the existing confirmation screen; a smaller batch is applied
    /// immediately.
    ///
    /// The shared mutation gate runs before splitting, validation, or opening a
    /// confirmation, so a read-only session rejects every paste with exactly
    /// one [`READ_ONLY_MESSAGE`] toast. The write path reaches
    /// [`App::add_todos`], whose second gate call is a no-op.
    pub fn receive_clipboard(&mut self, text: &str, now: Instant) {
        if !self.begin_mutation(now) {
            return;
        }
        let lines: Vec<String> = text
            .lines()
            .map(js_trim)
            .filter(|line| !line.is_empty())
            .map(str::to_owned)
            .collect();
        if lines.is_empty() {
            return;
        }
        if let Err(error) = validate_todo_batch(&lines, self.entries.len(), MAX_PASTE_TODOS) {
            self.push_toast_at(format!("Paste failed: {error}"), now);
            return;
        }
        if lines.len() > PASTE_CONFIRM_THRESHOLD {
            self.modals.open(modal::registry::confirm(
                ConfirmRequest::paste(lines.len(), lines),
                self.width,
                self.height,
            ));
            return;
        }
        self.apply_action(Action::PasteLines { lines }, now);
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
    pub(crate) fn save_deadline(&self) -> Option<Instant> {
        match &self.save {
            SaveState::Clean => None,
            SaveState::Pending { since, .. } => Some(*since + SAVE_DEBOUNCE),
            SaveState::Retrying { at, .. } => Some(*at),
        }
    }

    /// Poll timeout until the pending save, for the event loop.
    #[must_use]
    pub fn save_timeout(&self, now: Instant) -> Option<Duration> {
        self.save_deadline()
            .map(|deadline| deadline.saturating_duration_since(now))
    }

    /// True when the debounced save should run now.
    #[must_use]
    pub fn save_due(&self, now: Instant) -> bool {
        self.save_deadline().is_some_and(|deadline| now >= deadline)
    }

    /// Record a successful save.
    pub fn mark_saved(&mut self) {
        self.save = SaveState::Clean;
    }

    /// Record a save failure, keep the list dirty, and schedule a retry.
    ///
    /// The toast is shown once per distinct message; a retrying save on the
    /// same error does not spam the action bar.
    pub fn mark_save_failed(&mut self, now: Instant, message: impl Into<String>) {
        let message = message.into();
        let changed = self.save_error() != Some(message.as_str());
        self.save = SaveState::Retrying {
            at: now + SAVE_RETRY,
            error: message,
        };
        if changed {
            let error = self.save_error().unwrap_or_default().to_owned();
            self.push_toast_at(format!("Save failed: {error}"), now);
        }
    }

    /// Route a key press to the active modal.
    ///
    /// Returns true when a modal consumed the key, so the list keymap never
    /// sees it.
    pub fn handle_modal_key(&mut self, key: KeyEvent, now: Instant) -> bool {
        let Some(modal) = self.modals.top_mut() else {
            return false;
        };
        let outcome = modal.handle_key(key);
        self.apply_outcome(outcome, now);
        true
    }

    /// Route a mouse event to the active modal.
    pub(crate) fn handle_modal_mouse(&mut self, mouse: MouseInput, now: Instant) -> bool {
        let Some(modal) = self.modals.top_mut() else {
            return false;
        };
        let outcome = modal.handle_mouse(mouse);
        self.apply_outcome(outcome, now);
        true
    }

    /// Route a bracketed paste to the active modal.
    pub(crate) fn handle_modal_paste(&mut self, text: &str, now: Instant) -> bool {
        let Some(modal) = self.modals.top_mut() else {
            return false;
        };
        let outcome = modal.handle_paste(text);
        self.apply_outcome(outcome, now);
        true
    }

    fn apply_outcome(&mut self, outcome: Outcome, now: Instant) {
        match outcome {
            Outcome::Continue => {}
            Outcome::Close => self.modals.close(),
            Outcome::Actions(actions) => {
                for action in actions {
                    self.apply_action(action, now);
                }
            }
        }
    }

    /// Open a screen by id.
    ///
    /// A screen that this build cannot build shows the one bounded
    /// "not available" toast. `Confirm` needs a request, so requesting it by id
    /// does nothing instead of pretending it is unavailable.
    pub fn open_modal(&mut self, id: ModalId) {
        self.clear_search_suggestions();
        match modal::registry::open(self, id) {
            Ok(modal) => self.modals.open(modal),
            Err(OpenError::Unavailable) => {
                self.push_toast("That screen is not available in this build yet");
            }
            Err(OpenError::NeedsRequest) => {}
        }
    }

    /// Apply one modal action.
    pub fn apply_action(&mut self, action: Action, now: Instant) {
        match action {
            Action::Close => self.modals.close(),
            Action::Toast(message) => self.push_toast_at(message, now),
            Action::Open(id) => self.open_modal(id),
            Action::AddTodos(texts) => {
                if let Err(error) = self.add_todos(&texts, now) {
                    self.push_toast_at(error.to_string(), now);
                }
                self.modals.close();
            }
            Action::UpdateText { ids, text } => {
                self.update_ids(&ids, now, |todo| todo.clone().set_text(&text, true));
                self.modals.close();
            }
            Action::Delete { ids } => {
                self.remove_ids(&ids, now);
                self.modals.close();
            }
            Action::Toggle { ids } => {
                self.toggle_ids(&ids, now);
                self.modals.close();
            }
            Action::ToggleHidden { ids } => {
                self.update_ids(&ids, now, |todo| todo.clone().toggle_hidden());
                self.modals.close();
            }
            Action::SetDue { ids, date } => {
                self.set_due_ids(&ids, date, now);
                self.modals.close();
            }
            Action::SetThreshold { ids, date } => {
                self.set_threshold_ids(&ids, date, now);
                self.modals.close();
            }
            Action::SetPriority { ids, priority } => {
                self.set_priority_ids(&ids, priority, now);
                self.modals.close();
            }
            Action::SetRecurrence { ids, value } => {
                self.set_recurrence_ids(&ids, value, now);
                self.modals.close();
            }
            Action::AddTag { ids, kind, name } => {
                self.add_tag_ids(&ids, kind, &name, now);
                self.modals.close();
            }
            Action::RemoveTag { ids, kind, name } => {
                self.remove_tag_ids(&ids, kind, &name, now);
                self.modals.close();
            }
            Action::Undo => {
                self.undo(now);
                self.modals.close();
            }
            Action::Redo => {
                self.redo(now);
                self.modals.close();
            }
            Action::ToggleHiddenView => {
                self.toggle_hidden_view();
                self.modals.close();
            }
            Action::Copy { ids } => {
                let text = self.copy_text(&ids);
                if text.is_empty() {
                    self.push_toast_at("Nothing to copy", now);
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
                match self.add_todos(&lines, now) {
                    Ok(added) => {
                        if !added.is_empty() && self.writable() {
                            self.push_toast_at(format!("Pasted {} todo(s)", added.len()), now);
                        }
                    }
                    Err(error) => self.push_toast_at(format!("Paste failed: {error}"), now),
                }
                self.modals.close();
            }
            Action::ArchiveCompleted => {
                self.effects.push(Effect::ArchiveCompleted);
                self.modals.close();
            }
            Action::Confirm(request) => {
                self.modals
                    .open(modal::registry::confirm(request, self.width, self.height));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{App, SAVE_DEBOUNCE, SAVE_RETRY};
    use crate::messages::READ_ONLY_MESSAGE;
    use crate::modal::{Action, Modal};
    use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    use std::time::{Duration, Instant};
    use thar_core::{Priority, Todo, TodoDate, TodoId};

    fn now() -> Instant {
        Instant::now()
    }

    fn app(lines: &[&str]) -> App {
        let todos = lines
            .iter()
            .enumerate()
            .map(|(index, line)| Todo::parse_line(line, TodoId::new(index as u64)))
            .collect();
        let mut app = App::new(
            "todo.txt",
            todos,
            "2026-11-15".parse::<TodoDate>().expect("valid date"),
        );
        app.set_read_only(false);
        app
    }

    fn enter() -> KeyEvent {
        KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)
    }

    #[test]
    fn read_only_refuses_mutations() {
        let mut app = app(&["one"]);
        app.set_read_only(true);
        app.toggle_ids(
            &app.selected_todos()
                .iter()
                .map(|todo| todo.id)
                .collect::<Vec<_>>(),
            now(),
        );
        assert!(!app.todos()[0].is_done());
        assert!(!app.is_dirty());
        assert_eq!(app.toast_message(now()), Some(READ_ONLY_MESSAGE));
    }

    #[test]
    fn a_read_only_paste_uses_the_shared_gate_and_adds_nothing() {
        let mut app = app(&["one"]);
        app.set_read_only(true);
        let at = now();
        let text = (1..=11)
            .map(|index| format!("pasted {index}"))
            .collect::<Vec<_>>()
            .join("\n");

        app.receive_clipboard(&text, at);
        assert_eq!(app.todos().len(), 1, "a read-only paste adds nothing");
        assert!(!app.modals.is_open(), "no confirmation may open");
        assert_eq!(app.toast_message(at), Some(READ_ONLY_MESSAGE));
        assert_eq!(app.history.undo_len(), 0);
        assert!(!app.is_dirty());
    }

    #[test]
    fn toggle_records_one_undo_step_and_marks_dirty() {
        let mut app = app(&["one", "two"]);
        let ids = vec![app.todos()[0].id, app.todos()[1].id];
        app.toggle_ids(&ids, now());
        assert!(app.todos().iter().all(|todo| todo.is_done()));
        assert!(app.is_dirty() && app.save_deadline().is_some());
        assert_eq!(app.history.undo_len(), 1);
        assert_eq!(app.history.redo_len(), 0);

        assert!(app.undo(now()));
        assert!(app.todos().iter().all(|todo| !todo.is_done()));
        assert_eq!(app.history.redo_len(), 1);
        assert!(app.redo(now()));
        assert!(app.todos().iter().all(|todo| todo.is_done()));
    }

    #[test]
    fn create_assigns_stable_ids_and_delete_keeps_the_rest() {
        let mut app = app(&["one", "two"]);
        let added = app
            .add_todos(&["three".to_owned(), "four".to_owned()], now())
            .expect("added");
        assert_eq!(added.len(), 2);
        assert_ne!(added[0], app.todos()[0].id);
        assert_ne!(added[1], added[0]);
        assert_eq!(app.todos()[2].id, added[0]);
        assert_eq!(app.todos()[3].id, added[1]);
        assert_eq!(
            app.cursor(),
            Some(added[1]),
            "the oracle selects the last pasted todo"
        );

        app.remove_ids(&[app.todos()[1].id], now());
        assert_eq!(app.todos().len(), 3);
        assert!(app.todos().iter().any(|todo| todo.id == added[1]));
        assert!(app.todos().iter().all(|todo| todo.id != TodoId::new(1)));
    }

    #[test]
    fn priority_due_and_tags_go_through_one_history_step() {
        let mut app = app(&["one"]);
        let ids = vec![app.todos()[0].id];
        app.set_priority_ids(
            &ids,
            Some(Priority::new('B').expect("valid priority")),
            now(),
        );
        assert_eq!(
            app.todos()[0].priority.map(|priority| priority.as_char()),
            Some('B')
        );
        app.set_due_ids(&ids, Some("2026-12-01".parse::<TodoDate>().unwrap()), now());
        assert_eq!(
            app.todos()[0].date_tag("due"),
            "2026-12-01".parse::<TodoDate>().ok()
        );
        app.add_tag_ids(&ids, crate::modal::TagKind::Project, "thar", now());
        assert!(app.todos()[0].text.contains("+thar"));
        assert_eq!(app.history.undo_len(), 3);
    }

    #[test]
    fn recurrence_toggle_appends_the_next_instance() {
        let mut app = app(&["water plants rec:1w due:2026-11-10"]);
        let id = app.todos()[0].id;
        app.toggle_ids(&[id], now());
        assert!(app.todos()[0].is_done());
        assert_eq!(app.todos().len(), 2);
        let copy = &app.todos()[1];
        assert!(!copy.is_done());
        assert_eq!(copy.date_tag("due"), "2026-11-22".parse::<TodoDate>().ok());
    }

    #[test]
    fn the_save_deadline_is_the_debounce_from_the_first_mutation() {
        let mut app = app(&["one"]);
        assert_eq!(app.save_deadline(), None);
        let at = now();
        app.toggle_ids(&[app.todos()[0].id], at);
        let deadline = app.save_deadline().expect("deadline");
        assert_eq!(deadline, at + SAVE_DEBOUNCE);
        assert!(app.save_timeout(at).is_some());
        assert!(!app.save_due(deadline - Duration::from_millis(1)));
        assert!(app.save_due(deadline));
        app.mark_saved();
        assert!(!app.is_dirty() && app.save_deadline().is_none());
    }

    #[test]
    fn a_large_paste_confirms_before_adding_anything() {
        let mut app = app(&["one"]);
        let text = (1..=11)
            .map(|index| format!("pasted {index}"))
            .collect::<Vec<_>>()
            .join("\n");

        app.receive_clipboard(&text, now());
        assert_eq!(app.todos().len(), 1, "nothing is added before confirmation");
        let modal = app.modals.top().expect("paste confirmation");
        assert_eq!(modal.title(), "Paste Multiple Todos");
        assert_eq!(
            app.modals.top().map(|modal| modal.id()),
            Some(crate::modal::ModalId::Confirm)
        );

        assert!(app.handle_modal_key(enter(), now()));
        assert_eq!(app.todos().len(), 12);
        assert!(!app.modals.is_open());
        assert!(app.is_dirty());
        assert_eq!(app.toast_message(now()), Some("Pasted 11 todo(s)"));
    }

    #[test]
    fn a_ten_line_paste_adds_without_a_confirmation() {
        let mut app = app(&["one"]);
        let text = (1..=10)
            .map(|index| format!("pasted {index}"))
            .collect::<Vec<_>>()
            .join("\n");
        app.receive_clipboard(&text, now());
        assert_eq!(app.todos().len(), 11);
        assert!(!app.modals.is_open());
    }

    #[test]
    fn a_paste_at_the_core_limit_still_confirms() {
        let mut app = app(&["one"]);
        let text = (1..=100)
            .map(|index| format!("pasted {index}"))
            .collect::<Vec<_>>()
            .join("\n");
        app.receive_clipboard(&text, now());
        assert_eq!(app.todos().len(), 1, "nothing is added before confirmation");
        assert!(app.modals.is_open());
    }

    #[test]
    fn a_paste_over_the_hard_limit_is_rejected_with_one_message() {
        let mut app = app(&["one"]);
        let text = (1..=101)
            .map(|index| format!("pasted {index}"))
            .collect::<Vec<_>>()
            .join("\n");
        app.receive_clipboard(&text, now());
        assert_eq!(app.todos().len(), 1);
        assert!(!app.modals.is_open(), "rejected before any confirmation");
        let message = app.toast_message(now()).expect("toast");
        assert!(message.contains("limit is 100"), "{message}");
    }

    #[test]
    fn a_pasted_leading_date_is_rejected_with_the_core_message() {
        let mut app = app(&["one"]);
        app.receive_clipboard("buy milk\n2026-11-15 buy milk", now());
        assert_eq!(app.todos().len(), 1, "nothing may be added");
        assert_eq!(
            app.toast_message(now()),
            Some("Paste failed: Todo text cannot start with a date; use the date picker")
        );
    }

    #[test]
    fn a_pasted_line_over_the_todo_cap_is_rejected() {
        let mut app = app(&["one"]);
        let line = "a".repeat(2_001);
        app.receive_clipboard(&line, now());
        assert_eq!(app.todos().len(), 1);
        assert_eq!(
            app.toast_message(now()),
            Some("Paste failed: Todo is too long; the limit is 2000 characters")
        );
    }

    #[test]
    fn a_pasted_line_over_the_read_cap_never_enters_the_list() {
        let mut app = app(&["one"]);
        let line = "a".repeat(8_193);
        app.receive_clipboard(&line, now());
        assert_eq!(app.todos().len(), 1);
        let message = app.toast_message(now()).expect("toast");
        assert!(message.contains("limit is 2000"), "{message}");
    }

    #[test]
    fn a_bom_only_paste_adds_no_empty_todo() {
        let mut app = app(&["one"]);
        app.receive_clipboard("\u{FEFF}\n\u{00A0}\n\t\n\u{3000}", now());
        assert_eq!(app.todos().len(), 1);
        assert_eq!(app.toast_message(now()), None);
        assert_eq!(app.history.undo_len(), 0);
    }

    #[test]
    fn a_pasted_control_character_is_rejected() {
        let mut app = app(&["one"]);
        app.receive_clipboard("safe\na\u{001B}b", now());
        assert_eq!(app.todos().len(), 1);
        assert_eq!(
            app.toast_message(now()),
            Some("Paste failed: Todo contains a disallowed control character")
        );
    }

    #[test]
    fn a_confirmed_paste_that_fails_validation_uses_the_paste_prefix() {
        let mut app = app(&["one"]);
        app.apply_action(
            Action::PasteLines {
                lines: vec!["2026-11-15 buy milk".to_owned()],
            },
            now(),
        );
        assert_eq!(app.todos().len(), 1, "nothing may be added");
        assert!(!app.modals.is_open());
        assert_eq!(
            app.toast_message(now()),
            Some("Paste failed: Todo text cannot start with a date; use the date picker")
        );
    }

    #[test]
    fn the_create_action_keeps_the_bare_validation_message() {
        let mut app = app(&["one"]);
        app.apply_action(
            Action::AddTodos(vec!["2026-11-15 buy milk".to_owned()]),
            now(),
        );
        assert_eq!(app.todos().len(), 1, "nothing may be added");
        assert!(!app.modals.is_open());
        assert_eq!(
            app.toast_message(now()),
            Some("Todo text cannot start with a date; use the date picker")
        );
    }

    #[test]
    fn a_new_todo_excluded_by_the_search_keeps_the_cursor_visible() {
        let mut app = app(&["alpha", "beta"]);
        app.set_query("alpha");
        let added = app.add_todos(&["gamma".to_owned()], now()).expect("added");
        assert_eq!(added.len(), 1);
        assert_eq!(app.todos().len(), 3);

        let cursor = app.cursor().expect("a cursor remains");
        assert_ne!(cursor, added[0], "the new todo is filtered out");
        assert!(app.row_for(cursor).is_some(), "the cursor stays visible");
    }

    #[test]
    fn a_new_hidden_todo_keeps_the_cursor_visible() {
        let mut app = app(&["visible"]);
        let added = app
            .add_todos(&["secret h:1".to_owned()], now())
            .expect("added");
        assert_eq!(added.len(), 1);

        let cursor = app.cursor().expect("a cursor remains");
        assert_ne!(cursor, added[0], "the new todo is hidden");
        assert!(app.row_for(cursor).is_some(), "the cursor stays visible");
    }

    #[test]
    fn the_delete_confirmation_carries_the_delete_action() {
        let mut app = app(&["one", "two"]);
        let ids = vec![app.todos()[1].id];
        app.apply_action(
            Action::Confirm(crate::modal::ConfirmRequest::delete(ids.clone())),
            now(),
        );
        assert_eq!(
            app.modals.top().map(|modal| modal.id()),
            Some(crate::modal::ModalId::Confirm)
        );
        assert_eq!(app.modals.top().map(Modal::title), Some("Delete Todo"));

        app.handle_modal_key(enter(), now());
        assert_eq!(app.todos().len(), 1);
        assert_eq!(app.todos()[0].text, "one");
    }

    #[test]
    fn the_archive_confirmation_queues_the_host_effect() {
        let mut app = app(&["x 2026-11-01 done", "open"]);
        app.apply_action(
            Action::Confirm(crate::modal::ConfirmRequest::archive()),
            now(),
        );
        app.handle_modal_key(enter(), now());
        assert_eq!(app.take_effects(), vec![crate::Effect::ArchiveCompleted]);
        assert!(!app.modals.is_open());
    }

    #[test]
    fn the_update_model_is_absent_by_default() {
        let app = app(&["one"]);
        assert!(app.update_model().is_none());
    }

    #[test]
    fn a_failed_save_stays_dirty_and_retries_after_the_backoff() {
        let mut app = app(&["one"]);
        app.toggle_ids(&[app.todos()[0].id], now());
        let failed_at = now();
        app.mark_save_failed(failed_at, "disk full");
        assert!(app.is_dirty(), "a failed save must not drop the edit");
        assert_eq!(app.save_error(), Some("disk full"));
        assert_eq!(app.save_deadline(), Some(failed_at + SAVE_RETRY));
        assert!(!app.save_due(now()));
        assert!(app.save_due(failed_at + SAVE_RETRY + Duration::from_millis(1)));
        app.mark_saved();
        assert!(!app.is_dirty());
        assert!(app.save_error().is_none());
    }

    #[test]
    fn a_repeated_save_failure_toasts_once_per_distinct_message() {
        let mut app = app(&["one"]);
        app.toggle_ids(&[app.todos()[0].id], now());
        let failed_at = now();
        app.mark_save_failed(failed_at, "disk full");
        assert_eq!(app.toast_message(failed_at), Some("Save failed: disk full"));

        // Same message on the retry: no new toast (the old one expires).
        app.expire_toast(failed_at + super::TOAST_DURATION + Duration::from_millis(1));
        app.mark_save_failed(failed_at + SAVE_RETRY, "disk full");
        assert_eq!(app.toast_message(failed_at + SAVE_RETRY), None);

        // A different message is news again.
        app.mark_save_failed(failed_at + SAVE_RETRY, "permission denied");
        assert_eq!(
            app.toast_message(failed_at + SAVE_RETRY),
            Some("Save failed: permission denied")
        );
    }

    #[test]
    fn a_new_mutation_keeps_the_last_save_error() {
        let mut app = app(&["one"]);
        let id = app.todos()[0].id;
        let failed_at = now();
        app.toggle_ids(&[id], failed_at);
        app.mark_save_failed(failed_at, "disk full");
        assert_eq!(app.toast_message(failed_at), Some("Save failed: disk full"));

        // A new edit resets the debounce deadline but must not forget the
        // failure the status bar already reported.
        let mutating_at = failed_at + Duration::from_millis(10);
        app.toggle_ids(&[id], mutating_at);
        assert_eq!(app.save_error(), Some("disk full"));
        let deadline = app.save_deadline().expect("a fresh debounce deadline");
        assert_eq!(deadline, mutating_at + SAVE_DEBOUNCE);

        // The same message after the toast expired is not news.
        let retry_at = failed_at + super::TOAST_DURATION + Duration::from_millis(1);
        app.expire_toast(retry_at);
        app.mark_save_failed(retry_at, "disk full");
        assert_eq!(app.toast_message(retry_at), None);

        // A different message still shows one toast.
        app.mark_save_failed(retry_at, "permission denied");
        assert_eq!(
            app.toast_message(retry_at),
            Some("Save failed: permission denied")
        );
    }

    #[test]
    fn save_state_transitions_are_driven_by_the_app() {
        let mut app = app(&["one"]);
        let at = now();
        assert!(!app.is_dirty());
        assert_eq!(app.save_deadline(), None);
        assert_eq!(app.save_error(), None);

        app.mark_dirty(at);
        assert!(app.is_dirty());
        assert_eq!(app.save_deadline(), Some(at + SAVE_DEBOUNCE));
        assert!(app.save_due(at + SAVE_DEBOUNCE));
        assert_eq!(app.save_timeout(at), Some(SAVE_DEBOUNCE));

        app.mark_save_failed(at, "disk full");
        assert!(app.is_dirty(), "a failed save must not drop the edit");
        assert_eq!(app.save_deadline(), Some(at + SAVE_RETRY));
        assert_eq!(app.save_error(), Some("disk full"));
        assert_eq!(app.toast_message(at), Some("Save failed: disk full"));

        // The same failure on a later attempt is not news, so no toast.
        let retry_at = at + super::TOAST_DURATION + Duration::from_millis(1);
        app.expire_toast(retry_at);
        app.mark_save_failed(retry_at, "disk full");
        assert_eq!(app.toast_message(retry_at), None);

        app.mark_saved();
        assert!(!app.is_dirty());
        assert_eq!(app.save_deadline(), None);
        assert_eq!(app.save_error(), None);
    }

    #[test]
    fn set_todos_and_recovery_reset_the_save_state() {
        let mut app = app(&["one"]);
        app.toggle_ids(&[app.todos()[0].id], now());
        app.mark_save_failed(now(), "disk full");
        assert!(app.is_dirty());

        app.recovered();
        assert!(!app.is_dirty());
        assert_eq!(app.save_error(), None);

        app.toggle_ids(&[app.todos()[0].id], now());
        assert!(app.is_dirty());
        let todos = app.todos().into_iter().cloned().collect();
        app.set_todos(todos);
        assert!(!app.is_dirty());
        assert_eq!(app.save_deadline(), None);
    }
}
