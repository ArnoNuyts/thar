//! The Monday-first month calendar used by the date modal.
//!
//! Behaviour follows `components/Calendar.tsx` exactly:
//!
//! - the grid starts on the Monday of the week containing the first of the
//!   displayed month and runs to the Sunday of the week containing its last
//!   day, so it is four to six rows of seven cells;
//! - Up/Down move one week, Left/Right one day, and Shift/Ctrl+Left/Right one
//!   month;
//! - Enter submits the selected day;
//! - the displayed month follows the selected day whenever it crosses a month
//!   boundary, but a day move inside the month leaves the view alone. The
//!   `synced` field is the value that last moved the view, mirroring the
//!   component's render-time state adjustment.
//!
//! There is no mouse handling, matching the TypeScript calendar. Years outside
//! 1..=9999 cannot be represented by [`TodoDate`], so a navigation key that
//! would leave that range is ignored (the TypeScript component would build an
//! out-of-range `Date` that `isValidTodoDate` later rejects).

use ratatui::Frame;
use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::layout::{Alignment, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use thar_core::{
    TodoDate, add_days, add_months, add_weeks, days_in_month, start_of_month, start_of_week_monday,
    weekday,
};

use crate::theme;

/// Width of one calendar cell in terminal columns.
pub const CELL_WIDTH: u16 = 3;
/// Columns occupied by the whole seven-cell row.
pub const GRID_WIDTH: u16 = CELL_WIDTH * 7;

/// Weekday header labels, Monday first.
pub const WEEKDAY_LABELS: [&str; 7] = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

/// Month names in `MMMM yyyy` title order.
pub const MONTH_NAMES: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];

/// What one key did to the calendar.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CalendarKey {
    /// The key is not a calendar binding.
    Ignored,
    /// The selected day moved.
    Moved,
    /// Enter: submit the selected day.
    Submit,
}

/// Value, viewed month, and the value that last moved the view.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Calendar {
    value: TodoDate,
    view: TodoDate,
    synced: TodoDate,
}

impl Calendar {
    /// Start on `value`, showing its month.
    #[must_use]
    pub fn new(value: TodoDate) -> Self {
        Self {
            value,
            view: start_of_month(value),
            synced: value,
        }
    }

    /// The selected day.
    #[must_use]
    pub const fn value(&self) -> TodoDate {
        self.value
    }

    /// The first day of the displayed month.
    #[must_use]
    pub const fn view(&self) -> TodoDate {
        self.view
    }

    /// Select `value`, moving the displayed month only when it changed.
    ///
    /// This is the component's render-time `isSameMonth(value, syncedValue)`
    /// adjustment: a day move inside the current month must not recentre the
    /// grid, while a move into another month must.
    pub fn set_value(&mut self, value: TodoDate) {
        self.value = value;
        if value.year() != self.synced.year() || value.month() != self.synced.month() {
            self.synced = value;
            self.view = start_of_month(value);
        }
    }

    /// Apply one key press.
    pub fn handle_key(&mut self, key: KeyEvent) -> CalendarKey {
        let shift = key
            .modifiers
            .intersects(KeyModifiers::SHIFT | KeyModifiers::CONTROL);

        let next = match key.code {
            KeyCode::Up => add_weeks(self.value, -1),
            KeyCode::Down => add_weeks(self.value, 1),
            KeyCode::Left if shift => add_months(self.value, -1),
            KeyCode::Left => add_days(self.value, -1),
            KeyCode::Right if shift => add_months(self.value, 1),
            KeyCode::Right => add_days(self.value, 1),
            KeyCode::Enter => return CalendarKey::Submit,
            _ => return CalendarKey::Ignored,
        };

        match next {
            Some(next) => {
                self.set_value(next);
                CalendarKey::Moved
            }
            None => CalendarKey::Ignored,
        }
    }

    /// The month title, e.g. `November 2026`.
    #[must_use]
    pub fn title(&self) -> String {
        format!(
            "{} {:04}",
            MONTH_NAMES[usize::from(self.view.month() - 1)],
            self.view.year()
        )
    }

    /// The grid as whole weeks, Monday first.
    ///
    /// A cell outside years 1..=9999 (only the last week of December 9999) is
    /// `None` and renders blank instead of inventing a day.
    #[must_use]
    pub fn weeks(&self) -> Vec<[Option<TodoDate>; 7]> {
        let month_start = start_of_month(self.view);
        let month_days = usize::from(days_in_month(self.view.year(), self.view.month()));
        let lead = usize::from(weekday(month_start));
        let cells = (lead + month_days).div_ceil(7) * 7;
        let first = start_of_week_monday(month_start);

        let mut weeks = Vec::with_capacity(cells / 7);
        for week in 0..cells / 7 {
            let mut row = [None; 7];
            for (column, cell) in row.iter_mut().enumerate() {
                let offset = i64::try_from(week * 7 + column).unwrap_or(i64::MAX);
                *cell = add_days(first, offset);
            }
            weeks.push(row);
        }
        weeks
    }

    /// Body rows needed by [`render`]: title, weekday header, and the weeks.
    #[must_use]
    pub fn body_rows(&self) -> u16 {
        u16::try_from(2 + self.weeks().len()).unwrap_or(u16::MAX)
    }

    /// True when `date` is in the displayed month.
    #[must_use]
    pub fn is_in_view_month(&self, date: TodoDate) -> bool {
        date.year() == self.view.year() && date.month() == self.view.month()
    }
}

/// Draw the calendar inside `area`.
pub fn render(frame: &mut Frame, area: Rect, calendar: &Calendar) {
    let base = Style::default()
        .fg(theme::FOREGROUND)
        .bg(theme::MODAL_BACKGROUND);

    let title = Rect::new(area.x, area.y, area.width, 1);
    frame.render_widget(
        Paragraph::new(
            Line::from(Span::styled(
                calendar.title(),
                base.add_modifier(Modifier::BOLD),
            ))
            .alignment(Alignment::Center),
        )
        .style(base),
        title,
    );

    let left = area
        .x
        .saturating_add(area.width.saturating_sub(GRID_WIDTH) / 2);
    let grid = |row: u16| Rect::new(left, area.y.saturating_add(row), GRID_WIDTH, 1);

    let header: Vec<Span<'static>> = WEEKDAY_LABELS
        .iter()
        .map(|label| {
            Span::styled(
                format!("{label:<width$}", width = usize::from(CELL_WIDTH)),
                base.fg(theme::MUTED),
            )
        })
        .collect();
    frame.render_widget(Paragraph::new(Line::from(header)).style(base), grid(1));

    for (index, week) in calendar.weeks().iter().enumerate() {
        let row = u16::try_from(index).unwrap_or(u16::MAX).saturating_add(2);
        if area.y.saturating_add(row) >= area.y.saturating_add(area.height) {
            break;
        }

        let spans: Vec<Span<'static>> = week
            .iter()
            .map(|cell| match cell {
                None => Span::styled(" ".repeat(usize::from(CELL_WIDTH)), base),
                Some(date) => {
                    let label = format!("{:>2} ", date.day());
                    if *date == calendar.value {
                        Span::styled(
                            label,
                            Style::default()
                                .fg(theme::INVERSE_FOREGROUND)
                                .bg(theme::SUCCESS),
                        )
                    } else if calendar.is_in_view_month(*date) {
                        Span::styled(label, base)
                    } else {
                        Span::styled(label, base.fg(theme::MUTED).add_modifier(Modifier::DIM))
                    }
                }
            })
            .collect();
        frame.render_widget(Paragraph::new(Line::from(spans)).style(base), grid(row));
    }
}

#[cfg(test)]
mod tests {
    use super::{Calendar, CalendarKey, GRID_WIDTH, render};
    use ratatui::Terminal;
    use ratatui::backend::TestBackend;
    use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    use ratatui::layout::Rect;
    use ratatui::style::Color;
    use thar_core::TodoDate;

    fn date(value: &str) -> TodoDate {
        TodoDate::parse(value).expect("valid test date")
    }

    fn key(code: KeyCode, modifiers: KeyModifiers) -> KeyEvent {
        KeyEvent::new(code, modifiers)
    }

    fn navigated(calendar: &mut Calendar, code: KeyCode, modifiers: KeyModifiers) -> String {
        assert_eq!(
            calendar.handle_key(key(code, modifiers)),
            CalendarKey::Moved
        );
        calendar.value().to_string()
    }

    #[test]
    fn starts_on_the_month_of_the_value() {
        let calendar = Calendar::new(date("2024-01-15"));
        assert_eq!(calendar.view(), date("2024-01-01"));
        assert_eq!(calendar.title(), "January 2024");
        assert_eq!(calendar.body_rows(), 2 + 5);
    }

    #[test]
    fn navigation_keeps_the_day_week_and_month_bindings() {
        let mut calendar = Calendar::new(date("2024-01-15"));
        assert_eq!(
            navigated(&mut calendar, KeyCode::Right, KeyModifiers::NONE),
            "2024-01-16"
        );
        assert_eq!(
            navigated(&mut calendar, KeyCode::Left, KeyModifiers::NONE),
            "2024-01-15"
        );
        assert_eq!(
            navigated(&mut calendar, KeyCode::Down, KeyModifiers::NONE),
            "2024-01-22"
        );
        assert_eq!(
            navigated(&mut calendar, KeyCode::Up, KeyModifiers::NONE),
            "2024-01-15"
        );
        assert_eq!(
            navigated(&mut calendar, KeyCode::Right, KeyModifiers::SHIFT),
            "2024-02-15"
        );
        assert_eq!(
            navigated(&mut calendar, KeyCode::Right, KeyModifiers::CONTROL),
            "2024-03-15"
        );
        assert_eq!(
            navigated(&mut calendar, KeyCode::Left, KeyModifiers::SHIFT),
            "2024-02-15"
        );
        assert_eq!(calendar.view(), date("2024-02-01"));
    }

    #[test]
    fn the_view_follows_cross_month_moves_only() {
        let mut calendar = Calendar::new(date("2024-01-31"));
        calendar.set_value(date("2024-01-01"));
        assert_eq!(calendar.view(), date("2024-01-01"));
        calendar.set_value(date("2024-02-01"));
        assert_eq!(calendar.view(), date("2024-02-01"));
        calendar.set_value(date("2024-02-20"));
        assert_eq!(calendar.view(), date("2024-02-01"));
    }

    #[test]
    fn month_navigation_moves_the_rendered_month() {
        let mut calendar = Calendar::new(date("2024-01-15"));
        calendar.handle_key(key(KeyCode::Right, KeyModifiers::SHIFT));
        assert_eq!(calendar.title(), "February 2024");
        calendar.handle_key(key(KeyCode::Left, KeyModifiers::SHIFT));
        assert_eq!(calendar.title(), "January 2024");
        calendar.handle_key(key(KeyCode::Left, KeyModifiers::SHIFT));
        assert_eq!(calendar.title(), "December 2023");
    }

    #[test]
    fn enter_submits_and_other_keys_are_ignored() {
        let mut calendar = Calendar::new(date("2026-11-15"));
        assert_eq!(
            calendar.handle_key(key(KeyCode::Enter, KeyModifiers::NONE)),
            CalendarKey::Submit
        );
        assert_eq!(calendar.value(), date("2026-11-15"));
        assert_eq!(
            calendar.handle_key(key(KeyCode::Char('x'), KeyModifiers::NONE)),
            CalendarKey::Ignored
        );
        assert_eq!(
            calendar.handle_key(key(KeyCode::Esc, KeyModifiers::NONE)),
            CalendarKey::Ignored
        );
    }

    #[test]
    fn out_of_range_moves_are_ignored() {
        let mut calendar = Calendar::new(date("9999-12-31"));
        assert_eq!(
            calendar.handle_key(key(KeyCode::Right, KeyModifiers::NONE)),
            CalendarKey::Ignored
        );
        assert_eq!(
            calendar.handle_key(key(KeyCode::Down, KeyModifiers::NONE)),
            CalendarKey::Ignored
        );
        assert_eq!(calendar.value(), date("9999-12-31"));
        // The trailing cells of the last week cannot be represented.
        let last = calendar.weeks().pop().expect("a last week");
        assert_eq!(last.iter().filter(|cell| cell.is_none()).count(), 2);
    }

    #[test]
    fn the_grid_is_monday_first_and_whole_weeks() {
        let calendar = Calendar::new(date("2024-01-15"));
        let weeks = calendar.weeks();
        assert_eq!(weeks.len(), 5);
        assert_eq!(weeks[0][0], Some(date("2024-01-01")));
        assert_eq!(weeks[0][6], Some(date("2024-01-07")));
        assert_eq!(weeks[4][6], Some(date("2024-02-04")));
        // February 2024 starts on a Thursday and ends on a Thursday.
        let february = Calendar::new(date("2024-02-10"));
        assert_eq!(february.weeks().len(), 5);
        // A 28-day February that starts on a Monday is exactly four weeks.
        let february = Calendar::new(date("2021-02-10"));
        let weeks = february.weeks();
        assert_eq!(weeks.len(), 4);
        assert_eq!(weeks[0][0], Some(date("2021-02-01")));
        assert_eq!(weeks[3][6], Some(date("2021-02-28")));
    }

    fn screen(calendar: &Calendar, width: u16, height: u16) -> (String, ratatui::buffer::Buffer) {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).expect("test terminal");
        terminal
            .draw(|frame| render(frame, Rect::new(0, 0, width, height), calendar))
            .expect("draw succeeds");
        let buffer = terminal.backend().buffer().clone();
        let text = (0..height)
            .map(|y| {
                (0..width)
                    .map(|x| buffer[(x, y)].symbol())
                    .collect::<String>()
                    .trim_end()
                    .to_owned()
                    + "\n"
            })
            .collect();
        (text, buffer)
    }

    #[test]
    fn renders_the_title_header_and_a_highlighted_selection() {
        let calendar = Calendar::new(date("2024-01-15"));
        let (text, buffer) = screen(&calendar, GRID_WIDTH, 8);
        assert!(text.contains("January 2024"), "{text}");
        assert!(text.contains("Mo Tu We Th Fr Sa Su"), "{text}");
        assert!(text.contains("15"), "{text}");

        // Row 2 is the first week; 15 January is a Monday in week 3 (row 4).
        let selected = buffer[(0, 4)].clone();
        assert_eq!(selected.symbol(), "1");
        assert_eq!(selected.style().bg, Some(Color::Rgb(0x7B, 0xA1, 0x52)));
        assert_eq!(selected.style().fg, Some(Color::Rgb(0x14, 0x12, 0x10)));

        // The last week starts on 29 January; 4 February is out of month.
        assert_eq!(buffer[(19, 6)].symbol(), "4");
        assert_eq!(
            buffer[(19, 6)].style().fg,
            Some(Color::Rgb(0x67, 0x65, 0x60))
        );
    }
}
