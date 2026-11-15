//! Rendering for the read-only TUI.
//!
//! The view is a pure function of [`App`]: no widget keeps state between
//! frames, and only the visible row slice is turned into lines. The layout is
//! resolved once per frame by [`crate::layout::Layout`], the same geometry the
//! mouse hit-test uses.
//!
//! This module starts as the CP6 foundation renderer (plain rows and the
//! chrome). The parity pass owns the exact styled spans, centring, and golden
//! snapshots.

use ratatui::Frame;
use ratatui::layout::Alignment;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph};
use thar_core::Todo;

use crate::app::App;
use crate::layout::{Layout, todo_prefix};
use crate::list::ListRow;
use crate::theme;

/// Draw one frame.
pub fn render(frame: &mut Frame, app: &App) {
    let area = frame.area();
    let layout = Layout::new(area.width, area.height, app.search_visible());

    frame.render_widget(
        Block::default().style(Style::default().bg(theme::BACKGROUND)),
        area,
    );

    if layout.search_visible {
        render_search(frame, app, layout);
    }

    render_list(frame, app, layout);
    render_action_bar(frame, app, layout);

    if app.show_hidden {
        render_hidden_indicator(frame, layout);
    }
}

fn render_search(frame: &mut Frame, app: &App, layout: Layout) {
    let row = ratatui::layout::Rect::new(0, layout.search_row(), layout.width, 1);
    let prompt = Style::default().fg(if app.search_focused {
        theme::SECONDARY
    } else {
        theme::MUTED
    });
    let query = Style::default().fg(theme::FOREGROUND);

    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(" / ", prompt),
            Span::styled(app.query.clone(), query),
            Span::styled(" / ", prompt),
        ])),
        row,
    );

    let border = ratatui::layout::Rect::new(0, layout.search_border_row(), layout.width, 1);
    frame.render_widget(
        Block::default()
            .borders(Borders::BOTTOM)
            .border_style(Style::default().fg(theme::MUTED)),
        border,
    );

    if app.search_focused {
        let column = 3_u16.saturating_add(
            u16::try_from(app.query_cursor)
                .unwrap_or(u16::MAX)
                .min(layout.width.saturating_sub(4)),
        );
        frame.set_cursor_position((
            column.min(layout.width.saturating_sub(1)),
            layout.search_row(),
        ));
    }
}

fn render_list(frame: &mut Frame, app: &App, layout: Layout) {
    if layout.list_height == 0 {
        return;
    }

    let rows = app.visible_rows();
    if rows.is_empty() {
        render_empty_state(frame, app, layout);
        return;
    }

    let max_digits = app.max_todo_number_digits();
    let mut lines = Vec::with_capacity(rows.len());
    for row in rows {
        match row {
            ListRow::Context { name, todo_count } => {
                lines.push(Line::from(Span::styled(
                    format!("  {name} ({todo_count})  "),
                    Style::default()
                        .bg(theme::PRIMARY)
                        .fg(theme::INVERSE_FOREGROUND),
                )));
            }
            ListRow::Todo { todo_index, number } => {
                if let Some(todo) = app.todo_at(*todo_index) {
                    lines.push(todo_line(app, todo, *number, max_digits));
                }
            }
        }
    }

    let area = ratatui::layout::Rect::new(
        0,
        layout.list_top,
        layout.width,
        layout
            .list_height
            .min(u16::try_from(lines.len()).unwrap_or(layout.list_height)),
    );
    frame.render_widget(Paragraph::new(lines), area);
}

fn todo_line(app: &App, todo: &Todo, number: usize, max_digits: usize) -> Line<'static> {
    let focused = app.cursor == Some(todo.id);
    let in_range = app.is_selected_in_range(todo.id);
    let overdue = todo.is_overdue(app.today);

    let background = if focused {
        Some(if overdue {
            theme::FOCUS_BACKGROUND_OVERDUE
        } else {
            theme::FOCUS_BACKGROUND
        })
    } else if in_range {
        Some(theme::SELECTION_BACKGROUND)
    } else {
        None
    };
    let foreground = if focused || in_range {
        Some(theme::TEXT_ON_HIGHLIGHT)
    } else if overdue {
        Some(theme::DANGER)
    } else {
        None
    };
    let base = Style::default()
        .fg(foreground.unwrap_or(theme::FOREGROUND))
        .bg(background.unwrap_or(theme::BACKGROUND));

    let prefix = todo_prefix(number, max_digits, todo.is_done());
    let mut spans = vec![
        Span::styled(prefix, base.fg(theme::MUTED)),
        Span::styled(
            todo.priority
                .map(|priority| format!("({}) ", priority.as_char()))
                .unwrap_or_default(),
            base.fg(theme::priority_color(
                todo.priority
                    .map(|priority| priority.as_char())
                    .unwrap_or(' '),
            )
            .unwrap_or(theme::FOREGROUND)),
        ),
        Span::styled(todo.text.clone(), base),
    ];

    for (key, color) in [
        ("due", theme::DANGER),
        ("t", theme::SUCCESS),
        ("rec", theme::INFO),
    ] {
        if let Some(value) = todo.tag(key).and_then(|tag| tag.as_single()) {
            spans.push(Span::styled(format!(" {key}:{value}"), base.fg(color)));
        }
    }

    // Fill the rest of the row so the highlight covers the full width.
    Line::from(spans).style(base)
}

fn render_empty_state(frame: &mut Frame, app: &App, layout: Layout) {
    let area = ratatui::layout::Rect::new(0, layout.list_top, layout.width, layout.list_height);
    let query = app.query.trim();

    let lines = if query.is_empty() {
        vec![
            Line::from("I love deadlines. I love the whooshing noise they make as they go by."),
            Line::from(Span::styled(
                "- Douglas Adams",
                Style::default().fg(theme::MUTED),
            )),
            Line::from(""),
            Line::from(Span::styled(
                "Press 'n' to create a new todo.",
                Style::default()
                    .fg(theme::MUTED)
                    .add_modifier(Modifier::DIM),
            )),
        ]
    } else {
        vec![
            Line::from(vec![
                Span::raw("No results found for "),
                Span::styled(query.to_owned(), Style::default().fg(theme::WARNING)),
            ]),
            Line::from(""),
            Line::from(Span::styled(
                "Try a different search or press Esc to clear.",
                Style::default()
                    .fg(theme::MUTED)
                    .add_modifier(Modifier::DIM),
            )),
        ]
    };

    frame.render_widget(
        Paragraph::new(lines)
            .alignment(Alignment::Center)
            .style(Style::default().fg(theme::FOREGROUND).bg(theme::BACKGROUND)),
        centred_vertically(area, layout.list_height as usize),
    );
}

fn render_action_bar(frame: &mut Frame, app: &App, layout: Layout) {
    let border = ratatui::layout::Rect::new(0, layout.action_top, layout.width, 1);
    frame.render_widget(
        Block::default()
            .borders(Borders::TOP)
            .border_style(Style::default().fg(theme::MUTED)),
        border,
    );

    let row = ratatui::layout::Rect::new(0, layout.action_row(), layout.width, 1);
    let actions = Line::from(vec![
        Span::styled(" x", Style::default().fg(theme::PRIMARY)),
        Span::raw(" Menu  "),
        Span::styled("q", Style::default().fg(theme::PRIMARY)),
        Span::raw(" Quit  "),
        Span::styled("n", Style::default().fg(theme::PRIMARY)),
        Span::raw(" New  "),
        Span::styled("e", Style::default().fg(theme::PRIMARY)),
        Span::raw(" Edit  "),
        Span::styled("/", Style::default().fg(theme::PRIMARY)),
        Span::raw(" Search  "),
    ]);
    frame.render_widget(Paragraph::new(actions), row);

    let mut right = Vec::new();
    if let Some(message) = app.toast_message(std::time::Instant::now()) {
        right.push(Span::styled(
            message.to_owned(),
            Style::default().fg(theme::SECONDARY),
        ));
    }
    if app.read_only {
        right.push(Span::styled(
            "READ-ONLY",
            Style::default().fg(theme::DANGER),
        ));
    }
    if !right.is_empty() {
        frame.render_widget(
            Paragraph::new(Line::from(right)).alignment(Alignment::Right),
            row,
        );
    }
}

fn render_hidden_indicator(frame: &mut Frame, layout: Layout) {
    let label = "[HIDDEN TODOS VISIBLE]";
    let width = u16::try_from(label.chars().count()).unwrap_or(layout.width);
    let x = layout.width.saturating_sub(width);
    let area = ratatui::layout::Rect::new(x, 0, width, 1);
    frame.render_widget(Clear, area);
    frame.render_widget(
        Paragraph::new(Span::styled(
            label,
            Style::default().fg(theme::DANGER).bg(theme::BACKGROUND),
        )),
        area,
    );
}

/// The centred area used by the welcome and no-results screens.
fn centred_vertically(area: ratatui::layout::Rect, lines: usize) -> ratatui::layout::Rect {
    let height = u16::try_from(lines).unwrap_or(area.height).min(area.height);
    let y = area
        .y
        .saturating_add(area.height.saturating_sub(height) / 2);
    ratatui::layout::Rect::new(area.x, y, area.width, height)
}

#[cfg(test)]
mod tests {
    use super::render;
    use crate::app::App;
    use ratatui::Terminal;
    use ratatui::backend::TestBackend;
    use thar_core::{Todo, TodoDate, TodoId};

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

    #[test]
    fn renders_rows_and_chrome_without_panicking() {
        let mut app = app(&["one @home", "x 2026-11-01 two"]);
        app.resize(40, 10);
        let mut terminal = Terminal::new(TestBackend::new(40, 10)).expect("test terminal");
        terminal
            .draw(|frame| render(frame, &app))
            .expect("draw succeeds");

        let buffer = terminal.backend().buffer();
        let screen: String = (0..buffer.area.height)
            .map(|y| {
                (0..buffer.area.width)
                    .map(|x| buffer[(x, y)].symbol())
                    .collect::<String>()
                    + "\n"
            })
            .collect();
        assert!(screen.contains("home"));
        assert!(screen.contains("one @home"));
        assert!(screen.contains("Quit"));
        assert!(screen.contains("READ-ONLY"));
    }

    #[test]
    fn search_empty_state_is_centred_text() {
        let mut app = app(&["one"]);
        app.resize(40, 10);
        app.search_focused = true;
        app.set_query("nope");
        let mut terminal = Terminal::new(TestBackend::new(40, 10)).expect("test terminal");
        terminal
            .draw(|frame| render(frame, &app))
            .expect("draw succeeds");
        let buffer = terminal.backend().buffer();
        let screen: String = (0..buffer.area.height)
            .map(|y| {
                (0..buffer.area.width)
                    .map(|x| buffer[(x, y)].symbol())
                    .collect::<String>()
                    + "\n"
            })
            .collect();
        assert!(screen.contains("No results found for nope"));
    }
}
