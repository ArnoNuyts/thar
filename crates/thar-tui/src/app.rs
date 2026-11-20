//! Application state for the TUI.
//!
//! The state is deliberately split from the event loop and from rendering:
//! `thar-cli` owns the terminal, `input` maps events to commands, and `view`
//! reads this struct through its accessors. Everything here is a
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
//! # Write path
//!
//! The binary saves every edit. Mutating commands call the mutation API here,
//! which records one undo step per command and schedules a debounced save. When
//! a reload has failed, edits are still applied in memory but not scheduled for
//! saving until a later reload succeeds (the save-blocked recovery state). The
//! actual filesystem write lives in `thar-cli`/`thar-store`; this crate only
//! queues [`Effect`]s.
//!
//! Every mutation and modal action takes an explicit [`Instant`], so the save
//! debounce and retry state are deterministic in tests. Convenience toasts that
//! are not part of the save state may still use the host clock.

use std::collections::{HashMap, HashSet};
use std::ops::Index;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::{Duration, Instant};

use ratatui::crossterm::event::KeyEvent;
use thar_core::{
    Priority, Recurrence, Todo, TodoDate, TodoId, TodoInputError, js_trim, validate_default_batch,
};

use crate::display::sanitize_for_display;
use crate::entry::TodoEntry;
use crate::event::MouseInput;
use crate::history::History;
use crate::layout::Layout;
use crate::list::{ListModel, ListRow};
use crate::modal::{
    self, Action, ConfirmRequest, ModalId, OpenError, Outcome, Stack, TagKind, UpdateModel,
};
use crate::search_bar::SearchBar;
use crate::suggest::TagSources;

/// Debounce before a mutation is written, matching the Ink app.
pub const SAVE_DEBOUNCE: Duration = Duration::from_millis(50);

/// Lines above which a clipboard paste asks for confirmation, matching
/// `useTodoCommands`.
pub const PASTE_CONFIRM_THRESHOLD: usize = 10;

/// Backoff before retrying a failed save.
pub const SAVE_RETRY: Duration = Duration::from_secs(1);

/// Toast shown when a mutation is applied in memory but not saved because the
/// last reload failed.
pub const NOT_SAVED_MESSAGE: &str = "Not saved: reload failed";

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

/// A pointer cell in 1-based terminal coordinates, matching [`MouseInput`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Pointer {
    x: u16,
    y: u16,
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

impl Selection {
    /// Clear the anchor and the range, keeping the cursor.
    pub(crate) fn collapse(&mut self) {
        self.anchor = None;
        self.range.clear();
    }
}

/// A borrowed, allocation-free view of the app's todos.
///
/// [`App::todos`] returns this instead of collecting a `Vec<&Todo>`, so a caller
/// that indexes, counts, or iterates the list does not allocate. Indexing uses
/// [`Todos::len`] order; [`Todos::iter`] and the [`IntoIterator`] impl yield the
/// same todos from the start.
#[derive(Clone, Copy, Debug)]
pub struct Todos<'a> {
    todos: &'a [TodoEntry],
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

    /// An iterator over every todo, in load order.
    pub fn iter(&self) -> TodosIter<'a> {
        TodosIter {
            inner: self.todos.iter(),
        }
    }
}

/// Iterator over the todos of an [`App`], in load order.
pub struct TodosIter<'a> {
    inner: std::slice::Iter<'a, TodoEntry>,
}

impl<'a> Iterator for TodosIter<'a> {
    type Item = &'a Todo;

    fn next(&mut self) -> Option<Self::Item> {
        self.inner.next().map(TodoEntry::todo)
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        self.inner.size_hint()
    }
}

impl ExactSizeIterator for TodosIter<'_> {}

impl<'a> IntoIterator for Todos<'a> {
    type Item = &'a Todo;
    type IntoIter = TodosIter<'a>;

    fn into_iter(self) -> Self::IntoIter {
        self.iter()
    }
}

impl Index<usize> for Todos<'_> {
    type Output = Todo;

    fn index(&self, index: usize) -> &Todo {
        self.todos[index].todo()
    }
}

/// The save lifecycle of the in-memory list.
///
/// `Clean` means no save is pending. Normally the list also matches the last
/// accepted bytes, but there is one exception: a mutation accepted while a
/// reload is failing (`App::load_error` is set) changes the list in memory
/// without scheduling a save, so the state stays `Clean` while the list
/// temporarily differs from disk. The next successful reload replaces that
/// blocked mutation with the accepted bytes, matching the TypeScript app's
/// recovery behaviour.
///
/// `Pending` is the debounce window after the most recent unsaved mutation (a
/// trailing debounce, matching [`App::mark_dirty`]). `Retrying` keeps the list
/// dirty after a failed save and delays the next attempt by [`SAVE_RETRY`]
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
    /// Row index for every todo currently in the row model.
    row_by_id: HashMap<TodoId, usize>,
    today: TodoDate,
    /// Search bar: query, cursor, focus and suggestions.
    search: SearchBar,
    tag_sources: TagSources,
    show_hidden: bool,
    /// Cursor, anchor and range. `crate::nav` is the one module that
    /// implements the selection transitions.
    pub(crate) selection: Selection,
    /// First row drawn in the list viewport. Written by `crate::nav` only.
    offset: usize,
    width: u16,
    height: u16,
    /// Last pointer cell, or `None` until the terminal reports motion or a
    /// click. Hover is derived from this and the action-bar geometry, so the
    /// pointer has one source of truth.
    pointer: Option<Pointer>,
    toast: Option<Toast>,
    load_error: Option<String>,
    should_quit: bool,
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
    /// Append these completed todos to `done.txt`, then remove them from the
    /// list on success.
    Archive(Vec<Todo>),
    /// Copy this exact text to the clipboard.
    Copy(String),
    /// Read the clipboard and add its lines as todos.
    Paste,
}

/// Where [`App::select_suggestion`] moves the suggestion highlight.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Direction {
    /// The previous suggestion (Up).
    Up,
    /// The next suggestion (Down).
    Down,
}

impl App {
    /// Create the app for an already-loaded todo list.
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
            row_by_id: HashMap::new(),
            today,
            search: SearchBar::default(),
            tag_sources,
            show_hidden: false,
            selection: Selection::default(),
            offset: 0,
            width: 80,
            height: 24,
            pointer: None,
            toast: None,
            load_error: None,
            should_quit: false,
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

    // ---- read accessors ----------------------------------------------------

    /// Path shown in diagnostics (never rendered as a row).
    #[must_use]
    pub fn filename(&self) -> &Path {
        &self.filename
    }

    /// Todos in load order; row indexes point into the underlying list.
    ///
    /// The return value borrows the list without allocating: index it
    /// (`app.todos()[0]`), iterate it (`app.todos().iter()`), or ask for
    /// [`Todos::len`].
    #[must_use]
    pub fn todos(&self) -> Todos<'_> {
        Todos {
            todos: &self.entries,
        }
    }

    /// The search bar: query, cursor, focus and suggestions.
    ///
    /// The accessor only borrows the search bar; every edit goes through
    /// `edit_query`, `move_query_cursor`, `focus_search` or `blur_search`, which
    /// keep the row model and scroll offset in step.
    #[must_use]
    pub fn search(&self) -> &SearchBar {
        &self.search
    }

    /// Project and context names cached for the search and modal suggestions.
    pub(crate) fn tag_sources(&self) -> &TagSources {
        &self.tag_sources
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

    /// Record the pointer cell.
    ///
    /// Motion and left clicks call this; a wheel event leaves the pointer
    /// alone because scrolling does not move the mouse.
    pub(crate) fn set_pointer(&mut self, mouse: MouseInput) {
        self.pointer = Some(Pointer {
            x: mouse.x,
            y: mouse.y,
        });
    }

    /// Index of the action-bar item under the pointer, if any.
    ///
    /// The caller passes the layout it is drawing, so one frame has one
    /// geometry. An open modal owns the pointer and suppresses the bar's
    /// hover.
    #[must_use]
    pub fn hovered_action_index(&self, layout: Layout) -> Option<usize> {
        if self.modals.is_open() {
            return None;
        }
        let pointer = self.pointer?;
        layout.action_item_index_at_cell(pointer.x, pointer.y)
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
    #[doc(hidden)]
    pub fn set_cursor(&mut self, cursor: Option<TodoId>) {
        self.selection.cursor = cursor;
    }

    /// Replace the shift-selection range.
    ///
    /// This is a test/integration hook; the UI builds ranges through
    /// [`crate::nav`].
    #[doc(hidden)]
    pub fn set_range(&mut self, ids: Vec<TodoId>) {
        self.selection.range = ids;
    }

    /// Focus or blur the search bar without reflowing the list.
    ///
    /// This is a test/integration hook. The UI uses `App::focus_search` and
    /// `App::blur_search`, which keep the row model, suggestions, and scroll
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
    #[doc(hidden)]
    pub fn set_offset(&mut self, offset: usize) {
        self.offset = offset;
        self.clamp_offset();
    }

    // ---- list state -------------------------------------------------------

    /// Replace the whole list (initial load or a reload) and reset selection
    /// metadata that refers to the previous list.
    pub(crate) fn set_todos(&mut self, todos: Vec<Todo>) {
        self.entries = todos.into_iter().map(TodoEntry::new).collect();
        self.tag_sources = TagSources::collect(self.todos().iter());
        self.refresh_search_suggestions();
        self.selection.collapse();
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

    /// Apply a successful file reload: replace the list and leave the
    /// save-blocked recovery state.
    ///
    /// `App::set_todos` already clears both undo stacks, the pending save and
    /// the save error; the external file wins over unsaved in-memory edits.
    /// Clearing `load_error` re-enables writes through [`App::writable`], which
    /// is the Ink app's recovery path after a fixed file.
    pub fn reloaded(&mut self, todos: Vec<Todo>) {
        self.set_todos(todos);
        self.load_error = None;
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
        Layout::new(self.width, self.height, self.search.visible())
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

        let row_by_id = self
            .list
            .rows
            .iter()
            .enumerate()
            .filter_map(|(row, list_row)| self.row_todo_id(list_row).map(|id| (id, row)))
            .collect();
        self.row_by_id = row_by_id;

        self.clamp_offset();
    }

    /// Focus the search bar, refresh its suggestions, and reflow the list.
    ///
    /// The focused bar takes two rows, so the list height changes; the reflow
    /// keeps the cursor row visible at the new height.
    pub(crate) fn focus_search(&mut self) {
        let was_visible = self.search.visible();
        self.search.focus();
        self.refresh_search_suggestions();
        if self.search.visible() != was_visible {
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
        let was_visible = self.search.visible();
        self.search.blur();
        if self.search.visible() != was_visible {
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

    /// Move the suggestion highlight up ([`Direction::Up`]) or down.
    pub(crate) fn select_suggestion(&mut self, direction: Direction) {
        match direction {
            Direction::Up => self.search.suggestion_previous(),
            Direction::Down => self.search.suggestion_next(),
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
        usize::from(self.layout().list_height)
    }

    /// Row index for a todo id, if it is visible.
    ///
    /// The id-to-row map is rebuilt with the row model, so the lookup is O(1)
    /// and a stale id from a filtered-out or deleted todo returns `None`.
    #[must_use]
    pub fn row_for(&self, id: TodoId) -> Option<usize> {
        self.row_by_id.get(&id).copied()
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

    /// Todo id behind a todo row, or `None` for a header.
    #[must_use]
    pub(crate) fn row_todo_id(&self, row: &ListRow) -> Option<TodoId> {
        row.todo_index()
            .and_then(|index| self.todo_at(index))
            .map(|todo| todo.id)
    }

    /// The cursor todo, if it is still visible.
    #[must_use]
    pub fn selected_todo(&self) -> Option<&Todo> {
        self.selection.cursor.and_then(|id| self.todo_by_id(id))
    }

    /// Ids of the selected todos: the range when one is active, otherwise the
    /// cursor.
    #[must_use]
    pub(crate) fn selected_ids(&self) -> Vec<TodoId> {
        self.selected_todos().iter().map(|todo| todo.id).collect()
    }

    /// The selected todos: the range when one is active, otherwise the cursor.
    #[must_use]
    pub fn selected_todos(&self) -> Vec<&Todo> {
        if self.selection.range.is_empty() {
            return self.selected_todo().into_iter().collect();
        }

        let selected: HashSet<TodoId> = self.selection.range.iter().copied().collect();
        self.entries
            .iter()
            .filter(|entry| selected.contains(&entry.todo().id))
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
        self.list.rows.iter().find_map(|row| self.row_todo_id(row))
    }

    /// Last todo id in the row model.
    #[must_use]
    pub(crate) fn last_todo_id(&self) -> Option<TodoId> {
        self.list
            .rows
            .iter()
            .rev()
            .find_map(|row| self.row_todo_id(row))
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

    // ---- Mutation, history, save and modal plumbing ------------------------

    /// True when the session may save changes to the file.
    #[must_use]
    pub fn writable(&self) -> bool {
        self.load_error.is_none()
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
        self.tag_sources = TagSources::collect(self.todos().iter());
        self.refresh_search_suggestions();
        crate::nav::rebuild(self);
        if !self.writable() {
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
        let before: String = self.search.chars().iter().take(start).collect();
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
        F: FnMut(Todo) -> Todo,
    {
        if ids.is_empty() {
            return;
        }
        self.record_history();
        let targets: HashSet<TodoId> = ids.iter().copied().collect();
        for index in 0..self.entries.len() {
            let updated = {
                let todo = self.entries[index].todo();
                if !targets.contains(&todo.id) {
                    continue;
                }
                update(todo.clone())
            };
            self.replace_todo(index, updated);
        }
        self.finish_mutation(now);
    }

    /// Append one todo per line and select the last added todo when visible.
    ///
    /// The batch is validated as a whole by
    /// [`thar_core::validate_default_batch`] before any history is recorded, so a
    /// rejected line adds nothing. An empty batch returns `Ok(vec![])`.
    ///
    /// The cursor moves to the last added todo only when that todo is present
    /// in the current row model. A new todo filtered out by the active search
    /// or hidden by the hidden view leaves the cursor on a visible todo.
    ///
    /// # Errors
    ///
    /// Returns the [`TodoInputError`] from [`thar_core::validate_default_batch`]:
    /// the batch limit, the list capacity, or the first bad line.
    pub fn add_todos(
        &mut self,
        texts: &[String],
        now: Instant,
    ) -> Result<Vec<TodoId>, TodoInputError> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        validate_default_batch(texts, self.entries.len())?;

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
                self.selection.collapse();
            }
            crate::nav::reflow(self);
        }
        Ok(added)
    }

    /// Delete every todo whose id is in `ids`.
    pub fn remove_ids(&mut self, ids: &[TodoId], now: Instant) {
        if ids.is_empty() {
            return;
        }
        self.record_history();
        let removed: HashSet<TodoId> = ids.iter().copied().collect();
        self.entries
            .retain(|entry| !removed.contains(&entry.todo().id));
        self.finish_mutation(now);
    }

    /// Flip open/done on `ids`, appending the recurrence copies.
    pub(crate) fn toggle_ids(&mut self, ids: &[TodoId], now: Instant) {
        if ids.is_empty() {
            return;
        }
        self.record_history();
        let today = self.today;
        let targets: HashSet<TodoId> = ids.iter().copied().collect();
        let mut recurring = Vec::new();
        let mut first_error: Option<thar_core::RecurrenceError> = None;

        for index in 0..self.entries.len() {
            if !targets.contains(&self.entries[index].todo().id) {
                continue;
            }
            // Clone the handle first so the id allocator can borrow the app
            // mutably; `toggle_state` only asks for an id when it plans a
            // recurring copy.
            let todo = Rc::clone(self.entries[index].shared());
            let outcome = todo.toggle_state(today, || self.allocate_id());
            self.replace_todo(index, outcome.updated);
            match outcome.recurring {
                Ok(Some(copy)) => recurring.push(copy),
                Ok(None) => {}
                Err(error) => {
                    first_error.get_or_insert(error);
                }
            }
        }

        for copy in recurring {
            self.push_todo(copy);
        }

        self.finish_mutation(now);
        if let Some(error) = first_error {
            self.push_toast_at(error.to_string(), now);
        }
    }

    /// Set or clear a priority on `ids`.
    pub(crate) fn set_priority_ids(
        &mut self,
        ids: &[TodoId],
        priority: Option<Priority>,
        now: Instant,
    ) {
        self.update_ids(ids, now, |todo| todo.set_priority(priority));
    }

    /// Set or remove `due:` on `ids`.
    pub(crate) fn set_due_ids(&mut self, ids: &[TodoId], date: Option<TodoDate>, now: Instant) {
        self.update_ids(ids, now, |todo| match date {
            Some(date) => todo.set_due(date),
            None => todo.remove_due(),
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
            Some(date) => todo.set_threshold(date),
            None => todo.remove_threshold(),
        });
    }

    /// Set or remove `rec:` on `ids`.
    pub(crate) fn set_recurrence_ids(
        &mut self,
        ids: &[TodoId],
        value: Option<Recurrence>,
        now: Instant,
    ) {
        self.update_ids(ids, now, |todo| match &value {
            Some(value) => todo.set_recurrence(value.clone()),
            None => todo.remove_recurrence(),
        });
    }

    /// Add a project or context token to `ids`.
    pub(crate) fn add_tag_ids(&mut self, ids: &[TodoId], kind: TagKind, name: &str, now: Instant) {
        self.update_ids(ids, now, |todo| match kind {
            TagKind::Project => todo.add_project(name),
            TagKind::Context => todo.add_context(name),
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
            TagKind::Project => todo.remove_project(name),
            TagKind::Context => todo.remove_context(name),
        });
    }

    /// Step one undo or redo.
    ///
    /// `step` swaps the live handle vector with a history snapshot in place, so
    /// a successful step does not clone any `Todo`.
    fn restore(
        &mut self,
        now: Instant,
        step: fn(&mut History, &mut Vec<Rc<Todo>>) -> bool,
    ) -> bool {
        let mut current: Vec<Rc<Todo>> = self
            .entries
            .iter()
            .map(|entry| Rc::clone(entry.shared()))
            .collect();
        if !step(&mut self.history, &mut current) {
            return false;
        }
        self.set_shared_entries(current);
        self.finish_mutation(now);
        true
    }

    /// Undo one mutation.
    pub fn undo(&mut self, now: Instant) -> bool {
        self.restore(now, History::undo)
    }

    /// Redo one undo.
    pub fn redo(&mut self, now: Instant) -> bool {
        self.restore(now, History::redo)
    }

    /// Serialized lines for `ids`, in load order, joined by `\n`.
    #[must_use]
    pub(crate) fn copy_text(&self, ids: &[TodoId]) -> String {
        let selected: HashSet<TodoId> = ids.iter().copied().collect();
        self.todos()
            .iter()
            .filter(|todo| selected.contains(&todo.id))
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Split clipboard text into todo lines and add them, confirming above ten.
    ///
    /// The clipboard read stays in the terminal (it needs the host); this
    /// method owns the limits and the confirmation so both are testable
    /// without a clipboard. Lines are split, `thar_core::js_trim`-trimmed and
    /// empty lines dropped, then the whole batch is validated by
    /// [`thar_core::validate_default_batch`] before anything is added or a
    /// confirmation opens. That makes the paste path share the core rules: a
    /// leading date, an over-long line, a control character, and a batch over
    /// [`thar_core::MAX_PASTE_TODOS`] are all rejected with the core message
    /// under the `Paste failed:` prefix.
    ///
    /// A batch above [`PASTE_CONFIRM_THRESHOLD`] (but within the core limit)
    /// opens the existing confirmation screen; a smaller batch is applied
    /// immediately.
    pub fn receive_clipboard(&mut self, text: &str, now: Instant) {
        let lines: Vec<String> = text
            .lines()
            .map(js_trim)
            .filter(|line| !line.is_empty())
            .map(str::to_owned)
            .collect();
        if lines.is_empty() {
            return;
        }
        if let Err(error) = validate_default_batch(&lines, self.entries.len()) {
            self.push_toast_at(format!("Paste failed: {error}"), now);
            return;
        }
        if lines.len() > PASTE_CONFIRM_THRESHOLD {
            self.modals.open(modal::registry::confirm(
                ConfirmRequest::paste(lines),
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

    /// Record the outcome of a clipboard copy.
    ///
    /// The host only performs the clipboard write; this method owns the toast
    /// text for a single todo, a batch, and a failure.
    pub fn copy_finished(&mut self, count: usize, result: Result<(), String>) {
        match result {
            Ok(()) => self.push_toast(match count {
                1 => "Todo copied".to_owned(),
                count => format!("{count} todos copied"),
            }),
            Err(error) => self.push_toast(format!("Copy failed: {error}")),
        }
    }

    /// Record the outcome of a clipboard read.
    ///
    /// A successful read follows the same path as [`App::receive_clipboard`];
    /// a host failure is reported under the `Paste failed:` prefix. The paste
    /// policy stays in the app, not in the host.
    pub fn paste_finished(&mut self, result: Result<String, String>, now: Instant) {
        match result {
            Ok(text) => self.receive_clipboard(&text, now),
            Err(error) => self.push_toast_at(format!("Paste failed: {error}"), now),
        }
    }

    /// Record the outcome of an archive append.
    ///
    /// The host only appends to `done.txt`; on success the archived ids are
    /// removed from the list, and on failure the list is untouched and the
    /// error is shown under the `Archive failed:` prefix.
    pub fn archive_finished(&mut self, ids: &[TodoId], result: Result<(), String>, now: Instant) {
        match result {
            Ok(()) => self.remove_ids(ids, now),
            Err(error) => self.push_toast_at(format!("Archive failed: {error}"), now),
        }
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
    pub(crate) fn handle_modal_key(&mut self, key: KeyEvent, now: Instant) -> bool {
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
                self.update_ids(&ids, now, |todo| todo.set_text(&text, true));
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
                self.update_ids(&ids, now, |todo| todo.toggle_hidden());
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
                let done: Vec<Todo> = self
                    .todos()
                    .iter()
                    .filter(|todo| todo.is_done())
                    .cloned()
                    .collect();
                if !done.is_empty() {
                    if self.writable() {
                        self.effects.push(Effect::Archive(done));
                    } else {
                        self.push_toast_at(NOT_SAVED_MESSAGE, now);
                    }
                }
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
        App::new(
            "todo.txt",
            todos,
            "2026-11-15".parse::<TodoDate>().expect("valid date"),
        )
    }

    fn enter() -> KeyEvent {
        KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)
    }

    #[test]
    fn a_large_paste_opens_the_confirmation_without_adding_or_saving() {
        let mut app = app(&["one"]);
        let at = now();
        let text = (1..=11)
            .map(|index| format!("pasted {index}"))
            .collect::<Vec<_>>()
            .join("\n");

        app.receive_clipboard(&text, at);
        assert_eq!(app.todos().len(), 1, "nothing is added before confirmation");
        assert!(app.modals.is_open(), "the confirmation must open");
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
    fn a_bad_recurrence_still_completes_the_todo_and_toasts() {
        let mut app = app(&["task rec:1D"]);
        let id = app.todos()[0].id;
        app.toggle_ids(&[id], now());
        assert!(app.todos()[0].is_done(), "the completion is stored");
        assert_eq!(app.todos().len(), 1, "no next instance is added");
        assert_eq!(
            app.toast_message(now()),
            Some("Invalid recurrence value; no new todo was created")
        );
    }

    #[test]
    fn the_save_deadline_is_the_trailing_debounce_from_the_latest_mutation() {
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
    fn copy_finished_reports_single_batches_and_failures() {
        let mut app = app(&["one"]);

        app.copy_finished(1, Ok(()));
        assert_eq!(app.toast_message(now()), Some("Todo copied"));

        app.copy_finished(3, Ok(()));
        assert_eq!(app.toast_message(now()), Some("3 todos copied"));

        app.copy_finished(2, Err("xclip exited with 1".to_owned()));
        assert_eq!(
            app.toast_message(now()),
            Some("Copy failed: xclip exited with 1")
        );
    }

    #[test]
    fn paste_finished_routes_text_through_the_paste_path() {
        let mut app = app(&["one"]);
        app.paste_finished(Ok("two\nthree".to_owned()), now());
        assert_eq!(app.todos().len(), 3);
        assert!(app.is_dirty());
    }

    #[test]
    fn paste_finished_reports_a_host_failure() {
        let mut app = app(&["one"]);
        app.paste_finished(Err("no clipboard command found".to_owned()), now());
        assert_eq!(app.todos().len(), 1, "nothing may be added");
        assert_eq!(
            app.toast_message(now()),
            Some("Paste failed: no clipboard command found")
        );
    }

    #[test]
    fn archive_finished_removes_the_archived_ids() {
        let mut app = app(&["one", "two"]);
        let ids = vec![app.todos()[0].id];
        app.archive_finished(&ids, Ok(()), now());
        assert_eq!(
            app.todos()
                .iter()
                .map(|todo| todo.text.as_str())
                .collect::<Vec<_>>(),
            ["two"]
        );
        assert_eq!(app.history.undo_len(), 1, "the removal is one undo step");
    }

    #[test]
    fn archive_finished_reports_a_failure_and_keeps_the_list() {
        let mut app = app(&["one"]);
        let ids = vec![app.todos()[0].id];
        app.archive_finished(&ids, Err("done.txt: permission denied".to_owned()), now());
        assert_eq!(app.todos().len(), 1, "a failed archive removes nothing");
        assert_eq!(
            app.toast_message(now()),
            Some("Archive failed: done.txt: permission denied")
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
    fn the_archive_confirmation_queues_the_completed_todos() {
        let mut app = app(&["x 2026-11-01 done", "open"]);
        app.apply_action(
            Action::Confirm(crate::modal::ConfirmRequest::archive()),
            now(),
        );
        app.handle_modal_key(enter(), now());
        let effects = app.take_effects();
        assert_eq!(effects.len(), 1);
        let crate::Effect::Archive(todos) = &effects[0] else {
            panic!("expected an archive effect, got {:?}", effects[0]);
        };
        assert_eq!(todos.len(), 1);
        assert_eq!(todos[0].text, "done");
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
    fn recovery_does_not_hide_unsaved_edits() {
        let mut app = app(&["a"]);
        app.reload_failed("gone");
        app.add_todos(&["b".to_owned()], now()).expect("added");
        assert_eq!(app.todos().len(), 2, "the edit is still in memory");
        assert!(
            !app.is_dirty(),
            "a blocked mutation must not schedule a save"
        );

        // The file returns with the bytes this session already accepted. The
        // recovery path re-parses the baseline instead of trusting the edited
        // in-memory list.
        let baseline = vec![Todo::parse_line("a", TodoId::new(0))];
        app.reloaded(baseline);

        assert!(app.load_error().is_none());
        assert!(
            !app.is_dirty(),
            "the recovered list matches the bytes on disk"
        );
        assert_eq!(
            app.todos()
                .iter()
                .map(|todo| todo.text.as_str())
                .collect::<Vec<_>>(),
            ["a"],
            "the unsaved edit must not survive as a clean list"
        );
    }

    #[test]
    fn set_todos_resets_the_save_state() {
        let mut app = app(&["one"]);
        app.toggle_ids(&[app.todos()[0].id], now());
        assert!(app.is_dirty());

        app.toggle_ids(&[app.todos()[0].id], now());
        assert!(app.is_dirty());
        let todos = app.todos().into_iter().cloned().collect();
        app.set_todos(todos);
        assert!(!app.is_dirty());
        assert_eq!(app.save_deadline(), None);
    }

    #[test]
    fn a_plain_toggle_does_not_allocate_an_id() {
        let mut app = app(&["one"]);
        app.toggle_ids(&[app.todos()[0].id], now());
        assert!(app.todos()[0].is_done());

        // A plain toggle allocates no id, so the initial id 0 is followed by
        // 1: the next created todo is 1 even though no recurring copy was
        // planned.
        let added = app.add_todos(&["two".to_owned()], now()).expect("added");
        assert_eq!(added, vec![TodoId::new(1)]);
    }
}
