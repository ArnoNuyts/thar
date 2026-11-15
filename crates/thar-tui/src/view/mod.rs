//! Rendering for the read-only TUI.
//!
//! The view is a pure function of [`App`]: no widget keeps state between
//! frames, and only the visible row slice is turned into lines. The layout is
//! resolved once per frame by [`crate::layout::Layout`], the same geometry the
//! mouse hit-test uses.
//!
//! The styling mirrors the Ink components (`TodoList.tsx`, `ActionBar.tsx`,
//! `SearchInput.tsx`, `HiddenIndicator.tsx`, `TodoListScrollbar.tsx`) so a
//! future side-by-side comparison is meaningful:
//!
//! - a todo row is `" " + padded number (dim) + " " + checkbox + " " +
//!   priority + text + suffixes`, with `@context`/`+project` tokens coloured
//!   separately;
//! - the focused row uses the overdue focus colour when the todo is overdue,
//!   and a shift-selection range uses the selection colour;
//! - context headers are rows and keep the primary background;
//! - the scrollbar takes a column only while the list is scrollable;
//! - the action bar puts the read-only badge before the toast and bounds the
//!   toast to the space the action items leave.
//!
//! Every string that comes from the file goes through
//! [`crate::display::sanitize_for_display`] before it reaches the terminal.

mod overlay;
mod scrollbar;

use ratatui::Frame;
use ratatui::layout::{Alignment, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph};
use thar_core::Todo;

use crate::app::App;
use crate::display::sanitize_for_display;
use crate::layout::{ACTION_ITEMS, Layout, action_item_width};
use crate::list::ListRow;
use crate::theme;

/// Label on the action bar's status side while the binary cannot write.
const READ_ONLY_LABEL: &str = "READ-ONLY";
/// Label on the action bar's status side when `--write` is active.
const WRITE_LABEL: &str = "WRITE";

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

    overlay::render(frame, app);
}

fn render_search(frame: &mut Frame, app: &App, layout: Layout) {
    let row = Rect::new(0, layout.search_row(), layout.width, 1);
    let prompt = Style::default().fg(if app.search_focused {
        theme::SECONDARY
    } else {
        theme::MUTED
    });
    let query = Style::default().fg(theme::FOREGROUND);

    let safe = sanitize_for_display(&app.query);
    let chars: Vec<char> = safe.chars().collect();
    let cursor = app.query_cursor.min(chars.len());

    let mut spans = vec![Span::styled(" / ", prompt)];
    if app.search_focused {
        let before: String = chars[..cursor].iter().collect();
        let after: String = chars[cursor.saturating_add(1).min(chars.len())..]
            .iter()
            .collect();
        let at = chars.get(cursor).copied().unwrap_or(' ');
        spans.push(Span::styled(before, query));
        spans.push(Span::styled(
            at.to_string(),
            query.add_modifier(Modifier::REVERSED),
        ));
        spans.push(Span::styled(after, query));
    } else {
        spans.push(Span::styled(safe, query));
    }
    spans.push(Span::styled(" / ", prompt));

    frame.render_widget(Paragraph::new(Line::from(spans)), row);

    let border = Rect::new(0, layout.search_border_row(), layout.width, 1);
    frame.render_widget(
        Block::default()
            .borders(Borders::BOTTOM)
            .border_style(Style::default().fg(theme::MUTED)),
        border,
    );
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

    let track = scrollbar::geometry(app.rows().len(), layout.list_height as usize, app.offset);
    let content_width = if track.is_some() {
        layout.list_width
    } else {
        layout.width
    };
    let max_digits = app.max_todo_number_digits();

    for (index, row) in rows.iter().enumerate() {
        let y = layout
            .list_top
            .saturating_add(u16::try_from(index).unwrap_or(u16::MAX));
        if y >= layout.action_top {
            break;
        }

        let area = Rect::new(0, y, content_width, 1);
        match row {
            ListRow::Context { name, todo_count } => {
                let label = format!("  {} ({todo_count})  ", sanitize_for_display(name));
                frame.render_widget(
                    Paragraph::new(Span::styled(
                        label,
                        Style::default()
                            .bg(theme::PRIMARY)
                            .fg(theme::INVERSE_FOREGROUND),
                    )),
                    area,
                );
            }
            ListRow::Todo { todo_index, number } => {
                if let Some(todo) = app.todo_at(*todo_index) {
                    let (line, style) = todo_line(app, todo, *number, max_digits);
                    frame.render_widget(Paragraph::new(line).style(style), area);
                }
            }
        }
    }

    if let Some(track) = track {
        scrollbar::render(frame, &track, layout.scrollbar_x, layout.list_top);
    }
}

fn todo_line(app: &App, todo: &Todo, number: usize, max_digits: usize) -> (Line<'static>, Style) {
    let focused = app.cursor == Some(todo.id);
    let in_range = app.is_selected_in_range(todo.id);
    let highlighted = focused || in_range;
    let overdue = todo.is_overdue(app.today);

    let background = if focused {
        if overdue {
            theme::FOCUS_BACKGROUND_OVERDUE
        } else {
            theme::FOCUS_BACKGROUND
        }
    } else if in_range {
        theme::SELECTION_BACKGROUND
    } else {
        theme::BACKGROUND
    };
    let text_color = if highlighted {
        theme::TEXT_ON_HIGHLIGHT
    } else if overdue {
        theme::DANGER
    } else {
        theme::FOREGROUND
    };
    let base = Style::default().fg(text_color).bg(background);

    let mut spans = vec![
        Span::styled(
            format!(" {number:>max_digits$} "),
            base.add_modifier(Modifier::DIM),
        ),
        Span::styled(if todo.is_done() { "[x] " } else { "[ ] " }, base),
    ];

    if let Some(priority) = todo.priority {
        let color = if highlighted {
            theme::TEXT_ON_HIGHLIGHT
        } else {
            theme::priority_color(priority.as_char()).unwrap_or(theme::FOREGROUND)
        };
        spans.push(Span::styled(
            format!("({}) ", priority.as_char()),
            base.fg(color),
        ));
    }

    spans.extend(text_spans(&todo.text, base, highlighted));

    for (key, color) in [
        ("due", theme::DANGER),
        ("t", theme::SUCCESS),
        ("rec", theme::INFO),
    ] {
        if let Some(value) = todo.tag(key) {
            let joined = value.values().collect::<Vec<_>>().join(",");
            let label = sanitize_for_display(&format!(" {key}:{joined}"));
            spans.push(Span::styled(
                label,
                base.fg(if highlighted {
                    theme::TEXT_ON_HIGHLIGHT
                } else {
                    color
                }),
            ));
        }
    }

    (Line::from(spans), base)
}

/// Split a todo body into plain, `@context` and `+project` spans.
///
/// The token rule is the Ink list's `/(@[^ ]+|\+[^ ]+)/g`: a token starts at
/// `@`/`+` and runs to the next space. A lone marker is plain text, because the
/// regex requires at least one character after it.
fn text_spans(text: &str, base: Style, highlighted: bool) -> Vec<Span<'static>> {
    let safe = sanitize_for_display(text);
    let mut spans = Vec::new();
    let mut rest = safe.as_str();

    while let Some(position) = rest.find(['@', '+']) {
        let (before, tail) = rest.split_at(position);
        if !before.is_empty() {
            spans.push(Span::styled(before.to_owned(), base));
        }

        let end = tail.find(' ').unwrap_or(tail.len());
        let (token, after) = tail.split_at(end);
        if token.len() == 1 {
            spans.push(Span::styled(token.to_owned(), base));
        } else {
            let color = if highlighted {
                theme::TEXT_ON_HIGHLIGHT
            } else if token.starts_with('@') {
                theme::TAG_CONTEXT
            } else {
                theme::TAG_PROJECT
            };
            spans.push(Span::styled(token.to_owned(), base.fg(color)));
        }
        rest = after;
    }

    if !rest.is_empty() {
        spans.push(Span::styled(rest.to_owned(), base));
    }

    spans
}

fn render_empty_state(frame: &mut Frame, app: &App, layout: Layout) {
    let area = Rect::new(0, layout.list_top, layout.width, layout.list_height);
    let query = app.query.trim();

    let lines = if query.is_empty() {
        if let Some(error) = app.load_error.as_deref() {
            // There is no list to explain the failure next to, so the empty
            // state owns the bounded read error instead of the welcome quote.
            vec![
                Line::from(Span::styled(
                    sanitize_for_display(error),
                    Style::default().fg(theme::DANGER),
                )),
                Line::from(""),
                Line::from(Span::styled(
                    if app.read_only {
                        "The read-only build does not create todo files."
                    } else {
                        "Fix the todo file to resume saving."
                    },
                    Style::default()
                        .fg(theme::MUTED)
                        .add_modifier(Modifier::DIM),
                )),
            ]
        } else {
            vec![
                Line::from("I love deadlines. I love the whooshing noise they make as they go by."),
                Line::from(Span::styled(
                    "- Douglas Adams",
                    Style::default().fg(theme::MUTED),
                )),
                Line::from(""),
                Line::from(Span::styled(
                    "Read-only build: creating and editing are not available.",
                    Style::default()
                        .fg(theme::MUTED)
                        .add_modifier(Modifier::DIM),
                )),
            ]
        }
    } else {
        vec![
            Line::from(vec![
                Span::raw("No results found for '"),
                Span::styled(
                    sanitize_for_display(query),
                    Style::default().fg(theme::WARNING),
                ),
                Span::raw("'"),
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

    let line_count = lines.len();
    frame.render_widget(
        Paragraph::new(lines)
            .alignment(Alignment::Center)
            .style(Style::default().fg(theme::FOREGROUND).bg(theme::BACKGROUND)),
        centred_vertically(area, line_count),
    );
}

fn render_action_bar(frame: &mut Frame, app: &App, layout: Layout) {
    let border = Rect::new(0, layout.action_top, layout.width, 1);
    frame.render_widget(
        Block::default()
            .borders(Borders::TOP)
            .border_style(Style::default().fg(theme::MUTED)),
        border,
    );

    let row = Rect::new(0, layout.action_row(), layout.width, 1);
    let action_width: u16 = ACTION_ITEMS
        .iter()
        .map(|(key, label)| action_item_width(key, label))
        .sum();

    let mut spans = Vec::new();
    for (key, label) in ACTION_ITEMS {
        spans.push(Span::styled(
            format!(" {key}"),
            Style::default().fg(theme::PRIMARY),
        ));
        spans.push(Span::raw(format!(" {label}  ")));
    }

    let (indicator, indicator_color) = if app.writable() {
        (WRITE_LABEL, theme::SUCCESS)
    } else {
        // A write session whose last reload failed shows READ-ONLY until the
        // file is readable again, matching the Ink app's recovery state. The
        // `--write` flag itself is unchanged, so the list still accepts
        // in-memory edits without saving them.
        (READ_ONLY_LABEL, theme::DANGER)
    };
    let indicator_width = indicator.chars().count() + 1;
    let right_limit = usize::from(layout.width.saturating_sub(action_width).saturating_sub(1));
    let status_limit = right_limit.saturating_sub(indicator_width);
    let toast = app.toast_message(std::time::Instant::now());
    // With no rows the empty state carries the load error in full; the action
    // bar only repeats it when there is a list that lost its refresh.
    let load_error = app.load_error.as_deref().filter(|_| !app.rows().is_empty());
    let message = toast
        .or(load_error)
        .or(app.save_error.as_deref())
        .map(|text| bound(sanitize_for_display(text), status_limit));

    let mut right = Vec::new();
    let mut right_width = 0;
    right.push(Span::styled(
        format!("{indicator} "),
        Style::default().fg(indicator_color),
    ));
    right_width += indicator_width;
    if let Some(message) = message.filter(|text| !text.is_empty()) {
        right_width += message.chars().count();
        let color = if toast.is_some() {
            theme::SECONDARY
        } else {
            theme::DANGER
        };
        right.push(Span::styled(message, Style::default().fg(color)));
    }

    if right_width > 0 {
        let left_width = usize::from(action_width);
        let padding = usize::from(layout.width).saturating_sub(left_width + right_width);
        if padding > 0 {
            spans.push(Span::raw(" ".repeat(padding)));
        }
        spans.extend(right);
    }

    frame.render_widget(Paragraph::new(Line::from(spans)), row);
}

/// Trim a display message to at most `limit` characters.
fn bound(text: String, limit: usize) -> String {
    text.chars().take(limit).collect()
}

fn render_hidden_indicator(frame: &mut Frame, layout: Layout) {
    let label = "[HIDDEN TODOS VISIBLE]";
    let width = u16::try_from(label.chars().count()).unwrap_or(layout.width);
    let x = layout.width.saturating_sub(width);
    let area = Rect::new(x, 0, width.min(layout.width), 1);
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
fn centred_vertically(area: Rect, lines: usize) -> Rect {
    let height = u16::try_from(lines).unwrap_or(area.height).min(area.height);
    let y = area
        .y
        .saturating_add(area.height.saturating_sub(height) / 2);
    Rect::new(area.x, y, area.width, height)
}

#[cfg(test)]
mod tests {
    use super::{bound, render, text_spans};
    use crate::app::App;
    use crate::theme;
    use ratatui::Terminal;
    use ratatui::backend::TestBackend;
    use ratatui::style::{Color, Modifier, Style};
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

    fn screen(app: &App, width: u16, height: u16) -> String {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).expect("test terminal");
        terminal
            .draw(|frame| render(frame, app))
            .expect("draw succeeds");
        let buffer = terminal.backend().buffer();
        (0..buffer.area.height)
            .map(|y| {
                (0..buffer.area.width)
                    .map(|x| buffer[(x, y)].symbol())
                    .collect::<String>()
                    .trim_end()
                    .to_owned()
                    + "\n"
            })
            .collect()
    }

    #[test]
    fn renders_rows_and_chrome_without_panicking() {
        let mut app = app(&["one @home", "x 2026-11-01 two"]);
        app.resize(80, 10);
        let screen = screen(&app, 80, 10);
        assert!(screen.contains("home"));
        assert!(screen.contains("one @home"));
        assert!(screen.contains("Quit"));
        assert!(screen.contains("READ-ONLY"));
    }

    #[test]
    fn search_empty_state_quotes_the_query() {
        let mut app = app(&["one"]);
        app.resize(40, 10);
        app.search_focused = true;
        app.set_query("nope");
        let screen = screen(&app, 40, 10);
        assert!(screen.contains("No results found for 'nope'"));
    }

    #[test]
    fn tokens_keep_plain_text_and_colour_contexts_and_projects() {
        let base = Style::default().fg(theme::FOREGROUND);
        let spans = text_spans("ship @home +thar now", base, false);
        let rendered: Vec<(String, Option<Color>)> = spans
            .iter()
            .map(|span| (span.content.to_string(), span.style.fg))
            .collect();
        assert_eq!(
            rendered,
            [
                ("ship ".to_owned(), Some(theme::FOREGROUND)),
                ("@home".to_owned(), Some(theme::TAG_CONTEXT)),
                (" ".to_owned(), Some(theme::FOREGROUND)),
                ("+thar".to_owned(), Some(theme::TAG_PROJECT)),
                (" now".to_owned(), Some(theme::FOREGROUND)),
            ]
        );
    }

    #[test]
    fn a_lone_marker_is_not_a_token() {
        let base = Style::default();
        let spans = text_spans("@ home", base, false);
        assert_eq!(
            spans
                .iter()
                .map(|span| span.content.as_ref())
                .collect::<Vec<_>>(),
            ["@", " home"]
        );
    }

    #[test]
    fn highlighted_rows_use_one_foreground() {
        let base = Style::default().fg(theme::TEXT_ON_HIGHLIGHT);
        let spans = text_spans("@home +thar", base, true);
        assert!(
            spans
                .iter()
                .all(|span| span.style.fg == Some(theme::TEXT_ON_HIGHLIGHT))
        );
    }

    #[test]
    fn the_number_is_dimmed() {
        let mut app = app(&["one"]);
        app.resize(40, 10);
        let mut terminal = Terminal::new(TestBackend::new(40, 10)).expect("test terminal");
        terminal
            .draw(|frame| render(frame, &app))
            .expect("draw succeeds");
        let cell = terminal.backend().buffer()[(1, 1)].clone();
        assert_eq!(cell.symbol(), "1");
        assert!(cell.modifier.contains(Modifier::DIM));
    }

    #[test]
    fn a_long_list_draws_a_scrollbar_and_a_short_one_does_not() {
        let lines: Vec<String> = (1..=30).map(|index| format!("todo {index}")).collect();
        let lines: Vec<&str> = lines.iter().map(String::as_str).collect();
        let mut long_app = app(&lines);
        long_app.resize(20, 10);
        let long = screen(&long_app, 20, 10);
        assert!(long.lines().any(|line| line.ends_with('│')));

        let mut short_app = app(&["one", "two"]);
        short_app.resize(20, 10);
        let short = screen(&short_app, 20, 10);
        assert!(!short.contains('│'));
    }

    #[test]
    fn the_read_only_badge_precedes_the_toast() {
        let mut app = app(&["one"]);
        app.resize(100, 10);
        app.push_toast("Hidden todos shown");
        let screen = screen(&app, 100, 10);
        let bar = screen.lines().last().expect("action bar");
        assert!(bar.contains("READ-ONLY Hidden todos shown"));
    }

    #[test]
    fn messages_are_bounded_by_character_count() {
        assert_eq!(bound("abcdef".to_owned(), 3), "abc");
        assert_eq!(bound("abc".to_owned(), 10), "abc");
        assert_eq!(bound("abc".to_owned(), 0), "");
    }

    #[test]
    fn a_load_error_is_shown_in_the_empty_state() {
        let mut app = app(&[]);
        app.resize(80, 10);
        app.load_error = Some("todo.txt not found".to_owned());
        let screen = screen(&app, 80, 10);
        assert!(screen.contains("todo.txt not found"));
        assert!(screen.contains("does not create todo files"));
    }
}
