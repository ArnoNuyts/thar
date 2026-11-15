//! Golden frames for the read-only TUI.
//!
//! CP6's rendering is pinned the same way the Ink app's snapshots would be:
//! a fixed todo list, a fixed size and a fixed day, then the exact cell
//! contents (not ANSI strings, so colour capability cannot break the test).
//!
//! Two sizes are covered because the Ink layout has two states that matter:
//! 80×24 is the old default terminal, and 120×40 is the plan's benchmark size
//! with a scrollable list. Style assertions live next to the text ones so a
//! colour regression on the focused row, a context header or the scrollbar is
//! caught even when the characters stay the same.

use ratatui::Terminal;
use ratatui::backend::TestBackend;
use ratatui::style::{Color, Modifier};
use thar_core::{Todo, TodoDate, TodoId};
use thar_tui::{App, view};

/// Parse a fixture with load-order ids.
fn app(lines: &[&str]) -> App {
    let todos = lines
        .iter()
        .enumerate()
        .map(|(index, line)| Todo::parse_line(line, TodoId::new(index as u64)))
        .collect();
    App::new(
        "todo.txt",
        todos,
        TodoDate::parse("2026-11-15").expect("valid date"),
    )
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

fn fixture() -> App {
    app(&[
        "x (A) 2026-11-01 archived release notes @work +thar",
        "(B) fix the parser @home due:2026-11-10",
        "read the plan +thar",
        "hidden note h:1",
        "later task t:2026-12-01",
        "plain follow-up",
    ])
}

/// The action-bar row with the read-only badge right-aligned.
fn action_bar(width: usize) -> String {
    let left = " x Menu   q Quit   n New   e Edit   / Search  ";
    let indicator = "READ-ONLY ";
    format!(
        "{left}{}READ-ONLY",
        " ".repeat(width - left.len() - indicator.len())
    )
}

#[test]
fn eighty_by_twenty_four_matches_the_ink_layout() {
    let mut app = fixture();
    app.resize(80, 24);
    let backend = draw(&app, 80, 24);

    let mut expected: Vec<String> = [
        "  None (2)",
        " 1 [ ] read the plan +thar",
        " 2 [ ] plain follow-up",
        "  home (1)",
        " 3 [ ] (B) fix the parser @home due:2026-11-10",
        "  work (1)",
        " 4 [x] (A) archived release notes @work +thar",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();
    expected.extend(core::iter::repeat_n(String::new(), 15));
    expected.push("─".repeat(80));
    expected.push(action_bar(80));
    assert_eq!(screen_lines(&backend), expected);

    // The cursor starts on the first todo row and the number is dimmed.
    let buffer = backend.buffer();
    let focused = &buffer[(7, 1)];
    assert_eq!(focused.symbol(), "r");
    assert_eq!(focused.style().bg, Some(Color::Rgb(0xEC, 0xEC, 0xEC)));
    assert_eq!(focused.style().fg, Some(Color::Rgb(0x18, 0x18, 0x18)));

    let number = &buffer[(1, 1)];
    assert_eq!(number.symbol(), "1");
    assert!(number.style().add_modifier.contains(Modifier::DIM));
    assert_eq!(number.style().bg, Some(Color::Rgb(0xEC, 0xEC, 0xEC)));

    // The context header keeps the primary background across its label.
    let header = &buffer[(2, 0)];
    assert_eq!(header.symbol(), "N");
    assert_eq!(header.style().bg, Some(Color::Rgb(0xF4, 0xBF, 0x75)));
    assert_eq!(header.style().fg, Some(Color::Rgb(0x14, 0x12, 0x10)));

    // `@home` is the context colour, `due:` the danger colour.
    let context = &buffer[(26, 4)];
    assert_eq!(context.symbol(), "@");
    assert_eq!(context.style().fg, Some(Color::Rgb(0xF4, 0xBF, 0x75)));

    let due = &buffer[(32, 4)];
    assert_eq!(due.symbol(), "d");
    assert_eq!(due.style().fg, Some(Color::Rgb(0xCE, 0x77, 0x68)));

    // The +project token is the project colour on a row that is not
    // highlighted (`+thar` after `@work` on the completed row).
    let project = &buffer[(40, 6)];
    assert_eq!(project.symbol(), "+");
    assert_eq!(project.style().fg, Some(Color::Rgb(0x63, 0x99, 0xC6)));

    // Highlighted tokens use one foreground, even when they would otherwise
    // be coloured: the first todo row owns the cursor.
    let highlighted_project = &buffer[(21, 1)];
    assert_eq!(highlighted_project.symbol(), "+");
    assert_eq!(
        highlighted_project.style().fg,
        Some(Color::Rgb(0x18, 0x18, 0x18))
    );
}

#[test]
fn one_hundred_and_twenty_by_forty_scrolls_with_a_track() {
    let todos: Vec<String> = (1..=50).map(|index| format!("todo {index:02}")).collect();
    let todos: Vec<&str> = todos.iter().map(String::as_str).collect();
    let mut app = app(&todos);
    app.resize(120, 40);
    // The `None` header plus fifty todo rows is 51 rows for a 38-row list, so
    // the last frame starts at row 13: the header has scrolled out of view.
    thar_tui::nav::select_last(&mut app);
    let backend = draw(&app, 120, 40);

    let screen = screen_lines(&backend);
    assert_eq!(screen[0], " 13 [ ] todo 13");
    assert_eq!(
        screen[37],
        format!(" 50 [ ] todo 50{}│", " ".repeat(119 - 15))
    );
    assert_eq!(screen[38], "─".repeat(120));
    assert_eq!(screen[39], action_bar(120));

    let buffer = backend.buffer();
    // The scrollbar column is always the last one. The handle is 28 rows tall
    // (floor(38² / 51)) and starts at row 10 because the offset is at its end.
    let track_top = &buffer[(119, 0)];
    assert_eq!(track_top.symbol(), " ");
    assert_eq!(track_top.style().fg, Some(Color::Rgb(0x67, 0x65, 0x60)));
    let handle_top = &buffer[(119, 10)];
    assert_eq!(handle_top.symbol(), "│");
    let handle_bottom = &buffer[(119, 37)];
    assert_eq!(handle_bottom.symbol(), "│");
}

#[test]
fn the_hidden_indicator_and_hidden_rows_share_the_same_view() {
    let mut app = fixture();
    app.resize(80, 24);
    app.toggle_hidden_view();
    let backend = draw(&app, 80, 24);
    let screen = screen_lines(&backend);

    assert_eq!(
        screen[0],
        format!(
            "  None (4){}[HIDDEN TODOS VISIBLE]",
            " ".repeat(80 - 10 - "[HIDDEN TODOS VISIBLE]".len())
        )
    );
    assert!(screen.iter().any(|line| line.contains("hidden note")));
    assert!(screen.iter().any(|line| line.contains("later task")));
}

#[test]
fn the_search_bar_owns_the_first_two_rows() {
    let mut app = fixture();
    app.resize(80, 24);
    app.search_focused = true;
    app.set_query("plan");
    let backend = draw(&app, 80, 24);
    let screen = screen_lines(&backend);

    assert_eq!(screen[0], " / plan  /");
    assert_eq!(screen[1], "─".repeat(80));
    assert_eq!(screen[2], "  None (1)");
    assert_eq!(screen[3], " 1 [ ] read the plan +thar");
    // The cursor is the inverse cell after the query.
    let cursor = &backend.buffer()[(7, 0)];
    assert_eq!(cursor.symbol(), " ");
    assert!(cursor.style().add_modifier.contains(Modifier::REVERSED));
}
