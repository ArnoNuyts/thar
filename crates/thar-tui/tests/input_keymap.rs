//! Table-driven keymap parity for the list and the search bar.
//!
//! There is one keymap ([`command_for_key`]) and one read-only gate. The
//! table asserts the same physical keys against a read-only app and a
//! write-enabled app: non-mutating commands map identically, mutating commands
//! become one bounded rejection in read-only mode and their real command in
//! write mode.

use std::time::Instant;

use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use thar_core::{Todo, TodoDate, TodoId};
use thar_tui::App;
use thar_tui::input::{self, Command, NO_UPDATE_MESSAGE, READ_ONLY_MESSAGE, command_for_key};
use thar_tui::modal::{ModalId, UpdateModel};

const NONE: KeyModifiers = KeyModifiers::NONE;
const SHIFT: KeyModifiers = KeyModifiers::SHIFT;
const CTRL: KeyModifiers = KeyModifiers::CONTROL;

fn current_time() -> Instant {
    Instant::now()
}

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
        "2026-11-15".parse::<TodoDate>().expect("valid date"),
    );
    app.resize(80, 10);
    app
}

fn writable_app(lines: &[&str]) -> App {
    let mut app = app(lines);
    app.set_read_only(false);
    app
}

fn rejected() -> Option<Command> {
    Some(Command::Toast(READ_ONLY_MESSAGE))
}

#[test]
fn non_mutating_list_keys_map_identically_in_both_modes() {
    let cases = [
        (KeyCode::Up, NONE, Command::Up),
        (KeyCode::Down, NONE, Command::Down),
        (KeyCode::Up, SHIFT, Command::ExtendUp),
        (KeyCode::Down, SHIFT, Command::ExtendDown),
        (KeyCode::Up, CTRL, Command::ContextUp),
        (KeyCode::Down, CTRL, Command::ContextDown),
        (KeyCode::Up, CTRL | SHIFT, Command::ExtendContextUp),
        (KeyCode::Down, CTRL | SHIFT, Command::ExtendContextDown),
        (KeyCode::PageUp, NONE, Command::PageUp),
        (KeyCode::PageDown, NONE, Command::PageDown),
        (KeyCode::PageUp, SHIFT, Command::ExtendPageUp),
        (KeyCode::PageDown, SHIFT, Command::ExtendPageDown),
        (KeyCode::Home, NONE, Command::Home),
        (KeyCode::End, NONE, Command::End),
        (KeyCode::Esc, NONE, Command::ClearRange),
        (KeyCode::Char('/'), NONE, Command::SearchFocus),
        (KeyCode::Char('q'), NONE, Command::Quit),
        (KeyCode::Char('H'), SHIFT, Command::ToggleHiddenView),
    ];

    let read_only = app(&["one"]);
    let writable = writable_app(&["one"]);
    for (code, modifiers, expected) in cases {
        assert_eq!(
            command_for_key(&read_only, key(code, modifiers)),
            Some(expected),
            "{code:?} with {modifiers:?} in read-only mode"
        );
        assert_eq!(
            command_for_key(&writable, key(code, modifiers)),
            Some(expected),
            "{code:?} with {modifiers:?} in write mode"
        );
    }
}

#[test]
fn mutating_list_keys_are_rejected_only_in_read_only_mode() {
    let cases = [
        (KeyCode::Char(' '), Command::Toggle),
        (KeyCode::Char('h'), Command::ToggleHidden),
        (KeyCode::Char('z'), Command::Undo),
        (KeyCode::Char('Z'), Command::Redo),
        (KeyCode::Char('n'), Command::Open(ModalId::CreateTodo)),
        (KeyCode::Char('e'), Command::Open(ModalId::EditTodo)),
        (KeyCode::Char('x'), Command::Open(ModalId::TodoMenu)),
        (KeyCode::Char('d'), Command::Open(ModalId::SetDueDate)),
        (KeyCode::Char('t'), Command::Open(ModalId::SetThresholdDate)),
        (KeyCode::Char('r'), Command::Open(ModalId::SetRecurrence)),
        (KeyCode::Char('+'), Command::Open(ModalId::AddProject)),
        (KeyCode::Char('@'), Command::Open(ModalId::AddContext)),
        (KeyCode::Enter, Command::Open(ModalId::TodoMenu)),
        (KeyCode::Char('a'), Command::Archive),
        (KeyCode::Char('v'), Command::Paste),
        (KeyCode::Delete, Command::DeleteSelected),
        (
            KeyCode::Char('F'),
            Command::SetPriority(Some(thar_core::Priority::new('F').expect("valid"))),
        ),
    ];

    let read_only = app(&["one"]);
    let writable = writable_app(&["one"]);
    for (code, expected) in cases {
        assert_eq!(
            command_for_key(&read_only, key(code, NONE)),
            rejected(),
            "{code:?} must be rejected by the one gate"
        );
        assert_eq!(
            command_for_key(&writable, key(code, NONE)),
            Some(expected),
            "{code:?} must reach its command in write mode"
        );
    }
}

#[test]
fn copy_and_update_are_available_read_only() {
    let mut read_only = app(&["one"]);
    assert_eq!(
        command_for_key(&read_only, key(KeyCode::Char('c'), NONE)),
        Some(Command::CopySelected)
    );
    assert_eq!(
        command_for_key(&read_only, key(KeyCode::Char('u'), NONE)),
        Some(Command::Toast(NO_UPDATE_MESSAGE))
    );

    read_only.set_update_model(Some(UpdateModel::default()));
    assert_eq!(
        command_for_key(&read_only, key(KeyCode::Char('u'), NONE)),
        Some(Command::Open(ModalId::Update))
    );
}

#[test]
fn unmapped_list_keys_are_silent_in_both_modes() {
    for code in [
        KeyCode::Tab,
        KeyCode::BackTab,
        KeyCode::Insert,
        KeyCode::F(1),
        KeyCode::Char('b'),
        KeyCode::Char('g'),
        // Only A-F are priority keys; Ink ignores the rest of the alphabet.
        KeyCode::Char('Q'),
        KeyCode::Char('R'),
    ] {
        assert_eq!(
            command_for_key(&app(&["one"]), key(code, NONE)),
            None,
            "{code:?} should not be a list command"
        );
        assert_eq!(
            command_for_key(&writable_app(&["one"]), key(code, NONE)),
            None,
            "{code:?} should not be a list command"
        );
    }
}

#[test]
fn search_keymap_is_table_driven() {
    let cases = [
        (KeyCode::Char('a'), NONE, Command::SearchInsert('a')),
        (KeyCode::Char('A'), SHIFT, Command::SearchInsert('A')),
        (KeyCode::Char(' '), NONE, Command::SearchInsert(' ')),
        (KeyCode::Char('q'), NONE, Command::SearchInsert('q')),
        (KeyCode::Char('/'), NONE, Command::SearchInsert('/')),
        (KeyCode::Backspace, NONE, Command::SearchBackspace),
        (KeyCode::Delete, NONE, Command::SearchDelete),
        (KeyCode::Left, NONE, Command::SearchLeft),
        (KeyCode::Right, NONE, Command::SearchRight),
        (KeyCode::Up, NONE, Command::Up),
        (KeyCode::Down, NONE, Command::Down),
        (KeyCode::Up, SHIFT, Command::ExtendUp),
        (KeyCode::Down, SHIFT, Command::ExtendDown),
        (KeyCode::PageUp, NONE, Command::PageUp),
        (KeyCode::PageDown, NONE, Command::PageDown),
        (KeyCode::PageUp, SHIFT, Command::ExtendPageUp),
        (KeyCode::PageDown, SHIFT, Command::ExtendPageDown),
        (KeyCode::Home, NONE, Command::Home),
        (KeyCode::End, NONE, Command::End),
        (KeyCode::Enter, NONE, Command::SearchBlur),
        (KeyCode::Esc, NONE, Command::SearchClear),
    ];

    let mut read_only = app(&["one"]);
    read_only.set_search_focused(true);
    let mut writable = writable_app(&["one"]);
    writable.set_search_focused(true);
    for (code, modifiers, expected) in cases {
        for app in [&read_only, &writable] {
            assert_eq!(
                command_for_key(app, key(code, modifiers)),
                Some(expected),
                "{code:?} with {modifiers:?} in search"
            );
        }
    }
}

#[test]
fn ctrl_c_quits_in_every_mode() {
    for search_focused in [false, true] {
        let mut read_only = app(&["one"]);
        read_only.set_search_focused(search_focused);
        assert_eq!(
            command_for_key(&read_only, key(KeyCode::Char('c'), CTRL)),
            Some(Command::Quit),
            "ctrl-c with search_focused = {search_focused}"
        );
    }
    // Lower-case c without Ctrl copies in the list (non-mutating, so allowed
    // read-only) and is a query character in search.
    assert_eq!(
        command_for_key(&app(&["one"]), key(KeyCode::Char('c'), NONE)),
        Some(Command::CopySelected)
    );
    let mut search = app(&["one"]);
    search.set_search_focused(true);
    assert_eq!(
        command_for_key(&search, key(KeyCode::Char('c'), NONE)),
        Some(Command::SearchInsert('c'))
    );
}

#[test]
fn a_rejection_shows_one_bounded_toast() {
    let mut app = app(&["write the docs"]);
    let command =
        command_for_key(&app, key(KeyCode::Char('x'), NONE)).expect("the gate produces one");
    input::apply(&mut app, command, current_time());

    let now = current_time();
    assert_eq!(app.toast_message(now), Some(READ_ONLY_MESSAGE));
    assert!(READ_ONLY_MESSAGE.len() <= 80);
    // The toast never quotes todo content.
    assert!(!READ_ONLY_MESSAGE.contains("write the docs"));

    // Rejections never move the cursor or change the query.
    assert_eq!(app.cursor(), Some(TodoId::new(0)));
    assert_eq!(app.search().query(), "");
}

#[test]
fn search_typing_edits_while_mutating_list_keys_stay_search_input() {
    let mut app = app(&["one", "two"]);

    input::apply(&mut app, Command::SearchFocus, current_time());
    for ch in "one".chars() {
        input::apply(&mut app, Command::SearchInsert(ch), current_time());
    }
    assert_eq!(app.search().query(), "one");
    assert_eq!(app.rows().iter().filter(|row| row.is_todo()).count(), 1);
    // None of those characters produced a read-only toast.
    assert_eq!(app.toast_message(current_time()), None);
}

#[test]
fn a_multi_character_paste_keeps_its_order_at_the_cursor() {
    let mut app = app(&["write docs one", "read docs two", "buy milk"]);
    input::apply(&mut app, Command::SearchFocus, current_time());

    // At the end: "docs" must stay "docs", not reverse to "scod".
    input::insert_query_text(&mut app, "docs");
    assert_eq!(app.search().query(), "docs");
    assert_eq!(app.search().cursor(), 4);
    assert_eq!(
        app.rows().iter().filter(|row| row.is_todo()).count(),
        2,
        "the filter must see the pasted text in order"
    );

    // Mid-query: splicing at the caret must keep the pasted run intact and
    // push the suffix right.
    app.set_query("abef");
    input::apply(&mut app, Command::SearchLeft, current_time());
    input::apply(&mut app, Command::SearchLeft, current_time());
    assert_eq!(app.search().cursor(), 2);
    input::insert_query_text(&mut app, "cd");
    assert_eq!(app.search().query(), "abcdef");
    assert_eq!(app.search().cursor(), 4);
}

#[test]
fn search_focus_and_blur_never_reverse_or_drop_the_query() {
    let mut app = app(&["one"]);
    input::apply(&mut app, Command::SearchFocus, current_time());
    input::insert_query_text(&mut app, "abc");
    input::apply(&mut app, Command::SearchBlur, current_time());
    assert_eq!(app.search().query(), "abc");
    assert_eq!(app.search().cursor(), 3);
    input::apply(&mut app, Command::SearchFocus, current_time());
    input::insert_query_text(&mut app, "de");
    assert_eq!(app.search().query(), "abcde");
}
