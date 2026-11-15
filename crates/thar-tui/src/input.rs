//! Event mapping: crossterm keys and mouse events to [`Command`]s.
//!
//! CP6 is read-only. The list keymap is the Ink app's (`components/TodoList.tsx`)
//! minus every command that needs a modal or a write: those keys are mapped to
//! [`Command::Rejected`] so the press is acknowledged with one bounded toast
//! instead of being silently ignored. Navigation, search, the hidden-view
//! toggle and scrolling are fully functional.
//!
//! The mapping is a pure function of the key plus focus state, and [`apply`] is
//! a pure state transition over [`App`], so unit tests drive both without a
//! terminal.

use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

use crate::app::App;
use crate::layout::checkbox_columns;
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
    SearchHome,
    /// Move the query cursor to the end.
    SearchEnd,
    /// Move the todo cursor up one row.
    Up,
    /// Move the todo cursor down one row.
    Down,
    /// Move to the previous context group.
    ContextUp,
    /// Move to the next context group.
    ContextDown,
    /// Move five rows up.
    PageUp,
    /// Move five rows down.
    PageDown,
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
    /// A command CP6 does not support; the payload is the toast to show.
    Rejected(&'static str),
}

/// Translate a key press into a command.
///
/// `search_focused` is the only piece of context the keymap needs: the search
/// bar owns printable input and the cursor-editing keys, while the list owns
/// the rest.
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

fn search_key(key: KeyEvent) -> Option<Command> {
    let shift = key.modifiers.contains(KeyModifiers::SHIFT);
    match key.code {
        KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => Some(Command::Quit),
        KeyCode::Char(ch) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
            Some(Command::SearchInsert(ch))
        }
        KeyCode::Backspace => Some(Command::SearchBackspace),
        KeyCode::Delete => Some(Command::SearchDelete),
        KeyCode::Left => Some(Command::SearchLeft),
        KeyCode::Right => Some(Command::SearchRight),
        KeyCode::Home => Some(Command::SearchHome),
        KeyCode::End => Some(Command::SearchEnd),
        KeyCode::Enter => Some(Command::SearchBlur),
        KeyCode::Esc => Some(Command::SearchClear),
        KeyCode::Up if shift => Some(Command::ExtendUp),
        KeyCode::Down if shift => Some(Command::ExtendDown),
        KeyCode::Up => Some(Command::Up),
        KeyCode::Down => Some(Command::Down),
        KeyCode::PageUp => Some(Command::PageUp),
        KeyCode::PageDown => Some(Command::PageDown),
        _ => None,
    }
}

fn list_key(key: KeyEvent) -> Option<Command> {
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    let shift = key.modifiers.contains(KeyModifiers::SHIFT);

    match key.code {
        KeyCode::Up if ctrl && shift => Some(Command::Rejected(READ_ONLY_MESSAGE)),
        KeyCode::Down if ctrl && shift => Some(Command::Rejected(READ_ONLY_MESSAGE)),
        KeyCode::Up if ctrl => Some(Command::ContextUp),
        KeyCode::Down if ctrl => Some(Command::ContextDown),
        KeyCode::Up if shift => Some(Command::ExtendUp),
        KeyCode::Down if shift => Some(Command::ExtendDown),
        KeyCode::Up => Some(Command::Up),
        KeyCode::Down => Some(Command::Down),
        KeyCode::PageUp => Some(Command::PageUp),
        KeyCode::PageDown => Some(Command::PageDown),
        KeyCode::Home => Some(Command::Home),
        KeyCode::End => Some(Command::End),
        KeyCode::Esc => Some(Command::ClearRange),
        KeyCode::Char('/') => Some(Command::SearchFocus),
        KeyCode::Char('q') => Some(Command::Quit),
        KeyCode::Char('H') => Some(Command::ToggleHiddenView),
        // The rest of the list keymap either opens a modal or writes.
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
        | KeyCode::Char('A'..='Z')
        | KeyCode::Delete
        | KeyCode::Enter => Some(Command::Rejected(READ_ONLY_MESSAGE)),
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
#[derive(Clone, Copy, Debug)]
pub struct LastClick {
    /// Clicked todo id.
    pub todo_id: thar_core::TodoId,
    /// 1-based column.
    pub x: u16,
    /// 1-based row.
    pub y: u16,
    /// Arrival time.
    pub at: std::time::Instant,
}

/// Apply a mouse event, returning the click to remember for double-click
/// detection (or `None` when the event was not a row click).
pub fn handle_mouse(
    app: &mut App,
    mouse: MouseInput,
    last_click: Option<LastClick>,
    now: std::time::Instant,
) -> (Option<LastClick>, Option<Command>) {
    match mouse.kind {
        MouseKind::WheelUp => {
            nav::scroll(app, -1);
            (last_click, None)
        }
        MouseKind::WheelDown => {
            nav::scroll(app, 1);
            (last_click, None)
        }
        MouseKind::Move => (last_click, None),
        MouseKind::LeftClick => {
            let Some(relative) = app.layout().row_at(mouse.y.saturating_sub(1)) else {
                return (last_click, None);
            };
            let row = app.offset + relative;
            let Some(entry) = app.rows().get(row) else {
                return (last_click, None);
            };
            let Some(todo_index) = entry.todo_index() else {
                return (last_click, None);
            };
            let Some(id) = app.todo_at(todo_index).map(|todo| todo.id) else {
                return (last_click, None);
            };

            nav::select_row(app, row, mouse.shift);

            let double = last_click.is_some_and(|previous| {
                (previous.todo_id == id || (previous.x == mouse.x && previous.y == mouse.y))
                    && now.saturating_duration_since(previous.at) <= DOUBLE_CLICK_WINDOW
            });
            // The list is read-only: a double-click on the checkbox or the
            // text acknowledges the edit intent without writing.
            let command = double.then_some(Command::Rejected(READ_ONLY_MESSAGE));

            (
                Some(LastClick {
                    todo_id: id,
                    x: mouse.x,
                    y: mouse.y,
                    at: now,
                }),
                command,
            )
        }
    }
}

/// Apply one command to the app state.
pub fn apply(app: &mut App, command: Command) {
    match command {
        Command::Quit => app.should_quit = true,
        Command::SearchFocus => app.search_focused = true,
        Command::SearchBlur => app.search_focused = false,
        Command::SearchClear => {
            app.search_focused = false;
            app.set_query("");
        }
        Command::SearchInsert(ch) => insert_query_char(app, ch),
        Command::SearchBackspace => {
            let cursor = app.query_cursor.min(app.query.chars().count());
            if cursor > 0 {
                let mut chars: Vec<char> = app.query.chars().collect();
                chars.remove(cursor - 1);
                app.query = chars.into_iter().collect();
                app.query_cursor = cursor - 1;
                app.rebuild_list();
            }
        }
        Command::SearchDelete => {
            let cursor = app.query_cursor.min(app.query.chars().count());
            let mut chars: Vec<char> = app.query.chars().collect();
            if cursor < chars.len() {
                chars.remove(cursor);
                app.query = chars.into_iter().collect();
                app.rebuild_list();
            }
        }
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
        Command::PageUp => nav::move_cursor(app, -5, false),
        Command::PageDown => nav::move_cursor(app, 5, false),
        Command::Home => nav::select_first(app),
        Command::End => nav::select_last(app),
        Command::ScrollUp => nav::scroll(app, -1),
        Command::ScrollDown => nav::scroll(app, 1),
        Command::ToggleHiddenView => app.toggle_hidden_view(),
        Command::ClearRange => nav::clear_range(app),
        Command::ExtendUp => nav::move_cursor(app, -1, true),
        Command::ExtendDown => nav::move_cursor(app, 1, true),
        Command::Rejected(message) => app.push_toast(message),
    }
}

/// Is the cursor column on the checkbox of a todo row?
///
/// Used by the double-click path; exported so the mouse tests can pin the same
/// column window the renderer draws.
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
    app.rebuild_list();
}

#[cfg(test)]
mod tests {
    use super::{
        Command, MouseInput, MouseKind, READ_ONLY_MESSAGE, apply, command_for_key, handle_mouse,
    };
    use crate::app::App;
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
}
