//! Event mapping: crossterm keys and mouse events to [`Command`]s.
//!
//! CP6 is read-only. The list keymap is the Ink app's (`components/TodoList.tsx`)
//! minus every command that needs a modal or a write: those keys are mapped to
//! [`Command::Rejected`] so the press is acknowledged with one bounded toast
//! instead of being silently ignored. Navigation, search, the hidden-view
//! toggle, scrolling and the mouse are fully functional.
//!
//! The mapping is a pure function of the key plus focus state, and [`apply`] is
//! a pure state transition over [`App`], so unit tests drive both without a
//! terminal. Mouse coordinates are the ones `thar-cli` produces: 1-based
//! terminal cells, converted through the shared [`crate::layout::Layout`].
//!
//! # Search parity
//!
//! While the search bar has focus, `SearchInput.tsx` intercepts Up/Down,
//! PageUp/PageDown, Home and End *before* the text editor sees them, so those
//! keys navigate the todo list instead of moving the query cursor. Only
//! Left/Right, Backspace and Delete edit the query; Enter keeps the filter and
//! blurs, Escape clears the filter and blurs.

use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

use crate::app::App;
use crate::layout::{action_item_at, checkbox_columns};
use crate::modal::{Action, ConfirmRequest, ModalId};
use crate::nav;

/// Message shown for every key that would modify `todo.txt`.
pub const READ_ONLY_MESSAGE: &str = "Read-only: thar-rs cannot modify todo.txt";

/// Window for treating two clicks as a double-click, matching the Ink list.
pub const DOUBLE_CLICK_WINDOW: std::time::Duration = std::time::Duration::from_millis(350);

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
    /// Move the query cursor to the start.
    ///
    /// Kept for callers that edit the query directly. CP6's keymap does not
    /// bind it: Home navigates the todo list, like the Ink handler.
    SearchHome,
    /// Move the query cursor to the end (see [`Command::SearchHome`]).
    SearchEnd,
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
    /// Scroll the viewport up without moving the cursor.
    ScrollUp,
    /// Scroll the viewport down without moving the cursor.
    ScrollDown,
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
    /// Set a priority on the selected todos.
    SetPriority(char),
    /// Undo the last mutation.
    Undo,
    /// Redo the last undo.
    Redo,
    /// Confirm and archive every completed todo.
    Archive,
    /// Confirm and delete the selected todos.
    DeleteSelected,
    /// Copy the selected todos to the clipboard.
    CopySelected,
    /// Read the clipboard and add its lines as todos.
    Paste,
    /// Open the update screen when the host supplied a model.
    Update,
    /// Show a bounded static message.
    Toast(&'static str),
    /// A command CP6 does not support; the payload is the toast to show.
    Rejected(&'static str),
}

/// Translate a key press into a command.
///
/// `search_focused` is the only piece of context the keymap needs: the search
/// bar owns printable input and query editing, while the list owns navigation.
/// Ctrl+C quits in both modes.
#[must_use]
pub fn command_for_key(key: KeyEvent, search_focused: bool) -> Option<Command> {
    if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
        return Some(Command::Quit);
    }

    if search_focused {
        return search_key(key);
    }

    list_key(key)
}

/// Translate a key press for a specific app state.
///
/// This is the CP7 entry point: a read-only session keeps the CP6 mapping (a
/// mutating key is one bounded toast), while `--write` maps the same keys to
/// the mutation or modal they name. Keeping the mode out of the pure keymap
/// means the CP6 tests still pin the read-only contract.
#[must_use]
pub fn command_for_key_in(app: &App, key: KeyEvent) -> Option<Command> {
    if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
        return Some(Command::Quit);
    }

    if app.search_focused {
        return search_key(key);
    }

    if app.read_only {
        list_key(key)
    } else {
        writable_list_key(app, key)
    }
}

/// The list keymap when `--write` is active.
fn writable_list_key(app: &App, key: KeyEvent) -> Option<Command> {
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    let alt = key
        .modifiers
        .intersects(KeyModifiers::ALT | KeyModifiers::META);

    match key.code {
        KeyCode::Char(' ') if !ctrl && !alt => Some(Command::Toggle),
        KeyCode::Char('h') if !ctrl && !alt => Some(Command::ToggleHidden),
        KeyCode::Char('z') if !ctrl && !alt => Some(Command::Undo),
        KeyCode::Char('Z') if !ctrl && !alt => Some(Command::Redo),
        KeyCode::Char(letter @ 'A'..='F') if !ctrl && !alt => Some(Command::SetPriority(letter)),
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
        KeyCode::Char('u') if !ctrl && !alt => Some(if app.update_model.is_some() {
            Command::Open(ModalId::Update)
        } else {
            Command::Toast(NO_UPDATE_MESSAGE)
        }),
        KeyCode::Delete => Some(Command::DeleteSelected),
        _ => list_key(key),
    }
}

/// Bounded message when `u` is pressed without update information.
pub const NO_UPDATE_MESSAGE: &str = "No update available";

fn menu_for(app: &App) -> ModalId {
    if app.range.is_empty() {
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

fn list_key(key: KeyEvent) -> Option<Command> {
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
        // The rest of the list keymap either opens a modal or writes. A-F is
        // the priority keymap; every other uppercase letter is not a command
        // in the Ink list either.
        KeyCode::Char(' ')
        | KeyCode::Char('x')
        | KeyCode::Char('n')
        | KeyCode::Char('u')
        | KeyCode::Char('z')
        | KeyCode::Char('Z')
        | KeyCode::Char('v')
        | KeyCode::Char('e')
        | KeyCode::Char('a')
        | KeyCode::Char('d')
        | KeyCode::Char('t')
        | KeyCode::Char('r')
        | KeyCode::Char('c')
        | KeyCode::Char('h')
        | KeyCode::Char('+')
        | KeyCode::Char('@')
        | KeyCode::Delete
        | KeyCode::Enter => Some(Command::Rejected(READ_ONLY_MESSAGE)),
        KeyCode::Char('A'..='F') if !ctrl && !alt => Some(Command::Rejected(READ_ONLY_MESSAGE)),
        _ => None,
    }
}

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

/// A mouse event in terminal coordinates (1-based, as crossterm reports them).
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

/// A pending click, used for the 350 ms double-click window.
///
/// Every left click records its position; only a click that landed on a todo
/// row carries its id. A following click counts as a double-click when it is
/// within [`DOUBLE_CLICK_WINDOW`] and repeats either the todo or the cell.
#[derive(Clone, Copy, Debug)]
pub struct LastClick {
    /// Clicked todo id, or `None` when the click did not land on a todo row.
    pub todo_id: Option<thar_core::TodoId>,
    /// 1-based column.
    pub x: u16,
    /// 1-based row.
    pub y: u16,
    /// Arrival time.
    pub at: std::time::Instant,
}

/// Apply a mouse event, returning the click to remember for double-click
/// detection (or `None` when the event was not a left click).
///
/// Wheel events scroll the viewport only while the list owns focus. A left
/// click on the action bar maps the clicked segment to its command; a click on
/// a todo row selects it (shift extends) and focuses the list; clicks on
/// headers, the search bar and empty space are ignored.
pub fn handle_mouse(
    app: &mut App,
    mouse: MouseInput,
    last_click: Option<LastClick>,
    now: std::time::Instant,
) -> (Option<LastClick>, Option<Command>) {
    match mouse.kind {
        MouseKind::WheelUp => {
            if app.search_focused {
                return (last_click, None);
            }
            nav::scroll(app, -1);
            (last_click, None)
        }
        MouseKind::WheelDown => {
            if app.search_focused {
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
    now: std::time::Instant,
) -> (Option<LastClick>, Option<Command>) {
    let layout = app.layout();
    let screen_row = mouse.y.saturating_sub(1);
    let record = LastClick {
        todo_id: None,
        x: mouse.x,
        y: mouse.y,
        at: now,
    };

    if screen_row == layout.action_row() {
        let command = match action_item_at(mouse.x.saturating_sub(1)) {
            Some("q") => Some(Command::Quit),
            Some("/") => Some(Command::SearchFocus),
            Some(_) if app.read_only => Some(Command::Rejected(READ_ONLY_MESSAGE)),
            Some("x") => Some(Command::Open(menu_for(app))),
            Some("n") => Some(Command::Open(ModalId::CreateTodo)),
            Some("e") => Some(Command::Open(ModalId::EditTodo)),
            _ => None,
        };
        return (last_click, command);
    }

    let Some(relative) = layout.row_at(screen_row) else {
        return (Some(record), None);
    };
    let row = app.offset + relative;
    let Some(entry) = app.rows().get(row) else {
        return (Some(record), None);
    };
    let Some(todo_index) = entry.todo_index() else {
        return (Some(record), None);
    };
    let Some(id) = app.todo_at(todo_index).map(|todo| todo.id) else {
        return (Some(record), None);
    };

    // The Ink list focuses the list on any row click, which blurs the search
    // input without clearing its filter.
    app.search_focused = false;
    nav::select_row(app, row, mouse.shift);

    let double = !mouse.shift
        && last_click.is_some_and(|previous| {
            now.saturating_duration_since(previous.at) <= DOUBLE_CLICK_WINDOW
                && (previous.todo_id == Some(id)
                    || (previous.x == mouse.x && previous.y == mouse.y))
        });

    // A double-click on the checkbox toggles that todo; on the text it opens
    // the editor. The read-only build acknowledges the intent with one toast.
    let command = double.then(|| {
        if app.read_only {
            Command::Rejected(READ_ONLY_MESSAGE)
        } else if clicked_checkbox(app, mouse.x) {
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
        command,
    )
}

/// Insert pasted text at the query cursor and rebuild once.
///
/// The terminal filters characters before calling this; doing one rebuild for
/// the whole paste keeps a long bracketed paste from re-sorting the list per
/// character.
pub fn insert_query_text(app: &mut App, text: &str) {
    if text.is_empty() {
        return;
    }
    let cursor = app.query_cursor.min(app.query.chars().count());
    let inserted: Vec<char> = text.chars().collect();
    let mut chars: Vec<char> = app.query.chars().collect();
    // Splice once: inserting each character at `cursor` would reverse the
    // pasted run (the cursor must advance between insertions).
    chars.splice(cursor..cursor, inserted.iter().copied());
    app.query = chars.into_iter().collect();
    app.query_cursor = cursor + inserted.len();
    nav::rebuild(app);
}

/// Apply one command to the app state.
pub fn apply(app: &mut App, command: Command) {
    match command {
        Command::Quit => app.should_quit = true,
        Command::SearchFocus => {
            let was_visible = app.search_visible();
            app.search_focused = true;
            if app.search_visible() != was_visible {
                nav::reflow(app);
            } else {
                app.clamp_offset();
            }
        }
        Command::SearchBlur => {
            let was_visible = app.search_visible();
            app.search_focused = false;
            if app.search_visible() != was_visible {
                nav::reflow(app);
            } else {
                app.clamp_offset();
            }
        }
        Command::SearchClear => {
            app.search_focused = false;
            app.query.clear();
            app.query_cursor = 0;
            nav::rebuild(app);
        }
        Command::SearchInsert(ch) => insert_query_char(app, ch),
        Command::SearchBackspace => backspace_query(app),
        Command::SearchDelete => delete_query(app),
        Command::SearchLeft => {
            app.query_cursor = app.query_cursor.saturating_sub(1);
        }
        Command::SearchRight => {
            app.query_cursor = (app.query_cursor + 1).min(app.query.chars().count());
        }
        Command::SearchHome => app.query_cursor = 0,
        Command::SearchEnd => app.query_cursor = app.query.chars().count(),
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
        Command::ScrollUp => nav::scroll(app, -1),
        Command::ScrollDown => nav::scroll(app, 1),
        Command::ToggleHiddenView => nav::toggle_hidden_view(app),
        Command::ClearRange => nav::clear_range(app),
        Command::ExtendUp => nav::move_cursor(app, -1, true),
        Command::ExtendDown => nav::move_cursor(app, 1, true),
        Command::Open(id) => app.open_modal(id),
        Command::Toggle => {
            let ids = selected_ids(app);
            app.toggle_ids(&ids);
        }
        Command::ToggleHidden => {
            let ids = selected_ids(app);
            app.update_ids(&ids, |todo| todo.clone().toggle_hidden());
        }
        Command::SetPriority(letter) => {
            let ids = selected_ids(app);
            app.set_priority_ids(&ids, Some(letter));
        }
        Command::Undo => {
            app.undo();
        }
        Command::Redo => {
            app.redo();
        }
        Command::Archive => {
            app.apply_action(Action::Confirm(ConfirmRequest::archive()));
        }
        Command::DeleteSelected => {
            let ids = selected_ids(app);
            if ids.is_empty() {
                app.push_toast("Nothing to delete");
            } else {
                app.apply_action(Action::Confirm(ConfirmRequest::delete(ids)));
            }
        }
        Command::CopySelected => {
            let ids = selected_ids(app);
            app.apply_action(Action::Copy { ids });
        }
        Command::Paste => app.apply_action(Action::Paste),
        Command::Update => app.open_modal(ModalId::Update),
        Command::Toast(message) => app.push_toast(message),
        Command::Rejected(message) => app.push_toast(message),
    }
}

/// Ids of the active selection, in load order.
fn selected_ids(app: &App) -> Vec<thar_core::TodoId> {
    app.selected_todos().iter().map(|todo| todo.id).collect()
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

fn insert_query_char(app: &mut App, ch: char) {
    let cursor = app.query_cursor.min(app.query.chars().count());
    let mut chars: Vec<char> = app.query.chars().collect();
    chars.insert(cursor, ch);
    app.query = chars.into_iter().collect();
    app.query_cursor = cursor + 1;
    nav::rebuild(app);
}

fn backspace_query(app: &mut App) {
    let cursor = app.query_cursor.min(app.query.chars().count());
    if cursor == 0 {
        return;
    }
    let mut chars: Vec<char> = app.query.chars().collect();
    chars.remove(cursor - 1);
    app.query = chars.into_iter().collect();
    app.query_cursor = cursor - 1;
    nav::rebuild(app);
}

fn delete_query(app: &mut App) {
    let cursor = app.query_cursor.min(app.query.chars().count());
    let mut chars: Vec<char> = app.query.chars().collect();
    if cursor < chars.len() {
        chars.remove(cursor);
        app.query = chars.into_iter().collect();
        nav::rebuild(app);
    }
}

#[cfg(test)]
mod tests {
    use super::{
        Command, MouseInput, MouseKind, NO_UPDATE_MESSAGE, READ_ONLY_MESSAGE, apply,
        command_for_key, command_for_key_in, handle_mouse,
    };
    use crate::app::App;
    use crate::modal::{ModalId, UpdateModel};
    use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    use std::time::{Duration, Instant};
    use thar_core::{Todo, TodoDate, TodoId};

    fn key(code: KeyCode, modifiers: KeyModifiers) -> KeyEvent {
        KeyEvent::new(code, modifiers)
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
            TodoDate::parse("2026-11-15").expect("valid date"),
        );
        app.resize(40, 10);
        app
    }

    #[test]
    fn search_typing_filters_and_escape_clears() {
        let mut app = app(&["write docs", "buy milk"]);
        apply(&mut app, Command::SearchFocus);
        for ch in "docs".chars() {
            assert_eq!(
                command_for_key(key(KeyCode::Char(ch), KeyModifiers::NONE), true),
                Some(Command::SearchInsert(ch))
            );
            apply(&mut app, Command::SearchInsert(ch));
        }
        assert_eq!(app.list.rows.iter().filter(|row| row.is_todo()).count(), 1);
        apply(&mut app, Command::SearchClear);
        assert_eq!(app.query, "");
        assert_eq!(app.list.rows.iter().filter(|row| row.is_todo()).count(), 2);
    }

    #[test]
    fn backspace_and_delete_edit_at_the_cursor() {
        let mut app = app(&["one"]);
        apply(&mut app, Command::SearchFocus);
        for ch in "abc".chars() {
            apply(&mut app, Command::SearchInsert(ch));
        }
        apply(&mut app, Command::SearchLeft);
        apply(&mut app, Command::SearchBackspace);
        assert_eq!(app.query, "ac");
        assert_eq!(app.query_cursor, 1);
        apply(&mut app, Command::SearchDelete);
        assert_eq!(app.query, "a");
    }

    #[test]
    fn mutating_keys_are_rejected_with_one_message() {
        for code in [
            KeyCode::Char(' '),
            KeyCode::Char('n'),
            KeyCode::Char('e'),
            KeyCode::Delete,
        ] {
            assert_eq!(
                command_for_key(key(code, KeyModifiers::NONE), false),
                Some(Command::Rejected(READ_ONLY_MESSAGE))
            );
        }
        let mut app = app(&["one"]);
        apply(&mut app, Command::Rejected(READ_ONLY_MESSAGE));
        assert_eq!(app.toast_message(Instant::now()), Some(READ_ONLY_MESSAGE));
    }

    #[test]
    fn hidden_view_key_is_supported() {
        assert_eq!(
            command_for_key(key(KeyCode::Char('H'), KeyModifiers::SHIFT), false),
            Some(Command::ToggleHiddenView)
        );
        let mut app = app(&["one h:1"]);
        let before = app.list.rows.iter().filter(|row| row.is_todo()).count();
        apply(&mut app, Command::ToggleHiddenView);
        let after = app.list.rows.iter().filter(|row| row.is_todo()).count();
        assert_eq!((before, after), (0, 1));
    }

    #[test]
    fn clicking_a_row_selects_it_and_a_double_click_is_rejected() {
        let mut app = app(&["one", "two"]);
        // Rows: None header at screen row 1, todo 1 at row 2, todo 2 at row 3.
        let now = Instant::now();
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
        assert_eq!(command, Some(Command::Rejected(READ_ONLY_MESSAGE)));
    }

    #[test]
    fn clicking_a_context_header_does_not_move_the_cursor() {
        let mut app = app(&["one @home"]);
        let before = app.cursor;
        handle_mouse(
            &mut app,
            MouseInput {
                kind: MouseKind::LeftClick,
                x: 1,
                y: 1,
                shift: false,
            },
            None,
            Instant::now(),
        );
        assert_eq!(app.cursor, before);
    }

    #[test]
    fn the_writable_list_keys_reach_the_new_commands() {
        let mut app = app(&["one", "two"]);
        app.read_only = false;
        let plain = |code| key(code, KeyModifiers::NONE);

        assert_eq!(
            command_for_key_in(&app, plain(KeyCode::Char('a'))),
            Some(Command::Archive)
        );
        assert_eq!(
            command_for_key_in(&app, plain(KeyCode::Char('c'))),
            Some(Command::CopySelected)
        );
        assert_eq!(
            command_for_key_in(&app, plain(KeyCode::Char('v'))),
            Some(Command::Paste)
        );
        assert_eq!(
            command_for_key_in(&app, plain(KeyCode::Delete)),
            Some(Command::DeleteSelected)
        );
        assert_eq!(
            command_for_key_in(&app, plain(KeyCode::Char('u'))),
            Some(Command::Toast(NO_UPDATE_MESSAGE))
        );

        app.update_model = Some(UpdateModel::default());
        assert_eq!(
            command_for_key_in(&app, plain(KeyCode::Char('u'))),
            Some(Command::Open(ModalId::Update))
        );
    }

    #[test]
    fn the_read_only_keymap_rejects_every_new_writable_key() {
        let mut app = app(&["one"]);
        for code in [
            KeyCode::Char('a'),
            KeyCode::Char('c'),
            KeyCode::Char('v'),
            KeyCode::Char('u'),
            KeyCode::Delete,
        ] {
            assert_eq!(
                command_for_key_in(&app, key(code, KeyModifiers::NONE)),
                Some(Command::Rejected(READ_ONLY_MESSAGE)),
                "{code:?} must stay read-only"
            );
        }
        app.read_only = false;
        assert_ne!(
            command_for_key_in(&app, key(KeyCode::Char('a'), KeyModifiers::NONE)),
            Some(Command::Rejected(READ_ONLY_MESSAGE))
        );
    }

    #[test]
    fn archive_and_delete_apply_through_a_confirmation() {
        let mut archive_app = app(&["one", "two"]);
        archive_app.read_only = false;
        apply(&mut archive_app, Command::Archive);
        assert_eq!(
            archive_app.modals.top().map(|modal| modal.title()),
            Some("Archive Completed")
        );

        let mut delete_app = app(&["one", "two"]);
        delete_app.read_only = false;
        apply(&mut delete_app, Command::DeleteSelected);
        let modal = delete_app.modals.top().expect("delete confirmation");
        assert_eq!(modal.title(), "Delete Todo");
        assert_eq!(modal.id(), ModalId::Confirm);
    }

    #[test]
    fn copy_and_paste_become_host_effects() {
        let mut app = app(&["one @home", "two"]);
        app.read_only = false;
        apply(&mut app, Command::CopySelected);
        assert_eq!(
            app.take_effects(),
            vec![crate::Effect::Copy("two".to_owned())]
        );

        apply(&mut app, Command::Paste);
        assert_eq!(app.take_effects(), vec![crate::Effect::Paste]);
    }
}
