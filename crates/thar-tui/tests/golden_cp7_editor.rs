//! Golden frames for the CP7 create/edit screens.
//!
//! The frames are drawn with `TestBackend` at the two sizes the plan cares
//! about (80×24 and 100×30) and compared cell-for-cell, the same way
//! `tests/golden.rs` pins CP6's list. Style assertions sit next to the text
//! ones so the inverse cursor cell, the highlighted suggestion and the
//! selected button cannot regress while the characters stay the same.
//!
//! The fixture is parsed through `thar_core`, so the list behind the modal is
//! the real CP6 frame: the modal only owns its own rectangle.

use ratatui::Terminal;
use ratatui::backend::TestBackend;
use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::style::{Color, Modifier};
use thar_core::{Todo, TodoDate, TodoId};
use thar_tui::{App, ModalId, view};

const FIXTURE: &[&str] = &[
    "buy milk @home",
    "write the port @work +thar",
    "read the plan +thar-tui",
    "water the plants",
];

fn app(lines: &[&str], query: &str) -> App {
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
    // The write badge keeps the frame identical to a `--write` session.
    app.read_only = false;
    app.set_query(query);
    app
}

fn draw(app: &App, width: u16, height: u16) -> TestBackend {
    let mut terminal = Terminal::new(TestBackend::new(width, height)).expect("test terminal");
    terminal
        .draw(|frame| view::render(frame, app))
        .expect("draw succeeds");
    terminal.backend().clone()
}

/// The screen as trimmed lines, so trailing background cells do not hide a
/// (missing) row.
fn screen_lines(backend: &TestBackend) -> Vec<String> {
    let buffer = backend.buffer();
    (0..buffer.area.height)
        .map(|y| {
            (0..buffer.area.width)
                .map(|x| buffer[(x, y)].symbol())
                .collect::<String>()
                .trim_end()
                .to_owned()
        })
        .collect()
}

fn type_text(app: &mut App, text: &str) {
    for character in text.chars() {
        app.handle_modal_key(KeyEvent::new(KeyCode::Char(character), KeyModifiers::NONE));
    }
}

#[test]
fn eighty_by_twenty_four_create_modal_pins_input_suggestions_and_buttons() {
    let make_app = app;
    let mut app = make_app(FIXTURE, "");
    app.resize(80, 24);
    app.open_modal(ModalId::CreateTodo);
    type_text(&mut app, "buy oat milk +th");
    let backend = draw(&app, 80, 24);

    let expected: Vec<String> = [
        "  None (2)",
        " 1 [ ] read the plan +thar-tui",
        " 2 [ ] water the plants",
        "  home (1)",
        " 3 [ ] buy milk @home",
        "  work (1)",
        " 4 [ ] write the por┌───────────Create new todo────────────┐",
        "                    │                                      │",
        "                    │                                      │",
        "                    │ » buy oat milk +th                   │",
        "                    │              ┌───────────┐           │",
        "                    │         ┌────│ +thar     │─┐         │",
        "                    │         │ Sav│ +thar-tui │ │         │",
        "                    │         └────└───────────┘─┘         │",
        "                    │                                      │",
        "                    │ Tab/Shift+Tab = toggle action, Enter │",
        "                    │                                      │",
        "                    └──────────────────────────────────────┘",
        "",
        "",
        "",
        "",
        "────────────────────────────────────────────────────────────────────────────────",
        " x Menu   q Quit   n New   e Edit   / Search                              WRITE",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();

    assert_eq!(screen_lines(&backend), expected);

    // The popup is content-sized and anchored under the typed `+`: the box is
    // 13 cells wide (8-char name + prefix/space/borders), at columns 35..47.
    assert_eq!(screen_lines(&backend)[10].chars().nth(35), Some('┌'));
    assert_eq!(screen_lines(&backend)[10].chars().nth(47), Some('┐'));

    let buffer = backend.buffer();

    // The cursor is the cell after the last typed character, inverse video.
    let cursor = &buffer[(40, 9)];
    assert_eq!(cursor.symbol(), " ");
    assert!(cursor.modifier.contains(Modifier::REVERSED));

    // The first suggestion row is selected: inverse background, accent
    // foreground, and the prefix inherits the row colour.
    let selected = &buffer[(36, 11)];
    assert_eq!(selected.symbol(), " ");
    assert_eq!(selected.style().bg, Some(Color::Rgb(0xEC, 0xEC, 0xEC)));
    let project = &buffer[(37, 11)];
    assert_eq!(project.symbol(), "+");
    assert_eq!(project.style().fg, Some(Color::Rgb(0x63, 0x99, 0xC6)));

    // The popup prefix sits on the same column as the typed marker.
    let typed_marker = &buffer[(37, 9)];
    assert_eq!(typed_marker.symbol(), "+");

    // A second frame without a tag keeps the modal at the same place and the
    // Save/Cancel row visible; the popup no longer changes the modal height.
    let mut plain = make_app(FIXTURE, "");
    plain.resize(80, 24);
    plain.open_modal(ModalId::CreateTodo);
    type_text(&mut plain, "buy oat milk");
    let plain = draw(&plain, 80, 24);
    let buffer = plain.buffer();
    let save = &buffer[(32, 12)];
    assert_eq!(save.symbol(), "S");
    assert_eq!(save.style().bg, Some(Color::Rgb(0x7B, 0xA1, 0x52)));
    assert!(save.style().add_modifier.contains(Modifier::BOLD));
    let cancel = &buffer[(42, 12)];
    assert_eq!(cancel.symbol(), "C");
    assert_eq!(cancel.style().bg, Some(Color::Rgb(0x20, 0x20, 0x20)));
    assert_eq!(cancel.style().fg, Some(Color::Rgb(0x67, 0x65, 0x60)));
}

#[test]
fn eighty_by_twenty_four_create_modal_prefills_tags_from_the_search() {
    let mut app = app(FIXTURE, "@work");
    app.resize(80, 24);
    app.open_modal(ModalId::CreateTodo);
    let backend = draw(&app, 80, 24);

    let expected: Vec<String> = [
        " / @work /",
        "────────────────────────────────────────────────────────────────────────────────",
        "  work (1)",
        " 1 [ ] write the port @work +thar",
        "",
        "",
        "                    ┌───────────Create new todo────────────┐",
        "                    │                                      │",
        "                    │                                      │",
        "                    │ »  @work                             │",
        "                    │                                      │",
        "                    │         ┌──────┐  ┌────────┐         │",
        "                    │         │ Save │  │ Cancel │         │",
        "                    │         └──────┘  └────────┘         │",
        "                    │                                      │",
        "                    │ Tab/Shift+Tab = toggle action, Enter │",
        "                    │                                      │",
        "                    └──────────────────────────────────────┘",
        "",
        "",
        "",
        "",
        "────────────────────────────────────────────────────────────────────────────────",
        " x Menu   q Quit   n New   e Edit   / Search                              WRITE",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();

    assert_eq!(screen_lines(&backend), expected);

    // The cursor sits at offset 0, in front of the prefilled token.
    let cursor = &backend.buffer()[(24, 9)];
    assert_eq!(cursor.symbol(), " ");
    assert!(cursor.modifier.contains(Modifier::REVERSED));
}

#[test]
fn a_hundred_by_thirty_edit_modal_starts_at_the_text_end() {
    let mut app = app(FIXTURE, "");
    app.resize(100, 30);
    app.cursor = Some(app.todos[1].id);
    app.open_modal(ModalId::EditTodo);
    let backend = draw(&app, 100, 30);

    let expected: Vec<String> = [
        "  None (2)",
        " 1 [ ] read the plan +thar-tui",
        " 2 [ ] water the plants",
        "  home (1)",
        " 3 [ ] buy milk @home",
        "  work (1)",
        " 4 [ ] write the port @work +thar",
        "",
        "",
        "                         ┌───────────────────Edit todo────────────────────┐",
        "                         │                                                │",
        "                         │                                                │",
        "                         │ » write the port @work +thar                   │",
        "                         │                                                │",
        "                         │              ┌──────┐  ┌────────┐              │",
        "                         │              │ Save │  │ Cancel │              │",
        "                         │              └──────┘  └────────┘              │",
        "                         │                                                │",
        "                         │ Tab/Shift+Tab = toggle action, Enter = selecte │",
        "                         │                                                │",
        "                         └────────────────────────────────────────────────┘",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "────────────────────────────────────────────────────────────────────────────────────────────────────",
        " x Menu   q Quit   n New   e Edit   / Search                                                  WRITE",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();

    assert_eq!(screen_lines(&backend), expected);

    // The cursor is one cell past the 26-character text.
    let cursor = &backend.buffer()[(55, 12)];
    assert_eq!(cursor.symbol(), " ");
    assert!(cursor.modifier.contains(Modifier::REVERSED));
}

#[test]
fn eighty_by_twenty_four_search_popup_is_content_sized_and_anchored() {
    let mut app = app(FIXTURE, "");
    app.resize(80, 24);
    app.search_focused = true;
    app.set_query("+th");
    let backend = draw(&app, 80, 24);
    let screen = screen_lines(&backend);

    // The search prompt is " / " (3 cells), so the marker at column 0 anchors
    // the popup at column 1. The box is 13 wide for the 8-char longest name.
    assert!(screen[0].contains(" / +th"), "{screen:#?}");
    assert_eq!(screen[1].chars().nth(1), Some('┌'));
    assert_eq!(screen[1].chars().nth(13), Some('┐'));
    assert!(screen[2].contains("+thar"), "{screen:#?}");
    assert!(screen[3].contains("+thar-tui"), "{screen:#?}");
}
