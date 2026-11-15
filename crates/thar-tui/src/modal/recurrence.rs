//! The two-step `Set Recurrence` screen.
//!
//! Ports `components/SetRecurrenceModal.tsx`:
//!
//! 1. choose a base (Daily, Weekly, Monthly, Yearly); `Reset` is appended only
//!    when the reference todo (`selected_todos()[0]`, in load order) already has
//!    a `rec:` tag;
//! 2. type the amount. Only ASCII digits are accepted, the amount starts at
//!    `"1"`, and the first typed digit replaces that default. Choosing a base
//!    resets the amount to `"1"`.
//!
//! Enter validates `amount + unit` with [`is_valid_recurrence`] and shows the
//! bounded "whole number from 1 to 9999" toast when it fails. Escape goes back
//! to the base step first, then closes. A base row accepts hover and click; the
//! amount step is keyboard-only.

use ratatui::Frame;
use ratatui::crossterm::event::{KeyCode, KeyEvent};
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use thar_core::{TodoId, is_valid_recurrence};

use crate::app::App;
use crate::input::{MouseInput, MouseKind};
use crate::modal::{Action, Modal, ModalId, ModalRect, ModalWidth, Outcome, geometry};
use crate::theme;

/// Message shown when the typed amount/unit combination is rejected.
pub(crate) const INVALID_AMOUNT_MESSAGE: &str = "Recurrence must be a whole number from 1 to 9999";

/// One base row.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Base {
    Daily,
    Weekly,
    Monthly,
    Yearly,
    Reset,
}

impl Base {
    const fn label(self) -> &'static str {
        match self {
            Self::Daily => "Daily",
            Self::Weekly => "Weekly",
            Self::Monthly => "Monthly",
            Self::Yearly => "Yearly",
            Self::Reset => "Reset",
        }
    }

    const fn unit_label(self) -> &'static str {
        match self {
            Self::Daily => "day(s)",
            Self::Weekly => "week(s)",
            Self::Monthly => "month(s)",
            Self::Yearly => "year(s)",
            Self::Reset => "",
        }
    }

    const fn unit(self) -> Option<char> {
        match self {
            Self::Daily => Some('d'),
            Self::Weekly => Some('w'),
            Self::Monthly => Some('m'),
            Self::Yearly => Some('y'),
            Self::Reset => None,
        }
    }
}

/// Which step owns the keys.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Step {
    Base,
    Amount,
}

/// The `Set Recurrence` screen.
pub(crate) struct SetRecurrenceModal {
    ids: Vec<TodoId>,
    options: Vec<Base>,
    selected: usize,
    step: Step,
    amount: String,
    edited: bool,
    title: String,
    terminal: Rect,
}

impl SetRecurrenceModal {
    /// Build the screen from the current selection.
    pub(crate) fn new(app: &App) -> Self {
        let selected = app.selected_todos();
        let ids: Vec<TodoId> = selected.iter().map(|todo| todo.id).collect();
        let has_recurrence = selected
            .first()
            .is_some_and(|todo| todo.tag("rec").is_some());

        let mut options = vec![Base::Daily, Base::Weekly, Base::Monthly, Base::Yearly];
        if has_recurrence {
            options.push(Base::Reset);
        }

        Self {
            ids,
            options,
            selected: 0,
            step: Step::Base,
            amount: "1".to_owned(),
            edited: false,
            title: "Set Recurrence Base".to_owned(),
            terminal: Rect::new(0, 0, app.width, app.height),
        }
    }

    /// The base at the highlighted index, if it is a unit base.
    fn base(&self) -> Option<Base> {
        self.options
            .get(self.selected)
            .copied()
            .filter(|base| base.unit().is_some())
    }

    /// Rebuild the stored title after a step or base change.
    ///
    /// The title is owned because the amount step names the chosen base; the
    /// overlay reads it through [`Modal::title`] before the body is drawn.
    fn refresh_title(&mut self) {
        self.title = match self.step {
            Step::Base => "Set Recurrence Base".to_owned(),
            Step::Amount => format!(
                "Set Recurrence Interval ({})",
                self.base().map_or("Daily", Base::label)
            ),
        };
    }

    fn move_selection(&mut self, delta: i32) {
        if self.options.is_empty() {
            return;
        }
        let count = i32::try_from(self.options.len()).unwrap_or(1);
        let current = i32::try_from(self.selected).unwrap_or(0);
        self.selected = usize::try_from((current + delta).rem_euclid(count)).unwrap_or(0);
    }

    fn select_base(&mut self) -> Outcome {
        match self.options.get(self.selected).copied() {
            Some(Base::Reset) => {
                let ids = self.ids.clone();
                Outcome::Actions(vec![Action::SetRecurrence { ids, value: None }])
            }
            Some(_) => {
                self.step = Step::Amount;
                self.amount = "1".to_owned();
                self.edited = false;
                self.refresh_title();
                Outcome::Continue
            }
            None => Outcome::Continue,
        }
    }

    /// Append one typed digit, replacing the default `"1"` on the first one.
    fn push_digit(&mut self, digit: char) {
        if self.edited {
            self.amount.push(digit);
        } else {
            self.amount.clear();
            self.amount.push(digit);
            self.edited = true;
        }
    }

    fn submit_amount(&self) -> Outcome {
        if self.amount.is_empty() {
            return Outcome::Continue;
        }
        let Some(base) = self.base().and_then(Base::unit) else {
            return Outcome::Continue;
        };
        let value = format!("{}{base}", self.amount);
        if !is_valid_recurrence(&value) {
            return Outcome::Actions(vec![Action::Toast(INVALID_AMOUNT_MESSAGE.to_owned())]);
        }
        let ids = self.ids.clone();
        Outcome::Actions(vec![Action::SetRecurrence {
            ids,
            value: Some(value),
        }])
    }

    fn rect(&self) -> ModalRect {
        geometry::resolve(self.terminal, self.width(), self.body_rows())
    }
}

impl Modal for SetRecurrenceModal {
    fn id(&self) -> ModalId {
        ModalId::SetRecurrence
    }

    fn title(&self) -> &str {
        &self.title
    }

    fn width(&self) -> ModalWidth {
        ModalWidth::Percent(50)
    }

    fn body_rows(&self) -> u16 {
        match self.step {
            Step::Base => u16::try_from(self.options.len()).unwrap_or(0),
            Step::Amount => 2,
        }
    }

    fn handle_key(&mut self, key: KeyEvent) -> Outcome {
        match self.step {
            Step::Base => match key.code {
                KeyCode::Esc => Outcome::Close,
                KeyCode::Up => {
                    self.move_selection(-1);
                    Outcome::Continue
                }
                KeyCode::Down => {
                    self.move_selection(1);
                    Outcome::Continue
                }
                KeyCode::Enter => self.select_base(),
                _ => Outcome::Continue,
            },
            Step::Amount => match key.code {
                KeyCode::Esc => {
                    self.step = Step::Base;
                    self.refresh_title();
                    Outcome::Continue
                }
                KeyCode::Enter => self.submit_amount(),
                KeyCode::Backspace | KeyCode::Delete => {
                    self.amount.pop();
                    self.edited = true;
                    Outcome::Continue
                }
                KeyCode::Char(digit) if digit.is_ascii_digit() => {
                    self.push_digit(digit);
                    Outcome::Continue
                }
                _ => Outcome::Continue,
            },
        }
    }

    fn handle_mouse(&mut self, mouse: MouseInput) -> Outcome {
        if self.step != Step::Base {
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
            MouseKind::LeftClick => {
                self.selected = index;
                self.select_base()
            }
            MouseKind::WheelUp | MouseKind::WheelDown => Outcome::Continue,
        }
    }

    fn render(&self, frame: &mut Frame, rect: ModalRect) {
        let base = Style::default()
            .fg(theme::FOREGROUND)
            .bg(theme::MODAL_BACKGROUND);
        let inner = Rect::new(
            rect.body.x.saturating_add(1),
            rect.body.y,
            rect.body.width.saturating_sub(2),
            rect.body.height,
        );

        match self.step {
            Step::Base => {
                for (index, option) in self.options.iter().enumerate() {
                    let y = inner
                        .y
                        .saturating_add(u16::try_from(index).unwrap_or(u16::MAX));
                    if y >= inner.y.saturating_add(inner.height) {
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
                        Span::styled(option.label(), base),
                    ]);
                    frame.render_widget(
                        Paragraph::new(line).style(base),
                        Rect::new(inner.x, y, inner.width, 1),
                    );
                }
            }
            Step::Amount => {
                let unit = self.base().map_or("", Base::unit_label);
                let line = Line::from(vec![
                    Span::styled(" Every ", base),
                    Span::styled(self.amount.clone(), base.add_modifier(Modifier::REVERSED)),
                    Span::styled(format!(" {unit}"), base),
                ]);
                frame.render_widget(
                    Paragraph::new(line).style(base),
                    Rect::new(inner.x, inner.y, inner.width, 1),
                );

                let hint = Style::default()
                    .fg(theme::MUTED)
                    .bg(theme::MODAL_BACKGROUND)
                    .add_modifier(Modifier::DIM);
                frame.render_widget(
                    Paragraph::new(Span::styled(" Enter = save, Esc = back", hint)).style(hint),
                    Rect::new(inner.x, inner.y.saturating_add(1), inner.width, 1),
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{INVALID_AMOUNT_MESSAGE, SetRecurrenceModal, Step};
    use crate::app::App;
    use crate::input::{MouseInput, MouseKind};
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
            TodoDate::parse("2026-11-15").expect("valid date"),
        );
        app.resize(80, 24);
        app.read_only = false;
        app
    }

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn actions(outcome: Outcome) -> Vec<Action> {
        match outcome {
            Outcome::Actions(actions) => actions,
            Outcome::Continue | Outcome::Close | Outcome::Replace(_) => {
                panic!("unexpected outcome")
            }
        }
    }

    fn type_digits(modal: &mut SetRecurrenceModal, digits: &str) {
        for digit in digits.chars() {
            modal.handle_key(key(KeyCode::Char(digit)));
        }
    }

    #[test]
    fn the_base_step_offers_four_units_and_reset_only_with_a_tag() {
        let plain = app(&["task"]);
        let modal = SetRecurrenceModal::new(&plain);
        assert_eq!(modal.body_rows(), 4);
        assert_eq!(modal.title(), "Set Recurrence Base");

        let recurring = app(&["task rec:2w"]);
        let modal = SetRecurrenceModal::new(&recurring);
        assert_eq!(modal.body_rows(), 5);
        assert_eq!(modal.options[4], super::Base::Reset);
    }

    #[test]
    fn daily_with_the_default_amount_is_one_day() {
        let app = app(&["task"]);
        let ids = vec![app.todos[0].id];
        let mut modal = SetRecurrenceModal::new(&app);
        assert!(matches!(
            modal.handle_key(key(KeyCode::Enter)),
            Outcome::Continue
        ));
        assert_eq!(modal.step, Step::Amount);
        assert_eq!(modal.amount, "1");
        assert_eq!(
            actions(modal.handle_key(key(KeyCode::Enter))),
            vec![Action::SetRecurrence {
                ids,
                value: Some("1d".to_owned())
            }]
        );
    }

    #[test]
    fn the_first_digit_replaces_the_default_and_non_digits_are_ignored() {
        let app = app(&["task"]);
        let ids = vec![app.todos[0].id];
        let mut modal = SetRecurrenceModal::new(&app);
        modal.handle_key(key(KeyCode::Enter));
        for input in ['a', '1', 'b', '2'] {
            modal.handle_key(key(KeyCode::Char(input)));
        }
        assert_eq!(modal.amount, "12");
        assert_eq!(
            actions(modal.handle_key(key(KeyCode::Enter))),
            vec![Action::SetRecurrence {
                ids,
                value: Some("12d".to_owned())
            }]
        );
    }

    #[test]
    fn selecting_a_base_resets_the_amount() {
        let app = app(&["task"]);
        let mut modal = SetRecurrenceModal::new(&app);
        modal.handle_key(key(KeyCode::Enter));
        type_digits(&mut modal, "23");
        assert_eq!(modal.amount, "23");
        modal.handle_key(key(KeyCode::Esc));
        assert_eq!(modal.step, Step::Base);

        modal.handle_key(key(KeyCode::Down));
        modal.handle_key(key(KeyCode::Enter));
        assert_eq!(modal.amount, "1");
        type_digits(&mut modal, "45");
        assert_eq!(
            actions(modal.handle_key(key(KeyCode::Enter))),
            vec![Action::SetRecurrence {
                ids: vec![app.todos[0].id],
                value: Some("45w".to_owned())
            }]
        );
    }

    #[test]
    fn enter_validates_the_amount_and_toasts_without_closing() {
        let app = app(&["task"]);
        let mut modal = SetRecurrenceModal::new(&app);
        modal.handle_key(key(KeyCode::Enter));
        type_digits(&mut modal, "0");
        assert_eq!(
            actions(modal.handle_key(key(KeyCode::Enter))),
            vec![Action::Toast(INVALID_AMOUNT_MESSAGE.to_owned())]
        );
        assert_eq!(modal.step, Step::Amount);

        modal.handle_key(key(KeyCode::Backspace));
        type_digits(&mut modal, "2");
        assert_eq!(
            actions(modal.handle_key(key(KeyCode::Enter))),
            vec![Action::SetRecurrence {
                ids: vec![app.todos[0].id],
                value: Some("2d".to_owned())
            }]
        );
    }

    #[test]
    fn amounts_above_the_limit_are_rejected() {
        let app = app(&["task"]);
        let mut modal = SetRecurrenceModal::new(&app);
        modal.handle_key(key(KeyCode::Enter));
        type_digits(&mut modal, "10000");
        assert_eq!(
            actions(modal.handle_key(key(KeyCode::Enter))),
            vec![Action::Toast(INVALID_AMOUNT_MESSAGE.to_owned())]
        );
    }

    #[test]
    fn an_empty_amount_does_nothing() {
        let app = app(&["task"]);
        let mut modal = SetRecurrenceModal::new(&app);
        modal.handle_key(key(KeyCode::Enter));
        modal.handle_key(key(KeyCode::Backspace));
        assert!(modal.amount.is_empty());
        assert!(matches!(
            modal.handle_key(key(KeyCode::Enter)),
            Outcome::Continue
        ));
    }

    #[test]
    fn reset_removes_the_value() {
        let app = app(&["task rec:1w"]);
        let ids = vec![app.todos[0].id];
        let mut modal = SetRecurrenceModal::new(&app);
        modal.handle_key(key(KeyCode::Up));
        assert_eq!(
            actions(modal.handle_key(key(KeyCode::Enter))),
            vec![Action::SetRecurrence { ids, value: None }]
        );
    }

    #[test]
    fn escape_returns_to_the_base_step_and_then_closes() {
        let app = app(&["task"]);
        let mut modal = SetRecurrenceModal::new(&app);
        modal.handle_key(key(KeyCode::Enter));
        assert!(matches!(
            modal.handle_key(key(KeyCode::Esc)),
            Outcome::Continue
        ));
        assert_eq!(modal.step, Step::Base);
        assert!(matches!(
            modal.handle_key(key(KeyCode::Esc)),
            Outcome::Close
        ));
    }

    #[test]
    fn base_rows_hover_and_click_but_the_amount_step_is_keyboard_only() {
        let app = app(&["task"]);
        let mut modal = SetRecurrenceModal::new(&app);
        let rect = modal.rect();
        let x = rect.body.x + 1;
        let y = rect.body.y + 2; // body row 1 -> Weekly

        assert!(matches!(
            modal.handle_mouse(MouseInput {
                kind: MouseKind::Move,
                x,
                y,
                shift: false
            }),
            Outcome::Continue
        ));
        assert_eq!(modal.selected, 1);
        assert!(matches!(
            modal.handle_mouse(MouseInput {
                kind: MouseKind::LeftClick,
                x,
                y,
                shift: false
            }),
            Outcome::Continue
        ));
        assert_eq!(modal.step, Step::Amount);

        assert!(matches!(
            modal.handle_mouse(MouseInput {
                kind: MouseKind::LeftClick,
                x,
                y,
                shift: false
            }),
            Outcome::Continue
        ));
        assert_eq!(modal.step, Step::Amount);
    }

    #[test]
    fn the_amount_title_names_the_base() {
        let app = app(&["task"]);
        let mut modal = SetRecurrenceModal::new(&app);
        modal.handle_key(key(KeyCode::Down));
        modal.handle_key(key(KeyCode::Enter));
        assert_eq!(modal.title(), "Set Recurrence Interval (Weekly)");
        assert_eq!(modal.body_rows(), 2);
        // The rendered chrome names the base.
        let mut terminal = Terminal::new(TestBackend::new(80, 24)).expect("test terminal");
        terminal
            .draw(|frame| modal.render(frame, modal.rect()))
            .expect("draw succeeds");
        let buffer = terminal.backend().buffer();
        let screen: String = (0..buffer.area.height)
            .map(|y| {
                (0..buffer.area.width)
                    .map(|x| buffer[(x, y)].symbol())
                    .collect::<String>()
                    .trim_end()
                    .to_owned()
                    + "\n"
            })
            .collect();
        assert!(screen.contains("Every"), "{screen}");
        assert!(screen.contains("1 week(s)"), "{screen}");
        assert!(screen.contains("Enter = save, Esc = back"), "{screen}");
    }

    #[test]
    fn the_base_screen_renders_inside_the_app() {
        let mut app = app(&["task rec:1w"]);
        app.open_modal(crate::modal::ModalId::SetRecurrence);
        let mut terminal = Terminal::new(TestBackend::new(80, 24)).expect("test terminal");
        terminal
            .draw(|frame| crate::view::render(frame, &app))
            .expect("draw succeeds");
        let buffer = terminal.backend().buffer();
        let screen: String = (0..buffer.area.height)
            .map(|y| {
                (0..buffer.area.width)
                    .map(|x| buffer[(x, y)].symbol())
                    .collect::<String>()
                    .trim_end()
                    .to_owned()
                    + "\n"
            })
            .collect();
        assert!(screen.contains("Set Recurrence Base"), "{screen}");
        assert!(screen.contains("» Daily"), "{screen}");
        assert!(screen.contains("Reset"), "{screen}");
    }

    #[test]
    fn the_toast_message_names_the_limit() {
        assert_eq!(
            thar_core::MAX_RECURRENCE_AMOUNT,
            9_999,
            "the message and the domain limit agree"
        );
        assert!(INVALID_AMOUNT_MESSAGE.contains("1 to 9999"));
        let mut app = app(&["task"]);
        app.push_toast(INVALID_AMOUNT_MESSAGE);
        assert_eq!(
            app.toast_message(Instant::now()),
            Some(INVALID_AMOUNT_MESSAGE)
        );
    }
}
