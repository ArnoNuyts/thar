//! `due:` / `t:` date screens and their calendar step.
//!
//! Ports `components/SetDateModal.tsx`:
//!
//! - Today, Tomorrow, Next Week and Next Month resolve against [`App::today`]
//!   (the start of the local day) with date-fns-compatible arithmetic, so a
//!   month-end clamps instead of rolling into the next month;
//! - Custom switches to the [`Calendar`], which submits with Enter and returns
//!   to the list step with Escape;
//! - Reset is appended only when the reference todo (`selected_todos()[0]`, in
//!   load order) already carries the tag, and emits a `None` date so the setter
//!   removes it;
//! - the relative rows accept hover and click, the calendar is keyboard-only.
//!
//! The screen returns [`Action`]s and never touches the list, so the host keeps
//! one history step per applied action.

use ratatui::Frame;
use ratatui::crossterm::event::{KeyCode, KeyEvent};
use ratatui::layout::{Alignment, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use thar_core::{TodoDate, TodoId, add_days, add_months, add_weeks};

use crate::app::App;
use crate::calendar::{self, Calendar};
use crate::event::{MouseInput, MouseKind};
use crate::modal::{Action, Modal, ModalId, ModalRect, ModalWidth, Outcome, geometry};
use crate::theme;

/// Which date tag a screen edits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DateKind {
    /// `due:`.
    Due,
    /// `t:`.
    Threshold,
}

impl DateKind {
    /// The tag key this screen reads and writes.
    const fn key(self) -> &'static str {
        match self {
            Self::Due => "due",
            Self::Threshold => "t",
        }
    }

    /// The modal title.
    const fn title(self) -> &'static str {
        match self {
            Self::Due => "Set Due Date",
            Self::Threshold => "Set Threshold Date",
        }
    }
}

/// One row of the list step.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Choice {
    Today,
    Tomorrow,
    NextWeek,
    NextMonth,
    Custom,
    Reset,
}

impl Choice {
    const fn label(self) -> &'static str {
        match self {
            Self::Today => "Today",
            Self::Tomorrow => "Tomorrow",
            Self::NextWeek => "Next Week",
            Self::NextMonth => "Next Month",
            Self::Custom => "Custom",
            Self::Reset => "Reset",
        }
    }
}

/// The `Set Due Date` / `Set Threshold Date` screen.
pub(crate) struct SetDateModal {
    kind: DateKind,
    ids: Vec<TodoId>,
    today: TodoDate,
    options: Vec<Choice>,
    selected: usize,
    custom: bool,
    calendar: Calendar,
    terminal: Rect,
}

impl SetDateModal {
    /// Build the screen from the current selection and day.
    pub(crate) fn new(app: &App, kind: DateKind) -> Self {
        let selected = app.selected_todos();
        let ids: Vec<TodoId> = selected.iter().map(|todo| todo.id).collect();
        let reference = selected.first().copied();
        // Reset keys on the tag being present (the Ink app tests the tag value,
        // not whether it parses), while the calendar starts on a parsed day.
        let has_tag = reference.is_some_and(|todo| todo.tag(kind.key()).is_some());
        let initial = reference
            .and_then(|todo| todo.date_tag(kind.key()))
            .unwrap_or(app.today());

        let mut options = vec![
            Choice::Today,
            Choice::Tomorrow,
            Choice::NextWeek,
            Choice::NextMonth,
            Choice::Custom,
        ];
        if has_tag {
            options.push(Choice::Reset);
        }

        Self {
            kind,
            ids,
            today: app.today(),
            options,
            selected: 0,
            custom: false,
            calendar: Calendar::new(initial),
            terminal: Rect::new(0, 0, app.width(), app.height()),
        }
    }

    /// The selected row label, for tests and rendering.
    #[cfg(test)]
    fn selected_label(&self) -> &'static str {
        self.options
            .get(self.selected)
            .map_or("", |choice| choice.label())
    }

    /// Resolve a relative choice against the app's day.
    fn date_for(&self, choice: Choice) -> Option<TodoDate> {
        match choice {
            Choice::Today => Some(self.today),
            Choice::Tomorrow => add_days(self.today, 1),
            Choice::NextWeek => add_weeks(self.today, 1),
            Choice::NextMonth => add_months(self.today, 1),
            // Custom and Reset never reach this path.
            Choice::Custom | Choice::Reset => None,
        }
    }

    fn apply(&mut self, index: usize) -> Outcome {
        let Some(choice) = self.options.get(index).copied() else {
            return Outcome::Continue;
        };
        self.selected = index;

        match choice {
            Choice::Custom => {
                self.custom = true;
                Outcome::Continue
            }
            Choice::Reset => self.submit(None),
            _ => match self.date_for(choice) {
                Some(date) => self.submit(Some(date)),
                None => Outcome::Continue,
            },
        }
    }

    fn submit(&self, date: Option<TodoDate>) -> Outcome {
        let ids = self.ids.clone();
        Outcome::Actions(vec![match self.kind {
            DateKind::Due => Action::SetDue { ids, date },
            DateKind::Threshold => Action::SetThreshold { ids, date },
        }])
    }

    fn rect(&self) -> ModalRect {
        geometry::resolve(self.terminal, self.width(), self.body_rows())
    }

    fn render_options(&self, frame: &mut Frame, area: Rect) {
        let base = Style::default()
            .fg(theme::FOREGROUND)
            .bg(theme::MODAL_BACKGROUND);
        for (index, choice) in self.options.iter().enumerate() {
            let y = area
                .y
                .saturating_add(u16::try_from(index).unwrap_or(u16::MAX));
            if y >= area.y.saturating_add(area.height) {
                break;
            }
            let marker = if index == self.selected { "» " } else { "  " };
            let line = Line::from(vec![
                Span::styled(
                    format!(" {marker}"),
                    Style::default()
                        .fg(theme::SECONDARY)
                        .bg(theme::MODAL_BACKGROUND),
                ),
                Span::styled(choice.label(), base),
            ]);
            frame.render_widget(
                Paragraph::new(line).style(base),
                Rect::new(area.x, y, area.width, 1),
            );
        }
    }

    fn render_calendar(&self, frame: &mut Frame, area: Rect) {
        let rows = self.calendar.body_rows().min(area.height);
        let grid = Rect::new(area.x, area.y, area.width, rows);
        calendar::render(frame, grid, &self.calendar);

        let y = area.y.saturating_add(rows);
        if y >= area.y.saturating_add(area.height) {
            return;
        }
        let base = Style::default()
            .fg(theme::MUTED)
            .bg(theme::MODAL_BACKGROUND)
            .add_modifier(Modifier::DIM);
        frame.render_widget(
            Paragraph::new(
                Line::from(Span::styled(
                    format!("Selected: {}", self.calendar.value()),
                    base,
                ))
                .alignment(Alignment::Center),
            )
            .style(base),
            Rect::new(area.x, y, area.width, 1),
        );
    }
}

impl Modal for SetDateModal {
    fn id(&self) -> ModalId {
        match self.kind {
            DateKind::Due => ModalId::SetDueDate,
            DateKind::Threshold => ModalId::SetThresholdDate,
        }
    }

    fn title(&self) -> &str {
        self.kind.title()
    }

    fn width(&self) -> ModalWidth {
        if self.custom {
            ModalWidth::Cells(30)
        } else {
            ModalWidth::Percent(50)
        }
    }

    fn body_rows(&self) -> u16 {
        if self.custom {
            self.calendar.body_rows().saturating_add(1)
        } else {
            u16::try_from(self.options.len()).unwrap_or(0)
        }
    }

    fn handle_key(&mut self, key: KeyEvent) -> Outcome {
        if self.custom {
            if key.code == KeyCode::Esc {
                self.custom = false;
                return Outcome::Continue;
            }
            if self.calendar.handle_key(key) == calendar::CalendarKey::Submit {
                return self.submit(Some(self.calendar.value()));
            }
            return Outcome::Continue;
        }

        match key.code {
            KeyCode::Esc => Outcome::Close,
            KeyCode::Up => {
                self.selected = super::buttons::cycle(self.selected, self.options.len(), false);
                Outcome::Continue
            }
            KeyCode::Down => {
                self.selected = super::buttons::cycle(self.selected, self.options.len(), true);
                Outcome::Continue
            }
            KeyCode::Enter => self.apply(self.selected),
            _ => Outcome::Continue,
        }
    }

    fn handle_mouse(&mut self, mouse: MouseInput) -> Outcome {
        if self.custom {
            // The calendar is keyboard-only, matching the Ink component.
            return Outcome::Continue;
        }
        let rect = self.rect();
        if !geometry::contains(rect, mouse) {
            return Outcome::Continue;
        }
        let Some(row) = geometry::body_row(rect, mouse) else {
            return Outcome::Continue;
        };
        let index = usize::from(row);
        if index >= self.options.len() {
            return Outcome::Continue;
        }

        match mouse.kind {
            MouseKind::Move => {
                self.selected = index;
                Outcome::Continue
            }
            MouseKind::LeftClick => self.apply(index),
            MouseKind::WheelUp | MouseKind::WheelDown => Outcome::Continue,
        }
    }

    fn render(&self, frame: &mut Frame, rect: ModalRect) {
        // The resolved body spans the whole box; keep one cell on each side for
        // the border the overlay draws.
        let inner = Rect::new(
            rect.body.x.saturating_add(1),
            rect.body.y,
            rect.body.width.saturating_sub(2),
            rect.body.height,
        );
        if self.custom {
            self.render_calendar(frame, inner);
        } else {
            self.render_options(frame, inner);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{DateKind, SetDateModal};
    use crate::app::App;
    use crate::calendar::{Calendar, CalendarKey};
    use crate::event::{MouseInput, MouseKind};
    use crate::modal::{Action, Modal, Outcome};
    use ratatui::Terminal;
    use ratatui::backend::TestBackend;
    use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    use std::time::Instant;
    use thar_core::{Todo, TodoDate, TodoId};

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
        app.resize(80, 24);
        app
    }

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn mouse(kind: MouseKind, x: u16, y: u16) -> MouseInput {
        MouseInput {
            kind,
            x,
            y,
            shift: false,
        }
    }

    fn actions(outcome: Outcome) -> Vec<Action> {
        match outcome {
            Outcome::Actions(actions) => actions,
            Outcome::Continue | Outcome::Close => {
                panic!("unexpected outcome")
            }
        }
    }

    fn action_date(actions: &[Action]) -> Option<TodoDate> {
        match actions.first() {
            Some(Action::SetDue { date, .. } | Action::SetThreshold { date, .. }) => *date,
            _ => panic!("unexpected action"),
        }
    }

    #[test]
    fn relative_rows_resolve_from_today() {
        let app = app(&["task"]);
        let mut modal = SetDateModal::new(&app, DateKind::Due);
        assert_eq!(modal.selected_label(), "Today");

        let today = "2026-11-15".parse::<TodoDate>().expect("valid");
        assert_eq!(
            action_date(&actions(modal.handle_key(key(KeyCode::Enter)))),
            Some(today)
        );

        modal.handle_key(key(KeyCode::Down));
        assert_eq!(
            action_date(&actions(modal.handle_key(key(KeyCode::Enter)))),
            "2026-11-16".parse::<TodoDate>().ok()
        );

        modal.handle_key(key(KeyCode::Down));
        assert_eq!(
            action_date(&actions(modal.handle_key(key(KeyCode::Enter)))),
            "2026-11-22".parse::<TodoDate>().ok()
        );

        modal.handle_key(key(KeyCode::Down));
        assert_eq!(
            action_date(&actions(modal.handle_key(key(KeyCode::Enter)))),
            "2026-12-15".parse::<TodoDate>().ok()
        );
    }

    #[test]
    fn next_month_clamps_a_month_end() {
        let mut app = app(&["task"]);
        app.set_today("2024-01-31".parse::<TodoDate>().expect("valid"));
        let mut modal = SetDateModal::new(&app, DateKind::Due);
        for _ in 0..3 {
            modal.handle_key(key(KeyCode::Down));
        }
        assert_eq!(modal.selected_label(), "Next Month");
        assert_eq!(
            action_date(&actions(modal.handle_key(key(KeyCode::Enter)))),
            "2024-02-29".parse::<TodoDate>().ok()
        );
    }

    #[test]
    fn reset_is_only_offered_when_the_reference_has_the_tag() {
        let plain = app(&["task"]);
        let mut modal = SetDateModal::new(&plain, DateKind::Due);
        assert_eq!(modal.body_rows(), 5);
        // Up from Today wraps to Custom, not Reset.
        modal.handle_key(key(KeyCode::Up));
        assert_eq!(modal.selected_label(), "Custom");

        let tagged = app(&["task due:2024-05-06 t:2024-05-07"]);
        let mut modal = SetDateModal::new(&tagged, DateKind::Due);
        assert_eq!(modal.body_rows(), 6);
        modal.handle_key(key(KeyCode::Up));
        assert_eq!(modal.selected_label(), "Reset");
        let ids = vec![tagged.todos()[0].id];
        assert_eq!(
            actions(modal.handle_key(key(KeyCode::Enter))),
            vec![Action::SetDue { ids, date: None }]
        );

        let mut threshold = SetDateModal::new(&tagged, DateKind::Threshold);
        threshold.handle_key(key(KeyCode::Up));
        assert_eq!(threshold.selected_label(), "Reset");
    }

    #[test]
    fn escape_closes_the_list_step_and_the_calendar_step_returns() {
        let app = app(&["task"]);
        let mut modal = SetDateModal::new(&app, DateKind::Due);
        for _ in 0..4 {
            modal.handle_key(key(KeyCode::Down));
        }
        assert_eq!(modal.selected_label(), "Custom");
        assert!(matches!(
            modal.handle_key(key(KeyCode::Enter)),
            Outcome::Continue
        ));
        assert!(modal.custom);
        assert_eq!(
            modal.body_rows(),
            Calendar::new(app.today()).body_rows() + 1
        );
        assert!(matches!(
            modal.handle_key(key(KeyCode::Esc)),
            Outcome::Continue
        ));
        assert!(!modal.custom);
        assert!(matches!(
            modal.handle_key(key(KeyCode::Esc)),
            Outcome::Close
        ));
    }

    #[test]
    fn the_custom_step_starts_on_the_existing_tag_date() {
        let app = app(&["task due:2024-02-29 t:not-a-date"]);
        let mut modal = SetDateModal::new(&app, DateKind::Due);
        modal.selected = 4;
        modal.handle_key(key(KeyCode::Enter));
        assert_eq!(
            modal.calendar.value(),
            "2024-02-29".parse::<TodoDate>().unwrap()
        );

        let mut threshold = SetDateModal::new(&app, DateKind::Threshold);
        threshold.selected = 4;
        threshold.handle_key(key(KeyCode::Enter));
        // A malformed tag falls back to today, like `parseDateTag(...) ?? new Date()`.
        assert_eq!(threshold.calendar.value(), app.today());
    }

    #[test]
    fn the_calendar_submits_with_enter() {
        let app = app(&["task"]);
        let mut modal = SetDateModal::new(&app, DateKind::Due);
        modal.selected = 4;
        modal.handle_key(key(KeyCode::Enter));
        assert_eq!(
            modal.calendar.handle_key(key(KeyCode::Right)),
            CalendarKey::Moved
        );
        assert_eq!(
            action_date(&actions(modal.handle_key(key(KeyCode::Enter)))),
            "2026-11-16".parse::<TodoDate>().ok()
        );
    }

    #[test]
    fn mouse_hover_moves_and_click_applies_a_relative_row() {
        let app = app(&["task"]);
        let mut modal = SetDateModal::new(&app, DateKind::Due);
        let rect = modal.rect();
        // Body row 2 is Next Week.
        let x = rect.body.x + 2;
        let y = rect.body.y + 3;
        let outcome = modal.handle_mouse(mouse(MouseKind::Move, x, y));
        assert!(matches!(outcome, Outcome::Continue));
        assert_eq!(modal.selected_label(), "Next Week");

        let outcome = modal.handle_mouse(mouse(MouseKind::LeftClick, x, y));
        assert_eq!(
            action_date(&actions(outcome)),
            "2026-11-22".parse::<TodoDate>().ok()
        );

        // A row past the options is ignored.
        let last = rect.body.y + modal.body_rows() + 1;
        assert!(matches!(
            modal.handle_mouse(mouse(MouseKind::LeftClick, x, last)),
            Outcome::Continue
        ));
        // The calendar step ignores the mouse.
        modal.selected = 4;
        modal.handle_key(key(KeyCode::Enter));
        assert!(matches!(
            modal.handle_mouse(mouse(MouseKind::LeftClick, x, y)),
            Outcome::Continue
        ));
    }

    #[test]
    fn the_screen_renders_both_steps() {
        let mut app = app(&["task due:2024-05-06"]);
        app.open_modal(crate::modal::ModalId::SetDueDate);
        let mut terminal = Terminal::new(TestBackend::new(80, 24)).expect("test terminal");
        terminal
            .draw(|frame| crate::view::render(frame, &app))
            .expect("draw succeeds");
        let screen = frame_text(terminal.backend().buffer());
        assert!(screen.contains("Set Due Date"), "{screen}");
        assert!(screen.contains("» Today"), "{screen}");
        assert!(screen.contains("Reset"), "{screen}");

        // Open the custom step and draw again.
        for _ in 0..4 {
            app.handle_modal_key(key(KeyCode::Down), Instant::now());
        }
        app.handle_modal_key(key(KeyCode::Enter), Instant::now());
        let mut terminal = Terminal::new(TestBackend::new(80, 24)).expect("test terminal");
        terminal
            .draw(|frame| crate::view::render(frame, &app))
            .expect("draw succeeds");
        let screen = frame_text(terminal.backend().buffer());
        assert!(screen.contains("May 2024"), "{screen}");
        assert!(screen.contains("Mo Tu We Th Fr Sa Su"), "{screen}");
        assert!(screen.contains("Selected: 2024-05-06"), "{screen}");
    }

    fn frame_text(buffer: &ratatui::buffer::Buffer) -> String {
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
    fn the_modal_has_the_expected_identity_and_toast_is_never_used() {
        let plain = app(&["task"]);
        let due = SetDateModal::new(&plain, DateKind::Due);
        assert_eq!(due.id(), crate::modal::ModalId::SetDueDate);
        assert_eq!(due.title(), "Set Due Date");
        let threshold = SetDateModal::new(&plain, DateKind::Threshold);
        assert_eq!(threshold.id(), crate::modal::ModalId::SetThresholdDate);
        assert_eq!(threshold.title(), "Set Threshold Date");
        // Opening a screen does not show a toast; the host owns messages.
        let mut opened = app(&["task"]);
        opened.open_modal(crate::modal::ModalId::SetDueDate);
        assert!(opened.toast_message(Instant::now()).is_none());
    }
}
