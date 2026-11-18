//! The project/context tag editor.
//!
//! Ports `components/AddTagContextModal.tsx`:
//!
//! - the universe is the union of every todo's `+project` (or `@context`)
//!   names, sorted;
//! - each row is tri-state for the current selection: `[x]` when every selected
//!   todo has it, `[?]` for some, `[ ]` for none;
//! - Space cycles a row: `some -> add -> remove -> clear`, `all -> remove ->
//!   clear`, `none -> add -> clear`, where "clear" drops the pending change;
//! - the first row is a custom input with the `[\w.\-_]` character set,
//!   backspace deletes, and there is no cursor movement or paste;
//! - Enter applies the custom value first (when it is not empty after trimming)
//!   and then every pending change as a **separate** action, so undo history is
//!   one step for the custom value plus one per changed tag. Escape discards.
//!
//! Mouse rows follow the body layout: row 0 focuses the custom input, row 1 is
//! the separator (a no-op), and rows 2.. map to tag rows and toggle them.

use ratatui::Frame;
use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use thar_core::TodoId;

use crate::app::App;
use crate::event::{MouseInput, MouseKind};
use crate::modal::{Action, Modal, ModalId, ModalRect, ModalWidth, Outcome, TagKind, geometry};
use crate::theme;

/// Separator drawn between the custom row and the existing tags.
const SEPARATOR: &str = "───────────────────────";

/// State of one tag relative to the selection.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ItemState {
    /// Every selected todo has the tag.
    All,
    /// Some selected todos have the tag.
    Some,
    /// No selected todo has the tag.
    None,
}

impl ItemState {
    const fn checkbox(self) -> &'static str {
        match self {
            Self::All => "[x]",
            Self::Some => "[?]",
            Self::None => "[ ]",
        }
    }
}

/// A pending change from the tri-state cycle.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Change {
    Add,
    Remove,
}

/// One tag in the universe.
#[derive(Clone, Debug, PartialEq, Eq)]
struct TagItem {
    name: String,
    state: ItemState,
}

/// The `Modify Projects` / `Modify Contexts` screen.
pub(crate) struct TagModal {
    kind: TagKind,
    ids: Vec<TodoId>,
    items: Vec<TagItem>,
    pending: Vec<(String, Change)>,
    selected: usize,
    custom: String,
    terminal: Rect,
}

impl TagModal {
    /// Build the universe and the per-row state from the current selection.
    pub(crate) fn new(app: &App, kind: TagKind) -> Self {
        let selected = app.selected_todos();
        let ids: Vec<TodoId> = selected.iter().map(|todo| todo.id).collect();

        let mut names: Vec<String> = Vec::new();
        for todo in app.todos().iter() {
            let tags = match kind {
                TagKind::Project => &todo.projects,
                TagKind::Context => &todo.contexts,
            };
            for name in tags {
                if !names.iter().any(|existing| existing == name) {
                    names.push(name.clone());
                }
            }
        }
        names.sort();

        let items = names
            .into_iter()
            .map(|name| {
                let count = selected
                    .iter()
                    .filter(|todo| match kind {
                        TagKind::Project => todo.projects.contains(&name),
                        TagKind::Context => todo.contexts.contains(&name),
                    })
                    .count();
                let state = if count == selected.len() {
                    ItemState::All
                } else if count > 0 {
                    ItemState::Some
                } else {
                    ItemState::None
                };
                TagItem { name, state }
            })
            .collect();

        Self {
            kind,
            ids,
            items,
            pending: Vec::new(),
            selected: 0,
            custom: String::new(),
            terminal: Rect::new(0, 0, app.width(), app.height()),
        }
    }

    /// The title shown on the top border.
    const fn heading(&self) -> &'static str {
        match self.kind {
            TagKind::Project => "Modify Projects",
            TagKind::Context => "Modify Contexts",
        }
    }

    /// The `+`/`@` marker for the custom row.
    const fn prefix(&self) -> char {
        match self.kind {
            TagKind::Project => '+',
            TagKind::Context => '@',
        }
    }

    /// Number of selectable rows, including the custom row.
    fn option_count(&self) -> usize {
        self.items.len() + 1
    }

    /// The pending change for a name.
    fn pending(&self, name: &str) -> Option<Change> {
        self.pending
            .iter()
            .find(|(existing, _)| existing == name)
            .map(|(_, change)| *change)
    }

    /// Store or drop a pending change, keeping first-insertion order.
    fn set_pending(&mut self, name: &str, change: Option<Change>) {
        match change {
            None => self.pending.retain(|(existing, _)| existing != name),
            Some(change) => {
                if let Some(slot) = self
                    .pending
                    .iter_mut()
                    .find(|(existing, _)| existing == name)
                {
                    slot.1 = change;
                } else {
                    self.pending.push((name.to_owned(), change));
                }
            }
        }
    }

    /// The visual state of a row after pending changes.
    fn visual_state(&self, item: &TagItem) -> ItemState {
        match self.pending(&item.name) {
            Some(Change::Add) => ItemState::All,
            Some(Change::Remove) => ItemState::None,
            None => item.state,
        }
    }

    /// Apply one tri-state cycle to the tag at `index` (0-based tag index).
    fn toggle(&mut self, index: usize) {
        let Some(item) = self.items.get(index).cloned() else {
            return;
        };
        let current = self.pending(&item.name);
        let next = match item.state {
            ItemState::Some => match current {
                None => Some(Change::Add),
                Some(Change::Add) => Some(Change::Remove),
                Some(Change::Remove) => None,
            },
            ItemState::All => match current {
                None => Some(Change::Remove),
                _ => None,
            },
            ItemState::None => match current {
                None => Some(Change::Add),
                _ => None,
            },
        };
        self.set_pending(&item.name, next);
    }

    fn move_selection(&mut self, delta: i32) {
        let count = self.option_count();
        if count == 0 {
            return;
        }
        let count = i32::try_from(count).unwrap_or(1);
        let current = i32::try_from(self.selected).unwrap_or(0);
        self.selected = usize::try_from((current + delta).rem_euclid(count)).unwrap_or(0);
    }

    /// Apply the custom value first, then each pending change as its own action.
    fn apply(&self) -> Outcome {
        if self.ids.is_empty() {
            return Outcome::Close;
        }

        let mut actions = Vec::new();
        let custom = self.custom.trim();
        if !custom.is_empty() {
            actions.push(Action::AddTag {
                ids: self.ids.clone(),
                kind: self.kind,
                name: custom.to_owned(),
            });
        }
        for (name, change) in &self.pending {
            actions.push(match change {
                Change::Add => Action::AddTag {
                    ids: self.ids.clone(),
                    kind: self.kind,
                    name: name.clone(),
                },
                Change::Remove => Action::RemoveTag {
                    ids: self.ids.clone(),
                    kind: self.kind,
                    name: name.clone(),
                },
            });
        }

        if actions.is_empty() {
            Outcome::Close
        } else {
            Outcome::Actions(actions)
        }
    }

    fn rect(&self) -> ModalRect {
        geometry::resolve(self.terminal, self.width(), self.body_rows())
    }

    /// True for a character the custom input accepts (`[\w.\-_]`, ASCII `\w`).
    fn is_name_char(character: char) -> bool {
        character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | '-')
    }
}

impl Modal for TagModal {
    fn id(&self) -> ModalId {
        match self.kind {
            TagKind::Project => ModalId::AddProject,
            TagKind::Context => ModalId::AddContext,
        }
    }

    fn title(&self) -> &str {
        self.heading()
    }

    fn width(&self) -> ModalWidth {
        ModalWidth::Cells(40)
    }

    fn body_rows(&self) -> u16 {
        if self.items.is_empty() {
            2
        } else {
            u16::try_from(self.items.len() + 2).unwrap_or(u16::MAX)
        }
    }

    fn handle_key(&mut self, key: KeyEvent) -> Outcome {
        let ctrl_or_alt = key
            .modifiers
            .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT | KeyModifiers::META);

        match key.code {
            KeyCode::Esc => Outcome::Close,
            KeyCode::Enter => self.apply(),
            KeyCode::Up => {
                self.move_selection(-1);
                Outcome::Continue
            }
            KeyCode::Down => {
                self.move_selection(1);
                Outcome::Continue
            }
            KeyCode::Backspace | KeyCode::Delete if self.selected == 0 => {
                self.custom.pop();
                Outcome::Continue
            }
            KeyCode::Char(' ') if self.selected != 0 => {
                self.toggle(self.selected - 1);
                Outcome::Continue
            }
            KeyCode::Char(character)
                if self.selected == 0 && !ctrl_or_alt && Self::is_name_char(character) =>
            {
                self.custom.push(character);
                Outcome::Continue
            }
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
        if mouse.kind != MouseKind::LeftClick {
            return Outcome::Continue;
        }

        match usize::from(row) {
            0 => self.selected = 0,
            1 => {}
            _row if self.items.is_empty() => {}
            row => {
                let option = row - 1;
                if option >= self.option_count() {
                    return Outcome::Continue;
                }
                self.selected = option;
                self.toggle(option - 1);
            }
        }
        Outcome::Continue
    }

    fn render(&self, frame: &mut Frame, rect: ModalRect) {
        let base = Style::default()
            .fg(theme::FOREGROUND)
            .bg(theme::MODAL_BACKGROUND);
        let body = Rect::new(
            rect.body.x.saturating_add(1),
            rect.body.y,
            rect.body.width.saturating_sub(2),
            rect.body.height,
        );
        let secondary = Style::default()
            .fg(theme::SECONDARY)
            .bg(theme::MODAL_BACKGROUND);
        let dim = base.fg(theme::MUTED).add_modifier(Modifier::DIM);

        let mut row = 0_u16;
        // Custom input row.
        let marker = if self.selected == 0 { "» " } else { "  " };
        let input = if self.custom.is_empty() {
            " ".to_owned()
        } else {
            self.custom.clone()
        };
        let input_style = if self.selected == 0 {
            Style::default()
                .fg(theme::INVERSE_FOREGROUND)
                .bg(theme::SUCCESS)
        } else {
            base
        };
        let line = Line::from(vec![
            Span::styled(format!(" {marker}"), secondary),
            Span::styled("New:", base),
            Span::styled(
                self.prefix().to_string(),
                Style::default().fg(theme::INFO).bg(theme::MODAL_BACKGROUND),
            ),
            Span::styled(input, input_style),
        ]);
        frame.render_widget(Paragraph::new(line).style(base), self.row_area(body, row));
        row = row.saturating_add(1);

        if self.items.is_empty() {
            frame.render_widget(
                Paragraph::new(Span::styled(
                    format!(
                        " No existing {}s",
                        match self.kind {
                            TagKind::Project => "project",
                            TagKind::Context => "context",
                        }
                    ),
                    dim,
                ))
                .style(dim),
                self.row_area(body, row),
            );
            return;
        }

        frame.render_widget(
            Paragraph::new(Span::styled(format!(" {SEPARATOR}"), dim)).style(dim),
            self.row_area(body, row),
        );
        row = row.saturating_add(1);

        for (index, item) in self.items.iter().enumerate() {
            let selected = self.selected == index + 1;
            let marker = if selected { "» " } else { "  " };
            let state = self.visual_state(item);
            let checkbox_style = match state {
                ItemState::All => base.fg(theme::SUCCESS),
                ItemState::Some => base.fg(theme::WARNING),
                ItemState::None => base.fg(theme::MUTED),
            };
            let line = Line::from(vec![
                Span::styled(format!(" {marker}"), secondary),
                Span::styled(
                    format!("{} {}", state.checkbox(), item.name),
                    checkbox_style,
                ),
            ]);
            frame.render_widget(Paragraph::new(line).style(base), self.row_area(body, row));
            row = row.saturating_add(1);
        }
    }
}

impl TagModal {
    /// One body row rectangle inside the modal border.
    fn row_area(&self, body: Rect, row: u16) -> Rect {
        Rect::new(body.x, body.y.saturating_add(row), body.width, 1)
    }
}

#[cfg(test)]
mod tests {
    use super::{Change, ItemState, TagModal};
    use crate::app::App;
    use crate::event::{MouseInput, MouseKind};
    use crate::modal::{Action, Modal, ModalId, Outcome, TagKind};
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
        app.set_read_only(false);
        app
    }

    fn select_all(app: &mut App) {
        app.set_range(app.todos().iter().map(|todo| todo.id).collect());
    }

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn now() -> Instant {
        Instant::now()
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
    fn the_universe_is_sorted_and_the_state_is_tri_state() {
        let mut app = app(&["one +work", "two +work +personal"]);
        select_all(&mut app);
        let modal = TagModal::new(&app, TagKind::Project);
        assert_eq!(
            modal.items,
            vec![
                super::TagItem {
                    name: "personal".to_owned(),
                    state: ItemState::Some
                },
                super::TagItem {
                    name: "work".to_owned(),
                    state: ItemState::All
                },
            ]
        );
        assert_eq!(modal.body_rows(), 4);
        assert_eq!(modal.title(), "Modify Projects");
        assert_eq!(modal.prefix(), '+');
        assert_eq!(modal.option_count(), 3);

        let contexts = TagModal::new(&app, TagKind::Context);
        assert!(contexts.items.is_empty());
        assert_eq!(contexts.body_rows(), 2);
        assert_eq!(contexts.title(), "Modify Contexts");
        assert_eq!(contexts.id(), ModalId::AddContext);
    }

    #[test]
    fn some_cycles_add_remove_clear() {
        let mut app = app(&["one +work", "two +work +personal"]);
        select_all(&mut app);
        let mut modal = TagModal::new(&app, TagKind::Project);
        // Index 0 is "personal" (Some).
        assert_eq!(modal.items[0].state, ItemState::Some);

        modal.toggle(0);
        assert_eq!(modal.pending("personal"), Some(Change::Add));
        assert_eq!(modal.visual_state(&modal.items[0]), ItemState::All);

        modal.toggle(0);
        assert_eq!(modal.pending("personal"), Some(Change::Remove));
        assert_eq!(modal.visual_state(&modal.items[0]), ItemState::None);

        modal.toggle(0);
        assert_eq!(modal.pending("personal"), None);
        assert_eq!(modal.visual_state(&modal.items[0]), ItemState::Some);
    }

    #[test]
    fn all_and_none_cycle_once_then_clear() {
        let mut first = app(&["one +work", "two +work +personal"]);
        select_all(&mut first);
        let mut modal = TagModal::new(&first, TagKind::Project);

        // "work" is All: remove, then clear back to All.
        modal.toggle(1);
        assert_eq!(modal.pending("work"), Some(Change::Remove));
        assert_eq!(modal.visual_state(&modal.items[1]), ItemState::None);
        modal.toggle(1);
        assert_eq!(modal.pending("work"), None);
        assert_eq!(modal.visual_state(&modal.items[1]), ItemState::All);

        // A tag nobody selected has is None: add, then clear back to None.
        let mut second = app(&["one", "two +other"]);
        second.set_range(vec![second.todos()[0].id]);
        let mut modal = TagModal::new(&second, TagKind::Project);
        modal.toggle(0);
        assert_eq!(modal.pending("other"), Some(Change::Add));
        assert_eq!(modal.visual_state(&modal.items[0]), ItemState::All);
        modal.toggle(0);
        assert_eq!(modal.pending("other"), None);
        assert_eq!(modal.visual_state(&modal.items[0]), ItemState::None);
    }

    #[test]
    fn enter_applies_custom_first_and_each_change_as_its_own_action() {
        let mut app = app(&["one +work", "two +work +personal"]);
        select_all(&mut app);
        let ids: Vec<TodoId> = app.todos().iter().map(|todo| todo.id).collect();
        let mut modal = TagModal::new(&app, TagKind::Project);

        // New project at the custom row.
        for character in "newproj".chars() {
            modal.handle_key(key(KeyCode::Char(character)));
        }
        // Remove "work" (All) and add "personal" (Some).
        modal.selected = 2;
        modal.handle_key(key(KeyCode::Char(' ')));
        modal.selected = 1;
        modal.handle_key(key(KeyCode::Char(' ')));

        let applied = actions(modal.handle_key(key(KeyCode::Enter)));
        assert_eq!(
            applied,
            vec![
                Action::AddTag {
                    ids: ids.clone(),
                    kind: TagKind::Project,
                    name: "newproj".to_owned()
                },
                Action::RemoveTag {
                    ids: ids.clone(),
                    kind: TagKind::Project,
                    name: "work".to_owned()
                },
                Action::AddTag {
                    ids,
                    kind: TagKind::Project,
                    name: "personal".to_owned()
                },
            ]
        );
    }

    #[test]
    fn an_empty_enter_closes_without_actions() {
        let app = app(&["one +work"]);
        let mut modal = TagModal::new(&app, TagKind::Project);
        assert!(matches!(
            modal.handle_key(key(KeyCode::Enter)),
            Outcome::Close
        ));
        // Whitespace-only custom input is trimmed away.
        for character in "   ".chars() {
            modal.handle_key(key(KeyCode::Char(character)));
        }
        assert!(matches!(
            modal.handle_key(key(KeyCode::Enter)),
            Outcome::Close
        ));
    }

    #[test]
    fn the_custom_input_enforces_its_character_set_and_backspace() {
        let app = app(&["one"]);
        let mut modal = TagModal::new(&app, TagKind::Project);
        for character in "a_b.c-D!@ +".chars() {
            modal.handle_key(key(KeyCode::Char(character)));
        }
        assert_eq!(modal.custom, "a_b.c-D");
        modal.handle_key(key(KeyCode::Backspace));
        assert_eq!(modal.custom, "a_b.c-");
        modal.handle_key(key(KeyCode::Delete));
        assert_eq!(modal.custom, "a_b.c");
        // Up/Down still move the selection away from the custom row.
        modal.handle_key(key(KeyCode::Down));
        assert_eq!(modal.selected, 0);
        assert_eq!(modal.custom, "a_b.c");
        // A ctrl-modified character is not typed.
        modal.handle_key(KeyEvent::new(KeyCode::Char('z'), KeyModifiers::CONTROL));
        assert_eq!(modal.custom, "a_b.c");
    }

    #[test]
    fn up_and_down_wrap_across_the_custom_row() {
        let app = app(&["one +work +personal"]);
        let mut modal = TagModal::new(&app, TagKind::Project);
        assert_eq!(modal.selected, 0);
        modal.handle_key(key(KeyCode::Up));
        assert_eq!(modal.selected, 2);
        modal.handle_key(key(KeyCode::Down));
        assert_eq!(modal.selected, 0);
        modal.handle_key(key(KeyCode::Down));
        assert_eq!(modal.selected, 1);
    }

    #[test]
    fn escape_discards_pending_changes() {
        let app = app(&["one +work"]);
        let mut modal = TagModal::new(&app, TagKind::Project);
        modal.handle_key(key(KeyCode::Down));
        modal.handle_key(key(KeyCode::Char(' ')));
        modal.handle_key(key(KeyCode::Char('x')));
        assert!(matches!(
            modal.handle_key(key(KeyCode::Esc)),
            Outcome::Close
        ));
        assert_eq!(modal.pending.len(), 1, "the modal discards on close");
    }

    #[test]
    fn mouse_rows_focus_custom_skip_the_separator_and_toggle_tags() {
        let app = app(&["one +work", "two +work +personal"]);
        let mut modal = TagModal::new(&app, TagKind::Project);
        let rect = modal.rect();
        let x = rect.body.x + 1;
        let click = |y: u16| MouseInput {
            kind: MouseKind::LeftClick,
            x,
            y,
            shift: false,
        };

        // Body row 0 focuses the custom input.
        modal.selected = 1;
        modal.handle_mouse(click(rect.body.y + 1));
        assert_eq!(modal.selected, 0);

        // Body row 1 is the separator and changes nothing.
        modal.handle_mouse(click(rect.body.y + 2));
        assert_eq!(modal.selected, 0);
        assert!(modal.pending.is_empty());

        // Body row 2 is the first tag ("personal", Some) -> add.
        modal.handle_mouse(click(rect.body.y + 3));
        assert_eq!(modal.selected, 1);
        assert_eq!(modal.pending("personal"), Some(Change::Add));

        // Body row 3 is "work" (All) -> remove.
        modal.handle_mouse(click(rect.body.y + 4));
        assert_eq!(modal.selected, 2);
        assert_eq!(modal.pending("work"), Some(Change::Remove));

        // A row past the last tag is ignored.
        modal.handle_mouse(click(rect.body.y + 6));
        assert_eq!(modal.selected, 2);
    }

    #[test]
    fn history_groups_one_step_per_applied_action() {
        let mut app = app(&["one +work", "two +work +personal"]);
        select_all(&mut app);
        let before: Vec<String> = app.todos().iter().map(|todo| todo.to_string()).collect();
        app.open_modal(ModalId::AddProject);

        // Custom "newproj" is typed at the custom row.
        for character in "newproj".chars() {
            app.handle_modal_key(key(KeyCode::Char(character)), now());
        }
        // personal: Some -> add (body row 2, selection starts at custom).
        app.handle_modal_key(key(KeyCode::Down), now()); // personal
        app.handle_modal_key(key(KeyCode::Char(' ')), now());
        app.handle_modal_key(key(KeyCode::Down), now()); // work
        app.handle_modal_key(key(KeyCode::Char(' ')), now()); // All -> remove
        assert_eq!(app.undo_len(), 0);

        assert!(app.handle_modal_key(key(KeyCode::Enter), now()));
        assert!(!app.modals().is_open());
        // One undo step for the custom value plus one per pending change.
        assert_eq!(app.undo_len(), 3);

        assert!(app.todos()[0].projects.contains(&"newproj".to_owned()));
        assert!(app.todos()[1].projects.contains(&"newproj".to_owned()));
        assert!(!app.todos()[0].projects.contains(&"work".to_owned()));
        assert!(!app.todos()[1].projects.contains(&"work".to_owned()));
        assert!(app.todos()[1].projects.contains(&"personal".to_owned()));

        for _ in 0..3 {
            assert!(app.undo(now()));
        }
        let after: Vec<String> = app.todos().iter().map(|todo| todo.to_string()).collect();
        assert_eq!(after, before);
    }

    #[test]
    fn a_context_editor_changes_contexts_only() {
        let mut app = app(&["one @home +work"]);
        app.open_modal(ModalId::AddContext);
        for character in "office".chars() {
            app.handle_modal_key(key(KeyCode::Char(character)), now());
        }
        app.handle_modal_key(key(KeyCode::Enter), now());
        assert!(app.todos()[0].contexts.contains(&"office".to_owned()));
        assert!(app.todos()[0].projects.contains(&"work".to_owned()));
    }

    #[test]
    fn the_screen_renders_the_custom_row_separator_and_tags() {
        let mut app = app(&["one +work", "two +work +personal"]);
        select_all(&mut app);
        app.open_modal(ModalId::AddProject);
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
        assert!(screen.contains("Modify Projects"), "{screen}");
        assert!(screen.contains("New:"), "{screen}");
        assert!(screen.contains(super::SEPARATOR), "{screen}");
        assert!(screen.contains("[?] personal"), "{screen}");
        assert!(screen.contains("[x] work"), "{screen}");
    }

    #[test]
    fn an_empty_universe_renders_the_hint() {
        let app = app(&["one"]);
        let mut modal = TagModal::new(&app, TagKind::Project);
        modal.handle_key(key(KeyCode::Down));
        assert!(matches!(
            modal.handle_key(key(KeyCode::Enter)),
            Outcome::Close
        ));
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
        assert!(screen.contains("No existing projects"), "{screen}");
    }
}
