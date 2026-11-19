//! Event mapping: crossterm keys and mouse events to [`Command`]s.
//!
//! There is one list keymap and one read-only gate. The keymap is the Ink app's
//! (`components/TodoList.tsx`) with this build's commands merged in; it is a pure
//! function of the key plus the app's control-flow context (search focus, an
//! open suggestion popup, single vs multi select). The mode is not duplicated:
//! after the keymap produces a [`Command`], [`Command::mutates`] decides whether
//! a read-only session must acknowledge the press with one bounded toast.
//!
//! Navigation, search, scrolling and the mouse are fully functional in both
//! modes. A read-only session may also copy and open the update screen; every
//! editing command is rejected at the single gate.
//!
//! Mouse coordinates are the ones `thar-cli` produces: 1-based terminal cells,
//! converted through the shared [`crate::layout::Layout`].
//!
//! # Search parity
//!
//! While the search bar has focus, `SearchInput.tsx` intercepts Up/Down,
//! PageUp/PageDown, Home and End *before* the text editor sees them, so those
//! keys navigate the todo list instead of moving the query cursor. Only
//! Left/Right, Backspace and Delete edit the query; Enter keeps the filter and
//! blurs, Escape clears the filter and blurs.

use std::time::Instant;

use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use thar_core::Priority;

use crate::app::{App, Direction};
use crate::layout::checkbox_columns;
use crate::messages::{NO_UPDATE_MESSAGE, READ_ONLY_MESSAGE};
use crate::modal::{Action, ConfirmRequest, ModalId};
use crate::nav;

pub use crate::event::{DOUBLE_CLICK_WINDOW, LastClick, MouseInput, MouseKind};

/// One intent produced by the input layer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Command {
    /// Exit the TUI.
    Quit,
    /// Focus the search bar.
    SearchFocus,
    /// Leave the search bar but keep the filter.
    SearchBlur,
    /// Clear the filter and leave the search bar.
    SearchClear,
    /// Insert a character at the query cursor.
    SearchInsert(char),
    /// Delete the character before the query cursor.
    SearchBackspace,
    /// Delete the character at the query cursor.
    SearchDelete,
    /// Move the query cursor left.
    SearchLeft,
    /// Move the query cursor right.
    SearchRight,
    /// Move the todo cursor up one row.
    Up,
    /// Move the todo cursor down one row.
    Down,
    /// Move to the previous context group.
    ContextUp,
    /// Move to the next context group.
    ContextDown,
    /// Extend the selection to the previous context group.
    ExtendContextUp,
    /// Extend the selection to the next context group.
    ExtendContextDown,
    /// Move five rows up.
    PageUp,
    /// Move five rows down.
    PageDown,
    /// Extend the selection five rows up.
    ExtendPageUp,
    /// Extend the selection five rows down.
    ExtendPageDown,
    /// Select the first todo row.
    Home,
    /// Select the last todo row.
    End,
    /// Include or exclude hidden todos.
    ToggleHiddenView,
    /// Clear a shift-selection.
    ClearRange,
    /// Extend the selection by one row upward.
    ExtendUp,
    /// Extend the selection by one row downward.
    ExtendDown,
    /// Open a modal screen.
    Open(ModalId),
    /// Flip open/done on the selected todos.
    Toggle,
    /// Flip the `h:` tag on the selected todos.
    ToggleHidden,
    /// Set a priority on the selected todos, or clear it when `None`.
    SetPriority(Option<Priority>),
    /// Undo the last mutation.
    Undo,
    /// Redo the last undo.
    Redo,
    /// Move the search suggestion highlight up.
    SuggestionPrevious,
    /// Move the search suggestion highlight down.
    SuggestionNext,
    /// Apply the highlighted search suggestion.
    SuggestionApply,
    /// Close the search suggestion popup only.
    SuggestionClose,
    /// Confirm and archive every completed todo.
    Archive,
    /// Confirm and delete the selected todos.
    DeleteSelected,
    /// Copy the selected todos to the clipboard.
    CopySelected,
    /// Read the clipboard and add its lines as todos.
    Paste,
    /// Show a bounded static message: a keymap hint or the read-only rejection.
    Toast(&'static str),
}

impl Command {
    /// True when the command changes `todo.txt` or the in-memory list.
    ///
    /// Navigation, search editing, quitting, copy, and opening the read-only
    /// update screen are not mutations. Every command that writes the list or
    /// opens an editing modal is. This is the single predicate behind the
    /// read-only gate, so a new command cannot forget its own check.
    #[must_use]
    pub const fn mutates(self) -> bool {
        match self {
            Self::Quit
            | Self::SearchFocus
            | Self::SearchBlur
            | Self::SearchClear
            | Self::SearchInsert(_)
            | Self::SearchBackspace
            | Self::SearchDelete
            | Self::SearchLeft
            | Self::SearchRight
            | Self::Up
            | Self::Down
            | Self::ContextUp
            | Self::ContextDown
            | Self::ExtendContextUp
            | Self::ExtendContextDown
            | Self::PageUp
            | Self::PageDown
            | Self::ExtendPageUp
            | Self::ExtendPageDown
            | Self::Home
            | Self::End
            | Self::ToggleHiddenView
            | Self::ClearRange
            | Self::ExtendUp
            | Self::ExtendDown
            | Self::SuggestionPrevious
            | Self::SuggestionNext
            | Self::SuggestionApply
            | Self::SuggestionClose
            | Self::CopySelected
            | Self::Toast(_) => false,
            // Only the read-only update screen may be opened by a read-only
            // session; every other screen edits the list.
            Self::Open(id) => !matches!(id, ModalId::Update),
            Self::Toggle
            | Self::ToggleHidden
            | Self::SetPriority(_)
            | Self::Undo
            | Self::Redo
            | Self::Archive
            | Self::DeleteSelected
            | Self::Paste => true,
        }
    }
}

/// Translate a key press for a specific app state.
///
/// This is the one keymap entry point. The control flow (search focus, an open
/// suggestion popup, single vs multi select) selects the branch; after the
/// command is produced, [`Command::mutates`] applies the read-only gate in one
/// place.
#[must_use]
pub fn command_for_key(app: &App, key: KeyEvent) -> Option<Command> {
    if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
        return Some(Command::Quit);
    }

    if app.search().focused() {
        if app.search().suggestions().is_open() {
            match key.code {
                KeyCode::Up => return Some(Command::SuggestionPrevious),
                KeyCode::Down => return Some(Command::SuggestionNext),
                KeyCode::Enter | KeyCode::Tab => return Some(Command::SuggestionApply),
                KeyCode::Esc => return Some(Command::SuggestionClose),
                _ => {}
            }
        }
        return gate(app, search_key(key));
    }

    gate(app, list_key(app, key))
}

/// The single read-only gate: a mutating command becomes one bounded toast.
fn gate(app: &App, command: Option<Command>) -> Option<Command> {
    match command {
        Some(command) if app.is_read_only() && command.mutates() => {
            Some(Command::Toast(READ_ONLY_MESSAGE))
        }
        other => other,
    }
}

/// The one list keymap, for both read-only and write sessions.
fn list_key(app: &App, key: KeyEvent) -> Option<Command> {
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    let shift = key.modifiers.contains(KeyModifiers::SHIFT);
    let alt = key
        .modifiers
        .intersects(KeyModifiers::ALT | KeyModifiers::META);

    match key.code {
        KeyCode::Up if ctrl && shift => Some(Command::ExtendContextUp),
        KeyCode::Down if ctrl && shift => Some(Command::ExtendContextDown),
        KeyCode::Up if ctrl => Some(Command::ContextUp),
        KeyCode::Down if ctrl => Some(Command::ContextDown),
        KeyCode::Up if shift => Some(Command::ExtendUp),
        KeyCode::Down if shift => Some(Command::ExtendDown),
        KeyCode::Up => Some(Command::Up),
        KeyCode::Down => Some(Command::Down),
        KeyCode::PageUp if shift => Some(Command::ExtendPageUp),
        KeyCode::PageDown if shift => Some(Command::ExtendPageDown),
        KeyCode::PageUp => Some(Command::PageUp),
        KeyCode::PageDown => Some(Command::PageDown),
        KeyCode::Home => Some(Command::Home),
        KeyCode::End => Some(Command::End),
        KeyCode::Esc => Some(Command::ClearRange),
        KeyCode::Char('/') if !ctrl && !alt => Some(Command::SearchFocus),
        KeyCode::Char('q') if !ctrl && !alt => Some(Command::Quit),
        KeyCode::Char('H') if !ctrl && !alt => Some(Command::ToggleHiddenView),
        KeyCode::Char(' ') if !ctrl && !alt => Some(Command::Toggle),
        KeyCode::Char('h') if !ctrl && !alt => Some(Command::ToggleHidden),
        KeyCode::Char('z') if !ctrl && !alt => Some(Command::Undo),
        KeyCode::Char('Z') if !ctrl && !alt => Some(Command::Redo),
        KeyCode::Char(letter @ 'A'..='F') if !ctrl && !alt => {
            Priority::new(letter).map(|priority| Command::SetPriority(Some(priority)))
        }
        KeyCode::Char('n') if !ctrl && !alt => Some(Command::Open(ModalId::CreateTodo)),
        KeyCode::Char('e') if !ctrl && !alt => Some(Command::Open(ModalId::EditTodo)),
        KeyCode::Char('x') if !ctrl && !alt => Some(Command::Open(menu_for(app))),
        KeyCode::Char('d') if !ctrl && !alt => Some(Command::Open(ModalId::SetDueDate)),
        KeyCode::Char('t') if !ctrl && !alt => Some(Command::Open(ModalId::SetThresholdDate)),
        KeyCode::Char('r') if !ctrl && !alt => Some(Command::Open(ModalId::SetRecurrence)),
        KeyCode::Char('+') if !ctrl && !alt => Some(Command::Open(ModalId::AddProject)),
        KeyCode::Char('@') if !ctrl && !alt => Some(Command::Open(ModalId::AddContext)),
        KeyCode::Enter => Some(Command::Open(menu_for(app))),
        KeyCode::Char('a') if !ctrl && !alt => Some(Command::Archive),
        KeyCode::Char('c') if !ctrl && !alt => Some(Command::CopySelected),
        KeyCode::Char('v') if !ctrl && !alt => Some(Command::Paste),
        KeyCode::Char('u') if !ctrl && !alt => Some(if app.update_model().is_some() {
            Command::Open(ModalId::Update)
        } else {
            Command::Toast(NO_UPDATE_MESSAGE)
        }),
        KeyCode::Delete => Some(Command::DeleteSelected),
        _ => None,
    }
}

fn menu_for(app: &App) -> ModalId {
    if app.range().is_empty() {
        ModalId::TodoMenu
    } else {
        ModalId::MultiSelectMenu
    }
}

fn search_key(key: KeyEvent) -> Option<Command> {
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    let shift = key.modifiers.contains(KeyModifiers::SHIFT);
    let alt = key
        .modifiers
        .intersects(KeyModifiers::ALT | KeyModifiers::META);

    match key.code {
        KeyCode::Char(ch) if !ctrl && !alt => Some(Command::SearchInsert(ch)),
        KeyCode::Backspace => Some(Command::SearchBackspace),
        KeyCode::Delete => Some(Command::SearchDelete),
        KeyCode::Left => Some(Command::SearchLeft),
        KeyCode::Right => Some(Command::SearchRight),
        KeyCode::Up if shift => Some(Command::ExtendUp),
        KeyCode::Down if shift => Some(Command::ExtendDown),
        KeyCode::Up => Some(Command::Up),
        KeyCode::Down => Some(Command::Down),
        KeyCode::PageUp if shift => Some(Command::ExtendPageUp),
        KeyCode::PageDown if shift => Some(Command::ExtendPageDown),
        KeyCode::PageUp => Some(Command::PageUp),
        KeyCode::PageDown => Some(Command::PageDown),
        KeyCode::Home => Some(Command::Home),
        KeyCode::End => Some(Command::End),
        KeyCode::Enter => Some(Command::SearchBlur),
        KeyCode::Esc => Some(Command::SearchClear),
        _ => None,
    }
}

/// Remember a pointer position for the action bar's hover feedback.
///
/// Wheel events do not move the pointer, so they keep the previous cell. A
/// modal owns the pointer while it is open, but tracking still updates the
/// cell so the bar's hover is correct again once the modal closes.
fn track_pointer(app: &mut App, mouse: MouseInput) {
    if matches!(mouse.kind, MouseKind::Move | MouseKind::LeftClick) {
        app.set_pointer(mouse);
    }
}

/// Apply a mouse event, returning the click to remember for double-click
/// detection (or `None` when the event was not a left click).
///
/// Wheel events scroll the viewport only while the list owns focus. A left
/// click on the action bar maps the clicked segment to its command; a click on
/// a todo row selects it (shift extends) and focuses the list; clicks on
/// headers, the search bar and empty space are ignored. The returned command is
/// already passed through the same read-only gate as a key press.
pub fn handle_mouse(
    app: &mut App,
    mouse: MouseInput,
    last_click: Option<LastClick>,
    now: Instant,
) -> (Option<LastClick>, Option<Command>) {
    track_pointer(app, mouse);
    match mouse.kind {
        MouseKind::WheelUp => {
            if app.search().focused() {
                return (last_click, None);
            }
            nav::scroll(app, -1);
            (last_click, None)
        }
        MouseKind::WheelDown => {
            if app.search().focused() {
                return (last_click, None);
            }
            nav::scroll(app, 1);
            (last_click, None)
        }
        MouseKind::Move => (last_click, None),
        MouseKind::LeftClick => left_click(app, mouse, last_click, now),
    }
}

/// Handle a left click and return the click record plus any command.
fn left_click(
    app: &mut App,
    mouse: MouseInput,
    last_click: Option<LastClick>,
    now: Instant,
) -> (Option<LastClick>, Option<Command>) {
    let layout = app.layout();
    let screen_row = mouse.y.saturating_sub(1);
    let record = LastClick {
        todo_id: None,
        x: mouse.x,
        y: mouse.y,
        at: now,
    };

    if layout.is_action_row(mouse.y) {
        let command = layout
            .action_item_at_cell(mouse.x, mouse.y)
            .map(|command| match command {
                // The bar's Menu item follows the same range rule as the keymap.
                Command::Open(ModalId::TodoMenu) => Command::Open(menu_for(app)),
                other => other,
            });
        return (last_click, gate(app, command));
    }

    let Some(relative) = layout.row_at(screen_row) else {
        return (Some(record), None);
    };
    let row = app.offset() + relative;
    let Some(entry) = app.rows().get(row) else {
        return (Some(record), None);
    };
    let Some(id) = app.row_todo_id(entry) else {
        return (Some(record), None);
    };

    // The Ink list focuses the list on any row click, which blurs the search
    // input without clearing its filter.
    app.blur_search();
    nav::select_row(app, row, mouse.shift);

    let double = !mouse.shift
        && last_click.is_some_and(|previous| {
            now.saturating_duration_since(previous.at) <= DOUBLE_CLICK_WINDOW
                && (previous.todo_id == Some(id)
                    || (previous.x == mouse.x && previous.y == mouse.y))
        });

    // A double-click on the checkbox toggles that todo; on the text it opens
    // the editor. The read-only gate turns either into one bounded toast.
    let command = double.then(|| {
        if clicked_checkbox(app, mouse.x) {
            Command::Toggle
        } else {
            Command::Open(ModalId::EditTodo)
        }
    });
    (
        Some(LastClick {
            todo_id: Some(id),
            ..record
        }),
        gate(app, command),
    )
}

/// True for a character that a one-line bracketed paste may insert.
///
/// Line breaks, tabs and the other C0/C1 controls (plus the two Unicode line
/// separators) are dropped: the search input is one line, and pasted terminal
/// control data must never reach the query. Todo lines may contain tabs, so the
/// one-line rule rejects them here.
fn is_pastable(character: char) -> bool {
    character != '\t' && !thar_core::is_rejected_control(character)
}

/// Route one key event to the active modal, then to the keymap.
///
/// Releases are ignored (a press already ran the command). The modal owns the
/// key first; otherwise the keymap produces a [`Command`] and [`apply`] runs
/// it.
pub fn handle_key(app: &mut App, key: KeyEvent, now: Instant) {
    if key.kind == KeyEventKind::Release {
        return;
    }
    if app.handle_modal_key(key, now) {
        return;
    }
    if let Some(command) = command_for_key(app, key) {
        apply(app, command, now);
    }
}

/// Route a bracketed paste to the active modal, the search bar, or the list.
///
/// The search bar keeps its one-line filter: rejected controls and tab are
/// dropped before the text is spliced in once. The list hands the raw text to
/// [`App::receive_clipboard`], which owns splitting, trimming, validation, the
/// paste limit, the confirmation, and the read-only gate.
pub fn handle_paste(app: &mut App, text: &str, now: Instant) {
    if app.handle_modal_paste(text, now) {
        return;
    }
    if app.search().focused() {
        let text: String = text
            .chars()
            .filter(|character| is_pastable(*character))
            .collect();
        insert_query_text(app, &text);
        return;
    }
    app.receive_clipboard(text, now);
}

/// Route one mouse event to the active modal, then to the list.
///
/// Returns the click to remember for double-click detection. A modal that
/// consumes the event leaves the record unchanged.
pub fn handle_mouse_event(
    app: &mut App,
    mouse: MouseInput,
    last_click: Option<LastClick>,
    now: Instant,
) -> Option<LastClick> {
    // A modal owns the pointer, but the bar still needs the latest cell once
    // the modal closes. Without a modal, `handle_mouse` records it below.
    if app.modals().is_open() {
        track_pointer(app, mouse);
    }
    if app.handle_modal_mouse(mouse, now) {
        return last_click;
    }
    let (next, command) = handle_mouse(app, mouse, last_click, now);
    if let Some(command) = command {
        apply(app, command, now);
    }
    next
}

/// Insert pasted text at the query cursor and rebuild once.
///
/// The text is spliced verbatim: a multi-character paste keeps its order and
/// spacing, and this path never trims (only the clipboard-to-todo path trims
/// whole lines). Doing one rebuild for the whole paste keeps a long bracketed
/// paste from re-sorting the list per character.
pub fn insert_query_text(app: &mut App, text: &str) {
    if text.is_empty() {
        return;
    }
    app.edit_query(|search| search.insert_text(text));
}

/// Apply one command to the app state at `now`.
pub fn apply(app: &mut App, command: Command, now: Instant) {
    match command {
        Command::Quit => app.set_should_quit(),
        Command::SearchFocus => app.focus_search(),
        Command::SearchBlur => app.blur_search(),
        Command::SearchClear => app.clear_search(),
        Command::SearchInsert(ch) => app.edit_query(|search| search.insert_char(ch)),
        Command::SearchBackspace => app.edit_query(|search| search.backspace()),
        Command::SearchDelete => app.edit_query(|search| search.delete()),
        Command::SearchLeft => app.move_query_cursor(|search| search.move_left()),
        Command::SearchRight => app.move_query_cursor(|search| search.move_right()),
        Command::Up => nav::move_cursor(app, -1, false),
        Command::Down => nav::move_cursor(app, 1, false),
        Command::ContextUp => nav::move_context(app, -1, false),
        Command::ContextDown => nav::move_context(app, 1, false),
        Command::ExtendContextUp => nav::move_context(app, -1, true),
        Command::ExtendContextDown => nav::move_context(app, 1, true),
        Command::PageUp => nav::move_cursor(app, -5, false),
        Command::PageDown => nav::move_cursor(app, 5, false),
        Command::ExtendPageUp => nav::move_cursor(app, -5, true),
        Command::ExtendPageDown => nav::move_cursor(app, 5, true),
        Command::Home => nav::select_first(app),
        Command::End => nav::select_last(app),
        Command::ToggleHiddenView => app.toggle_hidden_view(),
        Command::ClearRange => nav::clear_range(app),
        Command::ExtendUp => nav::move_cursor(app, -1, true),
        Command::ExtendDown => nav::move_cursor(app, 1, true),
        Command::Open(id) => app.open_modal(id),
        Command::Toggle => {
            let ids = app.selected_ids();
            app.toggle_ids(&ids, now);
        }
        Command::ToggleHidden => {
            let ids = app.selected_ids();
            app.update_ids(&ids, now, |todo| todo.toggle_hidden());
        }
        Command::SetPriority(priority) => {
            let ids = app.selected_ids();
            app.set_priority_ids(&ids, priority, now);
        }
        Command::Undo => {
            app.undo(now);
        }
        Command::Redo => {
            app.redo(now);
        }
        Command::SuggestionPrevious => app.select_suggestion(Direction::Up),
        Command::SuggestionNext => app.select_suggestion(Direction::Down),
        Command::SuggestionApply => app.apply_suggestion(),
        Command::SuggestionClose => app.clear_search_suggestions(),
        Command::Archive => {
            app.apply_action(Action::Confirm(ConfirmRequest::archive()), now);
        }
        Command::DeleteSelected => {
            let ids = app.selected_ids();
            if ids.is_empty() {
                app.push_toast_at("Nothing to delete", now);
            } else {
                app.apply_action(Action::Confirm(ConfirmRequest::delete(ids)), now);
            }
        }
        Command::CopySelected => {
            let ids = app.selected_ids();
            app.apply_action(Action::Copy { ids }, now);
        }
        Command::Paste => app.apply_action(Action::Paste, now),
        Command::Toast(message) => app.push_toast_at(message, now),
    }
}

/// Is the 1-based terminal column on the checkbox of a todo row?
///
/// The window comes from [`checkbox_columns`], the same table the renderer and
/// the Ink list use, so a prefix change cannot leave the double-click checkbox
/// test pointing at the wrong columns.
#[must_use]
pub fn clicked_checkbox(app: &App, x: u16) -> bool {
    let columns = checkbox_columns(app.max_todo_number_digits());
    columns.contains(&x.saturating_sub(1))
}

#[cfg(test)]
mod tests {
    use super::{
        Command, MouseInput, MouseKind, apply, command_for_key, handle_key, handle_mouse,
        handle_paste, is_pastable,
    };
    use crate::app::App;
    use crate::messages::{NO_UPDATE_MESSAGE, READ_ONLY_MESSAGE};
    use crate::modal::{ModalId, UpdateModel};
    use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
    use std::time::{Duration, Instant};
    use thar_core::{Priority, Todo, TodoDate, TodoId};

    fn key(code: KeyCode, modifiers: KeyModifiers) -> KeyEvent {
        KeyEvent::new(code, modifiers)
    }

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
        app.resize(40, 10);
        app
    }

    fn writable(lines: &[&str]) -> App {
        let mut app = app(lines);
        app.set_read_only(false);
        app
    }

    #[test]
    fn search_typing_filters_and_escape_clears() {
        let mut app = writable(&["write docs", "buy milk"]);
        apply(&mut app, Command::SearchFocus, now());
        for ch in "docs".chars() {
            assert_eq!(
                command_for_key(&app, key(KeyCode::Char(ch), KeyModifiers::NONE)),
                Some(Command::SearchInsert(ch))
            );
            apply(&mut app, Command::SearchInsert(ch), now());
        }
        assert_eq!(app.rows().iter().filter(|row| row.is_todo()).count(), 1);
        apply(&mut app, Command::SearchClear, now());
        assert_eq!(app.search().query(), "");
        assert_eq!(app.rows().iter().filter(|row| row.is_todo()).count(), 2);
    }

    #[test]
    fn backspace_and_delete_edit_at_the_cursor() {
        let mut app = writable(&["one"]);
        apply(&mut app, Command::SearchFocus, now());
        for ch in "abc".chars() {
            apply(&mut app, Command::SearchInsert(ch), now());
        }
        apply(&mut app, Command::SearchLeft, now());
        apply(&mut app, Command::SearchBackspace, now());
        assert_eq!(app.search().query(), "ac");
        assert_eq!(app.search().cursor(), 1);
        apply(&mut app, Command::SearchDelete, now());
        assert_eq!(app.search().query(), "a");
    }

    #[test]
    fn mutating_keys_are_rejected_with_one_message() {
        let app = app(&["one"]);
        for code in [
            KeyCode::Char(' '),
            KeyCode::Char('n'),
            KeyCode::Char('e'),
            KeyCode::Delete,
        ] {
            assert_eq!(
                command_for_key(&app, key(code, KeyModifiers::NONE)),
                Some(Command::Toast(READ_ONLY_MESSAGE))
            );
        }
        let mut app = app;
        apply(&mut app, Command::Toast(READ_ONLY_MESSAGE), now());
        assert_eq!(app.toast_message(now()), Some(READ_ONLY_MESSAGE));
    }

    #[test]
    fn non_mutating_commands_are_not_rejected_in_a_read_only_session() {
        let app = app(&["one"]);
        for (code, modifiers, expected) in [
            (KeyCode::Up, KeyModifiers::NONE, Command::Up),
            (KeyCode::Down, KeyModifiers::NONE, Command::Down),
            (KeyCode::Home, KeyModifiers::NONE, Command::Home),
            (KeyCode::End, KeyModifiers::NONE, Command::End),
            (KeyCode::Char('/'), KeyModifiers::NONE, Command::SearchFocus),
            (KeyCode::Char('q'), KeyModifiers::NONE, Command::Quit),
            (
                KeyCode::Char('c'),
                KeyModifiers::NONE,
                Command::CopySelected,
            ),
            (
                KeyCode::Char('H'),
                KeyModifiers::SHIFT,
                Command::ToggleHiddenView,
            ),
        ] {
            assert_eq!(
                command_for_key(&app, key(code, modifiers)),
                Some(expected),
                "{code:?} must stay available read-only"
            );
        }
    }

    #[test]
    fn the_read_only_gate_rejects_every_mutating_list_key() {
        let app = app(&["one"]);
        for code in [
            KeyCode::Char(' '),
            KeyCode::Char('x'),
            KeyCode::Char('n'),
            KeyCode::Char('z'),
            KeyCode::Char('Z'),
            KeyCode::Char('v'),
            KeyCode::Char('e'),
            KeyCode::Char('a'),
            KeyCode::Char('d'),
            KeyCode::Char('t'),
            KeyCode::Char('r'),
            KeyCode::Char('h'),
            KeyCode::Char('+'),
            KeyCode::Char('@'),
            KeyCode::Char('A'),
            KeyCode::Char('B'),
            KeyCode::Char('C'),
            KeyCode::Char('D'),
            KeyCode::Char('E'),
            KeyCode::Char('F'),
            KeyCode::Delete,
            KeyCode::Enter,
        ] {
            assert_eq!(
                command_for_key(&app, key(code, KeyModifiers::NONE)),
                Some(Command::Toast(READ_ONLY_MESSAGE)),
                "{code:?} must be rejected by the one gate"
            );
        }
    }

    #[test]
    fn one_gate_produces_exactly_one_bounded_toast() {
        let mut app = app(&["write the docs"]);
        let command =
            command_for_key(&app, key(KeyCode::Char('x'), KeyModifiers::NONE)).expect("command");
        assert_eq!(command, Command::Toast(READ_ONLY_MESSAGE));
        apply(&mut app, command, now());

        // A second gated command at the same instant replaces the toast; it
        // never stacks into a second message.
        let second =
            command_for_key(&app, key(KeyCode::Char('n'), KeyModifiers::NONE)).expect("command");
        apply(&mut app, second, now());
        assert_eq!(app.toast_message(now()), Some(READ_ONLY_MESSAGE));

        assert_eq!(app.cursor(), Some(TodoId::new(0)));
        assert_eq!(app.search().query(), "");
    }

    #[test]
    fn hidden_view_key_is_supported() {
        assert_eq!(
            command_for_key(
                &app(&["one h:1"]),
                key(KeyCode::Char('H'), KeyModifiers::SHIFT)
            ),
            Some(Command::ToggleHiddenView)
        );
        let mut app = app(&["one h:1"]);
        let before = app.rows().iter().filter(|row| row.is_todo()).count();
        apply(&mut app, Command::ToggleHiddenView, now());
        let after = app.rows().iter().filter(|row| row.is_todo()).count();
        assert_eq!((before, after), (0, 1));
    }

    #[test]
    fn search_suggestions_take_key_precedence_and_apply() {
        let mut app = writable(&["one +thar @home"]);
        app.set_search_focused(true);
        app.set_query("+th");
        assert!(app.search().suggestions().is_open());

        assert_eq!(
            command_for_key(&app, key(KeyCode::Up, KeyModifiers::NONE)),
            Some(Command::SuggestionPrevious)
        );
        assert_eq!(
            command_for_key(&app, key(KeyCode::Enter, KeyModifiers::NONE)),
            Some(Command::SuggestionApply)
        );
        assert_eq!(
            command_for_key(&app, key(KeyCode::Esc, KeyModifiers::NONE)),
            Some(Command::SuggestionClose)
        );

        apply(&mut app, Command::SuggestionApply, now());
        assert_eq!(app.search().query(), "+thar ");
        assert!(!app.search().suggestions().is_open());
        assert_eq!(app.rows().iter().filter(|row| row.is_todo()).count(), 1);
    }

    #[test]
    fn clicking_a_row_selects_it_and_a_double_click_is_rejected() {
        let mut app = app(&["one", "two"]);
        // Rows: None header at screen row 1, todo 1 at row 2, todo 2 at row 3.
        let now = now();
        let mouse = MouseInput {
            kind: MouseKind::LeftClick,
            x: 1,
            y: 3,
            shift: false,
        };
        let (last, command) = handle_mouse(&mut app, mouse, None, now);
        assert_eq!(command, None);
        assert_eq!(
            app.selected_todo().map(|todo| todo.text.as_str()),
            Some("two")
        );

        let (_, command) = handle_mouse(&mut app, mouse, last, now + Duration::from_millis(100));
        assert_eq!(command, Some(Command::Toast(READ_ONLY_MESSAGE)));
    }

    #[test]
    fn clicking_a_context_header_does_not_move_the_cursor() {
        let mut app = app(&["one @home"]);
        let before = app.cursor();
        handle_mouse(
            &mut app,
            MouseInput {
                kind: MouseKind::LeftClick,
                x: 1,
                y: 1,
                shift: false,
            },
            None,
            now(),
        );
        assert_eq!(app.cursor(), before);
    }

    #[test]
    fn the_writable_list_keys_reach_the_new_commands() {
        let app = writable(&["one", "two"]);
        let plain = |code| key(code, KeyModifiers::NONE);

        assert_eq!(
            command_for_key(&app, plain(KeyCode::Char('a'))),
            Some(Command::Archive)
        );
        assert_eq!(
            command_for_key(&app, plain(KeyCode::Char('c'))),
            Some(Command::CopySelected)
        );
        assert_eq!(
            command_for_key(&app, plain(KeyCode::Char('v'))),
            Some(Command::Paste)
        );
        assert_eq!(
            command_for_key(&app, plain(KeyCode::Delete)),
            Some(Command::DeleteSelected)
        );
        assert_eq!(
            command_for_key(&app, plain(KeyCode::Char('u'))),
            Some(Command::Toast(NO_UPDATE_MESSAGE))
        );
        assert_eq!(
            command_for_key(&app, plain(KeyCode::Char('F'))),
            Some(Command::SetPriority(Some(
                Priority::new('F').expect("valid priority")
            )))
        );
    }

    #[test]
    fn the_update_screen_is_reachable_in_both_modes() {
        let mut app = app(&["one"]);
        app.set_update_model(Some(UpdateModel::default()));
        assert_eq!(
            command_for_key(&app, key(KeyCode::Char('u'), KeyModifiers::NONE)),
            Some(Command::Open(ModalId::Update))
        );
        assert!(!Command::Open(ModalId::Update).mutates());
        assert!(Command::Open(ModalId::EditTodo).mutates());

        // Opening it in read-only mode is not gated.
        apply(&mut app, Command::Open(ModalId::Update), now());
        assert_eq!(
            app.modals().top().map(|modal| modal.id()),
            Some(ModalId::Update)
        );
    }

    #[test]
    fn archive_and_delete_apply_through_a_confirmation() {
        let mut archive_app = writable(&["one", "two"]);
        apply(&mut archive_app, Command::Archive, now());
        assert_eq!(
            archive_app.modals().top().map(|modal| modal.title()),
            Some("Archive Completed")
        );

        let mut delete_app = writable(&["one", "two"]);
        apply(&mut delete_app, Command::DeleteSelected, now());
        let modal = delete_app.modals().top().expect("delete confirmation");
        assert_eq!(modal.title(), "Delete Todo");
        assert_eq!(modal.id(), ModalId::Confirm);
    }

    #[test]
    fn copy_and_paste_become_host_effects() {
        let mut app = writable(&["one @home", "two"]);
        apply(&mut app, Command::CopySelected, now());
        assert_eq!(
            app.take_effects(),
            vec![crate::Effect::Copy("two".to_owned())]
        );

        apply(&mut app, Command::Paste, now());
        assert_eq!(app.take_effects(), vec![crate::Effect::Paste]);
    }

    #[test]
    fn mutates_is_honest_about_every_variant() {
        for command in [
            Command::Quit,
            Command::SearchFocus,
            Command::SearchBlur,
            Command::SearchClear,
            Command::SearchInsert('a'),
            Command::SearchBackspace,
            Command::SearchDelete,
            Command::SearchLeft,
            Command::SearchRight,
            Command::Up,
            Command::CopySelected,
            Command::Toast(NO_UPDATE_MESSAGE),
            Command::Toast(READ_ONLY_MESSAGE),
            Command::Open(ModalId::Update),
        ] {
            assert!(!command.mutates(), "{command:?} must not mutate");
        }
        for command in [
            Command::Toggle,
            Command::ToggleHidden,
            Command::SetPriority(None),
            Command::Undo,
            Command::Redo,
            Command::Archive,
            Command::DeleteSelected,
            Command::Paste,
            Command::Open(ModalId::CreateTodo),
            Command::Open(ModalId::EditTodo),
        ] {
            assert!(command.mutates(), "{command:?} must mutate");
        }
    }

    #[test]
    fn only_safe_one_line_characters_are_pastable() {
        assert!(is_pastable('a'));
        assert!(is_pastable('🚀'));
        assert!(!is_pastable('\n'));
        assert!(!is_pastable('\t'), "the search bar is one line");
        assert!(!is_pastable('\u{001B}'));
        assert!(!is_pastable('\u{007F}'));
        assert!(!is_pastable('\u{2028}'));
    }

    #[test]
    fn a_search_paste_drops_controls_and_tab_then_inserts_once() {
        let mut app = writable(&["one"]);
        app.focus_search();
        handle_paste(&mut app, "do\tcs\u{001B}", now());
        assert_eq!(app.search().query(), "docs");
        assert_eq!(app.search().cursor(), 4);
    }

    #[test]
    fn release_events_are_ignored() {
        let mut app = writable(&["one"]);
        let mut release = key(KeyCode::Char('q'), KeyModifiers::NONE);
        release.kind = KeyEventKind::Release;
        handle_key(&mut app, release, now());
        assert!(!app.should_quit());
    }

    #[test]
    fn an_open_modal_owns_the_key_before_the_list_keymap() {
        let mut app = writable(&["one"]);
        app.open_modal(ModalId::CreateTodo);
        handle_key(&mut app, key(KeyCode::Char('q'), KeyModifiers::NONE), now());
        assert!(!app.should_quit());
        assert!(app.modals().is_open());
    }
}
