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
        "2026-11-15".parse::<TodoDate>().expect("valid date"),
    );
    // The write badge keeps the frame identical to a `--write` session.
    app.set_read_only(false);
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
        thar_tui::input::handle_key(
            app,
            KeyEvent::new(KeyCode::Char(character), KeyModifiers::NONE),
            current_time(),
        );
    }
}

fn current_time() -> std::time::Instant {
    std::time::Instant::now()
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
        " 4 [ ] write the port @work +thar",
        "",
        "",
        "                     ┃ Create new todo",
        "                     ┃",
        "                     ┃ » buy oat milk +th",
        "                     ┃              ┌───────────┐",
        "                     ┃     « Save » │ +thar     │cel ›",
        "                     ┃              │ +thar-tui │",
        "                                    └───────────┘",
        "",
        "",
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

    // The modal chrome is the Ink one: a primary accent bar, a primary title
    // chip with inverse text, and a #262626 body on the #181818 list.
    let buffer = backend.buffer();
    let title_bar = &buffer[(21, 9)];
    assert_eq!(title_bar.symbol(), "┃");
    assert_eq!(title_bar.style().fg, Some(Color::Rgb(0xF4, 0xBF, 0x75)));
    let chip_pad = &buffer[(22, 9)];
    assert_eq!(chip_pad.style().bg, Some(Color::Rgb(0xF4, 0xBF, 0x75)));
    let chip = &buffer[(23, 9)];
    assert_eq!(chip.symbol(), "C");
    assert_eq!(chip.style().fg, Some(Color::Rgb(0x14, 0x12, 0x10)));
    assert_eq!(chip.style().bg, Some(Color::Rgb(0xF4, 0xBF, 0x75)));
    let outer = &buffer[(20, 9)];
    assert_eq!(outer.style().bg, Some(Color::Rgb(0x18, 0x18, 0x18)));
    let pad = &buffer[(22, 11)];
    assert_eq!(pad.style().bg, Some(Color::Rgb(0x26, 0x26, 0x26)));
    let body_bar = &buffer[(21, 11)];
    assert_eq!(body_bar.symbol(), "┃");
    assert_eq!(body_bar.style().fg, Some(Color::Rgb(0xF4, 0xBF, 0x75)));
    // The old full-border frame is gone: the outer padding columns stay blank
    // on every modal row, even where the popup and buttons use box glyphs.
    let screen = screen_lines(&backend);
    for (y, line) in screen.iter().enumerate().skip(8).take(8) {
        let cells: Vec<char> = line.chars().collect();
        assert_eq!(
            cells.get(20).copied().unwrap_or(' '),
            ' ',
            "outer padding at row {y}"
        );
        if cells.len() > 59 {
            assert!(
                !matches!(cells[59], '│' | '┌' | '┐' | '└' | '┘'),
                "right padding at row {y}: {line:?}"
            );
        }
    }

    // The popup is content-sized and anchored under the typed `+`: the box is
    // 13 cells wide (8-char name + prefix/space/borders), at columns 36..48.
    assert_eq!(screen_lines(&backend)[12].chars().nth(36), Some('┌'));
    assert_eq!(screen_lines(&backend)[12].chars().nth(48), Some('┐'));

    // The cursor is the cell after the last typed character, inverse video.
    let cursor = &buffer[(41, 11)];
    assert_eq!(cursor.symbol(), " ");
    assert!(cursor.modifier.contains(Modifier::REVERSED));

    // The first suggestion row is selected: inverse background, accent
    // foreground, and the prefix inherits the row colour.
    let selected = &buffer[(37, 13)];
    assert_eq!(selected.symbol(), " ");
    assert_eq!(selected.style().bg, Some(Color::Rgb(0xEC, 0xEC, 0xEC)));
    let project = &buffer[(38, 13)];
    assert_eq!(project.symbol(), "+");
    assert_eq!(project.style().fg, Some(Color::Rgb(0x63, 0x99, 0xC6)));

    // The popup prefix sits on the same column as the typed marker.
    let typed_marker = &buffer[(38, 11)];
    assert_eq!(typed_marker.symbol(), "+");

    // A second frame without a tag keeps the modal at the same place and the
    // Save/Cancel row visible; the popup no longer changes the modal height.
    let mut plain = make_app(FIXTURE, "");
    plain.resize(80, 24);
    plain.open_modal(ModalId::CreateTodo);
    type_text(&mut plain, "buy oat milk");
    let plain = draw(&plain, 80, 24);
    let buffer = plain.buffer();
    // The selected button is the shared `« Save »` row: foreground text on
    // the modal surface, bold, with the muted `‹ Cancel ›` beside it.
    let save = &buffer[(29, 13)];
    assert_eq!(save.symbol(), "S");
    assert_eq!(save.style().bg, Some(Color::Rgb(0x26, 0x26, 0x26)));
    assert_eq!(save.style().fg, Some(Color::Rgb(0xEE, 0xEC, 0xE5)));
    assert!(save.style().add_modifier.contains(Modifier::BOLD));
    let cancel = &buffer[(46, 13)];
    assert_eq!(cancel.symbol(), "C");
    assert_eq!(cancel.style().bg, Some(Color::Rgb(0x26, 0x26, 0x26)));
    assert_eq!(cancel.style().fg, Some(Color::Rgb(0x67, 0x65, 0x60)));
    assert!(!cancel.style().add_modifier.contains(Modifier::BOLD));
}

#[test]
fn eighty_by_twenty_four_create_modal_prefills_tags_from_the_search() {
    let mut app = app(FIXTURE, "@work");
    app.resize(80, 24);
    app.open_modal(ModalId::CreateTodo);
    let backend = draw(&app, 80, 24);

    let expected: Vec<String> = [
        " / @work                                                                       /",
        "────────────────────────────────────────────────────────────────────────────────",
        "  work (1)",
        " 1 [ ] write the port @work +thar",
        "",
        "",
        "",
        "",
        "",
        "                     ┃ Create new todo",
        "                     ┃",
        "                     ┃ »  @work",
        "                     ┃",
        "                     ┃     « Save »         ‹ Cancel ›",
        "                     ┃",
        "",
        "",
        "",
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
    let cursor = &backend.buffer()[(25, 11)];
    assert_eq!(cursor.symbol(), " ");
    assert!(cursor.modifier.contains(Modifier::REVERSED));
}

#[test]
fn a_hundred_by_thirty_edit_modal_starts_at_the_text_end() {
    let mut app = app(FIXTURE, "");
    app.resize(100, 30);
    app.set_cursor(Some(app.todos()[1].id));
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
        "",
        "",
        "",
        "                          ┃ Edit todo",
        "                          ┃",
        "                          ┃ » write the port @work +thar",
        "                          ┃",
        "                          ┃        « Save »             ‹ Cancel ›",
        "                          ┃",
        "",
        "",
        "",
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
    let cursor = &backend.buffer()[(56, 14)];
    assert_eq!(cursor.symbol(), " ");
    assert!(cursor.modifier.contains(Modifier::REVERSED));
}

#[test]
fn eighty_by_twenty_four_search_popup_is_content_sized_and_anchored() {
    let mut app = app(FIXTURE, "");
    app.resize(80, 24);
    app.set_search_focused(true);
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
