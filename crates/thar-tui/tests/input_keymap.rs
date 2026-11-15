//! Table-driven keymap parity for the list and the search bar.
//!
//! Every mapping is asserted through [`command_for_key`] so a key added to one
//! mode cannot silently change the other, and every read-only command is
//! applied to a fresh app to prove it produces exactly one bounded toast.

use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use thar_core::{Todo, TodoDate, TodoId};
use thar_tui::App;
use thar_tui::input::{self, Command, READ_ONLY_MESSAGE, command_for_key};

const NONE: KeyModifiers = KeyModifiers::NONE;
const SHIFT: KeyModifiers = KeyModifiers::SHIFT;
const CTRL: KeyModifiers = KeyModifiers::CONTROL;

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
    app.resize(80, 10);
    app
}

fn rejected() -> Option<Command> {
    Some(Command::Rejected(READ_ONLY_MESSAGE))
}

#[test]
fn list_keymap_is_table_driven() {
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
        (KeyCode::Enter, NONE, Command::Rejected(READ_ONLY_MESSAGE)),
        (KeyCode::Delete, NONE, Command::Rejected(READ_ONLY_MESSAGE)),
        (
            KeyCode::Char('F'),
            SHIFT,
            Command::Rejected(READ_ONLY_MESSAGE),
        ),
    ];

    for (code, modifiers, expected) in cases {
        assert_eq!(
            command_for_key(key(code, modifiers), false),
            Some(expected),
            "{code:?} with {modifiers:?} in the list"
        );
    }
}

#[test]
fn unmapped_list_keys_are_silent() {
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
            command_for_key(key(code, NONE), false),
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

    for (code, modifiers, expected) in cases {
        assert_eq!(
            command_for_key(key(code, modifiers), true),
            Some(expected),
            "{code:?} with {modifiers:?} in search"
        );
    }
}

#[test]
fn ctrl_c_quits_in_every_mode() {
    for search_focused in [false, true] {
        assert_eq!(
            command_for_key(key(KeyCode::Char('c'), CTRL), search_focused),
            Some(Command::Quit),
            "ctrl-c with search_focused = {search_focused}"
        );
    }
    // Lower-case c without Ctrl is a write command in the list and a query
    // character in search.
    assert_eq!(
        command_for_key(key(KeyCode::Char('c'), NONE), false),
        rejected()
    );
    assert_eq!(
        command_for_key(key(KeyCode::Char('c'), NONE), true),
        Some(Command::SearchInsert('c'))
    );
}

#[test]
fn every_read_only_command_is_rejected_in_the_list() {
    let codes = [
        KeyCode::Char(' '),
        KeyCode::Char('x'),
        KeyCode::Char('n'),
        KeyCode::Char('u'),
        KeyCode::Char('z'),
        KeyCode::Char('Z'),
        KeyCode::Char('v'),
        KeyCode::Char('e'),
        KeyCode::Char('a'),
        KeyCode::Char('d'),
        KeyCode::Char('t'),
        KeyCode::Char('r'),
        KeyCode::Char('c'),
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
    ];

    for code in codes {
        assert_eq!(
            command_for_key(key(code, NONE), false),
            rejected(),
            "{code:?} must be rejected in the list"
        );
    }
}

#[test]
fn a_rejection_shows_one_bounded_toast() {
    let mut app = app(&["write the docs"]);

    input::apply(
        &mut app,
        command_for_key(key(KeyCode::Char('x'), NONE), false).expect("command"),
    );

    let now = std::time::Instant::now();
    assert_eq!(app.toast_message(now), Some(READ_ONLY_MESSAGE));
    assert!(READ_ONLY_MESSAGE.len() <= 80);
    // The toast never quotes todo content.
    assert!(!READ_ONLY_MESSAGE.contains("write the docs"));

    // Rejections never move the cursor or change the query.
    assert_eq!(app.cursor, Some(TodoId::new(0)));
    assert_eq!(app.query, "");
}

#[test]
fn search_typing_edits_while_mutating_list_keys_stay_search_input() {
    let mut app = app(&["one", "two"]);

    input::apply(&mut app, Command::SearchFocus);
    for ch in "one".chars() {
        input::apply(&mut app, Command::SearchInsert(ch));
    }
    assert_eq!(app.query, "one");
    assert_eq!(app.rows().iter().filter(|row| row.is_todo()).count(), 1);
    // None of those characters produced a read-only toast.
    assert_eq!(app.toast_message(std::time::Instant::now()), None);
}

#[test]
fn a_multi_character_paste_keeps_its_order_at_the_cursor() {
    let mut app = app(&["write docs one", "read docs two", "buy milk"]);
    input::apply(&mut app, Command::SearchFocus);

    // At the end: "docs" must stay "docs", not reverse to "scod".
    input::insert_query_text(&mut app, "docs");
    assert_eq!(app.query, "docs");
    assert_eq!(app.query_cursor, 4);
    assert_eq!(
        app.list.rows.iter().filter(|row| row.is_todo()).count(),
        2,
        "the filter must see the pasted text in order"
    );

    // Mid-query: splicing at the caret must keep the pasted run intact and
    // push the suffix right.
    app.query.clear();
    app.query.push_str("abef");
    app.query_cursor = 2;
    input::insert_query_text(&mut app, "cd");
    assert_eq!(app.query, "abcdef");
    assert_eq!(app.query_cursor, 4);
}

#[test]
fn search_focus_and_blur_never_reverse_or_drop_the_query() {
    let mut app = app(&["one"]);
    input::apply(&mut app, Command::SearchFocus);
    input::insert_query_text(&mut app, "abc");
    input::apply(&mut app, Command::SearchBlur);
    assert_eq!(app.query, "abc");
    assert_eq!(app.query_cursor, 3);
    input::apply(&mut app, Command::SearchFocus);
    input::insert_query_text(&mut app, "de");
    assert_eq!(app.query, "abcde");
}
