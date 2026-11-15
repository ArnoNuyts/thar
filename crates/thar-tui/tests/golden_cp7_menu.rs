//! Golden `TestBackend` frames for the CP7 menus, confirmations and update
//! screen.
//!
//! The frames pin the parts a PTY assertion cannot: the exact row order of the
//! two menu tables, the marker column, the centred button labels, the update
//! content rows and the modal geometry at the two terminal sizes the plan
//! names (80×24 and 100×30). Colours are asserted where they carry meaning
//! (the selected marker and the primary shortcut colour).
//!
//! The modal is drawn over the list, so every assertion reads the modal
//! rectangle resolved by `thar_tui::modal::geometry`, not a hard-coded row.

use ratatui::Terminal;
use ratatui::backend::TestBackend;
use ratatui::style::Color;
use thar_core::{Todo, TodoDate, TodoId};
use thar_tui::modal::geometry;
use thar_tui::{App, ConfirmRequest, InstallKind, UpdateModel, view};

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
    app.read_only = false;
    app
}

fn draw(app: &App, width: u16, height: u16) -> TestBackend {
    let mut terminal = Terminal::new(TestBackend::new(width, height)).expect("test terminal");
    terminal
        .draw(|frame| view::render(frame, app))
        .expect("draw succeeds");
    terminal.backend().clone()
}

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

/// The active modal's resolved rectangle.
fn modal_area(app: &App) -> geometry::ModalRect {
    let modal = app.modals.top().expect("an active modal");
    geometry::resolve(
        ratatui::layout::Rect::new(0, 0, app.width, app.height),
        modal.width(),
        modal.body_rows(),
    )
}

/// One body row of the active modal, with the border/padding columns removed.
fn body_row(app: &App, backend: &TestBackend, row: u16) -> String {
    let rect = modal_area(app);
    let lines = screen_lines(backend);
    let y = usize::from(rect.body.y + row);
    let line: Vec<char> = lines[y].chars().collect();
    let start = usize::from(rect.body.x + 2);
    let width = usize::from(rect.body.width.saturating_sub(4));
    line.into_iter()
        .skip(start)
        .take(width)
        .collect::<String>()
        .trim_end()
        .to_owned()
}

fn cell(backend: &TestBackend, x: u16, y: u16) -> (String, Option<Color>) {
    let cell = &backend.buffer()[(x, y)];
    (cell.symbol().to_owned(), cell.style().fg)
}

#[test]
fn eighty_by_twenty_four_pins_the_single_todo_menu() {
    let mut app = app(&["one", "two"]);
    app.resize(80, 24);
    app.open_modal(thar_tui::ModalId::TodoMenu);
    let backend = draw(&app, 80, 24);
    let rect = modal_area(&app);
    assert_eq!((rect.area.x, rect.area.y), (20, 2));
    assert_eq!((rect.area.width, rect.area.height), (40, 21));
    assert_eq!((rect.body.x, rect.body.y), (21, 5));

    let screen = screen_lines(&backend);
    assert!(screen[2].contains("Todo menu"), "{screen:#?}");

    let rows: Vec<String> = (0..16).map(|row| body_row(&app, &backend, row)).collect();
    assert!(rows[0].starts_with("» Edit"), "{rows:#?}");
    assert!(rows[0].ends_with('e'));
    assert!(rows[1].starts_with("  Delete"));
    assert!(rows[1].ends_with("del"));
    assert!(rows[2].starts_with("  Toggle Complete"));
    assert!(rows[2].ends_with("space"));
    assert!(rows[10].starts_with("  Show/Hide Hidden"));
    assert!(rows[10].ends_with('H'));
    assert!(rows[15].starts_with("  Paste"));
    assert!(rows[15].ends_with('v'));

    // The marker is the secondary colour and the shortcut the primary one.
    let (marker, marker_colour) = cell(&backend, rect.body.x + 2, rect.body.y);
    assert_eq!(marker, "»");
    assert_eq!(marker_colour, Some(Color::Rgb(0xAF, 0x76, 0xB7)));
    let shortcut_x = rect.body.x + rect.body.width - 3;
    let (shortcut, shortcut_colour) = cell(&backend, shortcut_x, rect.body.y);
    assert_eq!(shortcut, "e");
    assert_eq!(shortcut_colour, Some(Color::Rgb(0xF4, 0xBF, 0x75)));

    // Down moves the marker to Delete without changing the labels.
    let mut app = app;
    app.handle_modal_key(ratatui::crossterm::event::KeyEvent::new(
        ratatui::crossterm::event::KeyCode::Down,
        ratatui::crossterm::event::KeyModifiers::NONE,
    ));
    let backend = draw(&app, 80, 24);
    assert!(body_row(&app, &backend, 0).starts_with("  Edit"));
    assert!(body_row(&app, &backend, 1).starts_with("» Delete"));
}

#[test]
fn one_hundred_by_thirty_pins_the_multi_select_menu() {
    let mut app = app(&["one", "two", "three"]);
    app.resize(100, 30);
    app.range = vec![app.todos[0].id, app.todos[1].id];
    app.open_modal(thar_tui::ModalId::MultiSelectMenu);
    let backend = draw(&app, 100, 30);
    let rect = modal_area(&app);
    assert_eq!((rect.area.x, rect.area.y), (25, 8));
    assert_eq!((rect.area.width, rect.area.height), (50, 15));

    let screen = screen_lines(&backend);
    assert!(screen[8].contains("Multi-select menu"), "{screen:#?}");

    let rows: Vec<String> = (0..10).map(|row| body_row(&app, &backend, row)).collect();
    assert_eq!(
        rows.iter()
            .map(|row| row
                .trim_start_matches("» ")
                .trim_start_matches("  ")
                .split_whitespace()
                .next()
                .unwrap_or(""))
            .collect::<Vec<_>>(),
        [
            "Delete", "Toggle", "Set", "Set", "Set", "Set", "Modify", "Modify", "Toggle", "Copy",
        ]
    );
    assert!(rows[0].starts_with("» Delete"));
    assert!(rows[9].starts_with("  Copy"));

    let screen = screen.join("\n");
    for absent in ["Edit", "Archive Completed", "Undo", "Redo", "Paste"] {
        assert!(
            !rows.iter().any(|row| row.contains(absent)),
            "{absent} must not be in the multi-select menu"
        );
    }
    assert!(screen.contains("Multi-select menu"));
}

#[test]
fn one_hundred_by_thirty_pins_the_archive_confirmation() {
    let mut app = app(&["x 2026-11-01 done", "open"]);
    app.resize(100, 30);
    app.apply_action(thar_tui::Action::Confirm(ConfirmRequest::archive()));
    let backend = draw(&app, 100, 30);
    let rect = modal_area(&app);
    assert_eq!((rect.area.x, rect.area.y), (25, 11));
    assert_eq!((rect.area.width, rect.area.height), (50, 8));
    assert_eq!(rect.body.height, 3);

    let screen = screen_lines(&backend);
    assert!(screen[11].contains("Archive Completed"), "{screen:#?}");
    assert!(
        screen
            .iter()
            .any(|line| line.contains("Archive all completed todos to done.txt?"))
    );
    let buttons = screen
        .iter()
        .find(|line| line.contains('«'))
        .expect("a button row");
    assert!(buttons.contains("« Confirm »"), "{buttons:?}");
    assert!(buttons.contains("‹ Cancel ›"), "{buttons:?}");
}

#[test]
fn eighty_by_twenty_four_pins_the_delete_confirmation() {
    let mut app = app(&["one", "two"]);
    app.resize(80, 24);
    let ids = vec![app.todos[0].id, app.todos[1].id];
    app.apply_action(thar_tui::Action::Confirm(ConfirmRequest::delete(ids)));
    let backend = draw(&app, 80, 24);
    let screen = screen_lines(&backend);

    assert!(
        screen.iter().any(|line| line.contains("Delete Todos")),
        "{screen:#?}"
    );
    // The message is longer than the 36 content columns, so it wraps.
    assert!(screen.iter().any(|line| line.contains("Are you sure")));
    assert!(screen.iter().any(|line| line.contains("delete 2")));
    assert!(screen.iter().any(|line| line.contains("todos?")));
    assert!(
        screen
            .iter()
            .any(|line| line.contains("« Confirm »") && line.contains("‹ Cancel ›")),
        "{screen:#?}"
    );
}

#[test]
fn one_hundred_by_thirty_pins_the_update_screen() {
    let mut app = app(&["one"]);
    app.resize(100, 30);
    app.update_model = Some(UpdateModel {
        current_version: "0.4.0".to_owned(),
        latest_version: Some("0.5.0".to_owned()),
        install_kind: InstallKind::NpmGlobal,
        command: "npm install -g @arnoarnoarno/thar@latest".to_owned(),
        release_url: "https://github.com/ArnoNuyts/thar/releases/tag/v0.5.0".to_owned(),
        can_self_update: true,
    });
    app.open_modal(thar_tui::ModalId::Update);
    let backend = draw(&app, 100, 30);
    let rect = modal_area(&app);
    assert_eq!((rect.area.width, rect.area.x), (70, 15));

    let screen = screen_lines(&backend);
    assert!(screen[rect.area.y as usize].contains("Update available"));
    assert!(
        screen
            .iter()
            .any(|line| line.contains("Current: v0.4.0  →  Latest: v0.5.0"))
    );
    assert!(
        screen
            .iter()
            .any(|line| line.contains("Install method: npm (global)"))
    );
    assert!(
        screen
            .iter()
            .any(|line| line.contains("Command: npm install -g @arnoarnoarno/thar@latest"))
    );
    assert!(screen.iter().any(|line| line.contains("Release notes:")));
    assert!(
        screen
            .iter()
            .any(|line| line.contains("https://github.com/ArnoNuyts/thar/releases/tag/v0.5.0"))
    );
    let buttons = screen
        .iter()
        .find(|line| line.contains('«'))
        .expect("a button row");
    assert!(buttons.contains("« Update now »"), "{buttons:?}");
    assert!(buttons.contains("‹ Later ›"), "{buttons:?}");
    assert!(buttons.contains("‹ Skip this version ›"), "{buttons:?}");
}

#[test]
fn the_update_screen_hides_update_now_for_ephemeral_installs() {
    let mut app = app(&["one"]);
    app.resize(100, 30);
    app.update_model = Some(UpdateModel {
        install_kind: InstallKind::Npx,
        command: "npx @arnoarnoarno/thar@latest".to_owned(),
        can_self_update: false,
        ..UpdateModel::default()
    });
    app.open_modal(thar_tui::ModalId::Update);
    let backend = draw(&app, 100, 30);
    let screen = screen_lines(&backend).join("\n");
    assert!(screen.contains("Install method: npx (ephemeral)"));
    assert!(!screen.contains("Update now"), "{screen}");
    assert!(screen.contains("« Later »"));
    assert!(screen.contains("‹ Skip this version ›"));
}
