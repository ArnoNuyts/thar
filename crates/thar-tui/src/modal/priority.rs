//! The `Set Priority` screen.
//!
//! Ports `components/SetPriorityModal.tsx`: the options are the inline
//! `A`..`F` shortcuts in order, plus `Unset` only when the reference todo
//! (`selected_todos()[0]`, in load order) already has a priority. Up/Down wrap,
//! Enter applies, Escape closes, and a click applies the row it lands on while
//! hover moves the highlight.

use ratatui::Frame;
use ratatui::crossterm::event::{KeyCode, KeyEvent};
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use thar_core::{Priority, TodoId};

use crate::app::App;
use crate::event::{MouseInput, MouseKind};
use crate::modal::{Action, Modal, ModalId, ModalRect, ModalWidth, Outcome, geometry};
use crate::theme;

/// Inline priority letters, in shortcut order (`logic/priority.ts`).
pub(crate) const PRIORITIES: [char; 6] = ['A', 'B', 'C', 'D', 'E', 'F'];

/// The `Set Priority` screen.
pub(crate) struct SetPriorityModal {
    ids: Vec<TodoId>,
    options: Vec<Option<Priority>>,
    selected: usize,
    terminal: Rect,
}

impl SetPriorityModal {
    /// Build the screen from the current selection.
    pub(crate) fn new(app: &App) -> Self {
        let selected = app.selected_todos();
        let ids: Vec<TodoId> = selected.iter().map(|todo| todo.id).collect();
        let has_priority = selected.first().is_some_and(|todo| todo.priority.is_some());

        let mut options: Vec<Option<Priority>> = PRIORITIES
            .iter()
            .map(|letter| Priority::new(*letter))
            .collect();
        if has_priority {
            options.push(None);
        }

        Self {
            ids,
            options,
            selected: 0,
            terminal: Rect::new(0, 0, app.width(), app.height()),
        }
    }

    /// The priority value of a row (`Unset` is `None`).
    fn value(&self, index: usize) -> Option<Priority> {
        self.options.get(index).copied().flatten()
    }

    /// The label of the highlighted row.
    fn label(&self, index: usize) -> String {
        self.value(index).map_or_else(
            || "Unset".to_owned(),
            |priority| priority.as_char().to_string(),
        )
    }

    fn move_selection(&mut self, delta: i32) {
        if self.options.is_empty() {
            return;
        }
        let count = i32::try_from(self.options.len()).unwrap_or(1);
        let current = i32::try_from(self.selected).unwrap_or(0);
        self.selected = usize::try_from((current + delta).rem_euclid(count)).unwrap_or(0);
    }

    fn apply(&mut self, index: usize) -> Outcome {
        if index >= self.options.len() {
            return Outcome::Continue;
        }
        self.selected = index;
        let priority = self.value(index);
        let ids = self.ids.clone();
        Outcome::Actions(vec![Action::SetPriority { ids, priority }])
    }

    fn rect(&self) -> ModalRect {
        geometry::resolve(self.terminal, self.width(), self.body_rows())
    }
}

impl Modal for SetPriorityModal {
    fn id(&self) -> ModalId {
        ModalId::SetPriority
    }

    fn title(&self) -> &str {
        "Set Priority"
    }

    fn width(&self) -> ModalWidth {
        ModalWidth::Cells(30)
    }

    fn body_rows(&self) -> u16 {
        u16::try_from(self.options.len()).unwrap_or(0)
    }

    fn handle_key(&mut self, key: KeyEvent) -> Outcome {
        match key.code {
            KeyCode::Esc => Outcome::Close,
            KeyCode::Up => {
                self.move_selection(-1);
                Outcome::Continue
            }
            KeyCode::Down => {
                self.move_selection(1);
                Outcome::Continue
            }
            KeyCode::Enter => self.apply(self.selected),
            _ => Outcome::Continue,
        }
    }

    fn handle_mouse(&mut self, mouse: MouseInput) -> Outcome {
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
        let base = Style::default()
            .fg(theme::FOREGROUND)
            .bg(theme::MODAL_BACKGROUND);
        let inner = Rect::new(
            rect.body.x.saturating_add(1),
            rect.body.y,
            rect.body.width.saturating_sub(2),
            rect.body.height,
        );
        for index in 0..self.options.len() {
            let y = inner
                .y
                .saturating_add(u16::try_from(index).unwrap_or(u16::MAX));
            if y >= inner.y.saturating_add(inner.height) {
                break;
            }
            let marker = if index == self.selected { "» " } else { "  " };
            let mut spans = vec![
                Span::styled(
                    format!(" {marker}"),
                    Style::default()
                        .fg(theme::SECONDARY)
                        .bg(theme::MODAL_BACKGROUND),
                ),
                Span::styled(self.label(index), base),
            ];
            if let Some(priority) = self.value(index)
                && let Some(color) = theme::priority_color(priority.as_char())
            {
                spans[1].style = base.fg(color);
            }
            frame.render_widget(
                Paragraph::new(Line::from(spans)).style(base),
                Rect::new(inner.x, y, inner.width, 1),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{PRIORITIES, SetPriorityModal};
    use crate::app::App;
    use crate::event::{MouseInput, MouseKind};
    use crate::modal::{Action, Modal, Outcome};
    use ratatui::Terminal;
    use ratatui::backend::TestBackend;
    use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    use thar_core::{Priority, Todo, TodoDate, TodoId};

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
        app.set_read_only(false);
        app
    }

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn actions(outcome: Outcome) -> Vec<Action> {
        match outcome {
            Outcome::Actions(actions) => actions,
            Outcome::Continue | Outcome::Close => {
                panic!("unexpected outcome")
            }
        }
    }

    #[test]
    fn options_are_a_to_f_and_unset_only_with_a_priority() {
        let plain = app(&["task"]);
        let modal = SetPriorityModal::new(&plain);
        assert_eq!(modal.body_rows(), 6);
        assert_eq!(modal.label(0), "A");
        assert_eq!(modal.label(5), "F");

        let prioritized = app(&["(B) task"]);
        let modal = SetPriorityModal::new(&prioritized);
        assert_eq!(modal.body_rows(), 7);
        assert_eq!(modal.label(6), "Unset");
        assert_eq!(modal.value(6), None);
    }

    #[test]
    fn up_and_down_wrap() {
        let app = app(&["task"]);
        let mut modal = SetPriorityModal::new(&app);
        modal.handle_key(key(KeyCode::Up));
        assert_eq!(modal.selected, 5);
        modal.handle_key(key(KeyCode::Down));
        assert_eq!(modal.selected, 0);
    }

    #[test]
    fn enter_applies_the_highlighted_priority() {
        let app = app(&["task"]);
        let ids = vec![app.todos()[0].id];
        let mut modal = SetPriorityModal::new(&app);
        assert_eq!(
            actions(modal.handle_key(key(KeyCode::Enter))),
            vec![Action::SetPriority {
                ids: ids.clone(),
                priority: Some(Priority::new('A').unwrap())
            }]
        );
        modal.handle_key(key(KeyCode::Down));
        modal.handle_key(key(KeyCode::Down));
        assert_eq!(
            actions(modal.handle_key(key(KeyCode::Enter))),
            vec![Action::SetPriority {
                ids,
                priority: Some(Priority::new('C').unwrap())
            }]
        );
    }

    #[test]
    fn unset_clears_the_priority() {
        let app = app(&["(B) task"]);
        let ids = vec![app.todos()[0].id];
        let mut modal = SetPriorityModal::new(&app);
        modal.handle_key(key(KeyCode::Up));
        assert_eq!(
            actions(modal.handle_key(key(KeyCode::Enter))),
            vec![Action::SetPriority {
                ids,
                priority: None
            }]
        );
    }

    #[test]
    fn escape_closes() {
        let app = app(&["task"]);
        let mut modal = SetPriorityModal::new(&app);
        assert!(matches!(
            modal.handle_key(key(KeyCode::Esc)),
            Outcome::Close
        ));
        // An unmapped key does nothing.
        assert!(matches!(
            modal.handle_key(key(KeyCode::Char('x'))),
            Outcome::Continue
        ));
    }

    #[test]
    fn mouse_rows_hover_and_click() {
        let app = app(&["task"]);
        let ids = vec![app.todos()[0].id];
        let mut modal = SetPriorityModal::new(&app);
        let rect = modal.rect();
        let x = rect.body.x + 1;
        let y = rect.body.y + 3; // body row 2 -> C
        assert!(matches!(
            modal.handle_mouse(MouseInput {
                kind: MouseKind::Move,
                x,
                y,
                shift: false
            }),
            Outcome::Continue
        ));
        assert_eq!(modal.selected, 2);
        assert_eq!(
            actions(modal.handle_mouse(MouseInput {
                kind: MouseKind::LeftClick,
                x,
                y,
                shift: false
            })),
            vec![Action::SetPriority {
                ids,
                priority: Some(Priority::new('C').unwrap())
            }]
        );
    }

    #[test]
    fn the_screen_renders_the_list_and_the_shortcut_order() {
        let mut app = app(&["(B) task"]);
        app.open_modal(crate::modal::ModalId::SetPriority);
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
        assert!(screen.contains("Set Priority"), "{screen}");
        for label in ["A", "B", "C", "D", "E", "F", "Unset"] {
            assert!(screen.contains(label), "missing {label}: {screen}");
        }
        assert!(screen.contains("» A"), "{screen}");
    }

    #[test]
    fn the_priority_table_matches_the_typescript_order() {
        assert_eq!(
            PRIORITIES,
            ['A', 'B', 'C', 'D', 'E', 'F'],
            "the modal and the inline shortcuts share one order"
        );
        assert_eq!(Priority::new('A').map(Priority::as_char), Some('A'));
    }
}
