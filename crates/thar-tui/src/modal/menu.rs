//! The single-todo and multi-select command menus.
//!
//! Both menus are the same widget over one of two item tables ported from
//! `components/TodoMenu.tsx`. The labels, shortcuts and ordering are part of
//! the contract: the list keymap, the menu dispatch and the screenshot all read
//! this table, so a shortcut cannot drift from the row it renders.
//!
//! Keyboard rules (from `useListSelection`):
//! - Up/Down move the marker and wrap at both ends.
//! - Enter activates the highlighted row.
//! - Escape closes the menu.
//! - A displayed shortcut dispatches immediately, including `space` and `del`.
//! - Return and Escape are named keys, never literal shortcuts.
//!
//! Mouse rules (from `useModalMouseList`): a move over a body row moves the
//! marker and a left click on a body row activates it.

use ratatui::Frame;
use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use thar_core::TodoId;

use crate::event::MouseInput;
use crate::modal::confirm::ConfirmRequest;
use crate::modal::geometry::{self, ModalRect, ModalWidth};
use crate::modal::{Action, Modal, ModalId, Outcome};
use crate::theme;

/// One action a menu can request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MenuAction {
    /// Edit the cursor todo's text.
    Edit,
    /// Delete the selected todos after a confirmation.
    Delete,
    /// Flip open/done.
    Toggle,
    /// Open the due-date screen.
    Due,
    /// Open the threshold-date screen.
    Threshold,
    /// Open the recurrence screen.
    Recurrence,
    /// Open the priority screen.
    Priority,
    /// Open the add-project screen.
    AddProject,
    /// Open the add-context screen.
    AddContext,
    /// Flip the `h:` tag.
    ToggleHidden,
    /// Include or exclude hidden todos.
    ToggleHiddenView,
    /// Archive completed todos after a confirmation.
    Archive,
    /// Copy the selected todos.
    Copy,
    /// Undo one mutation.
    Undo,
    /// Redo one undo.
    Redo,
    /// Paste the clipboard.
    Paste,
}

/// One rendered menu row.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MenuItem {
    /// Row label.
    pub label: &'static str,
    /// Shortcut as displayed (`"e"`, `"space"`, `"del"`, `"H"`).
    pub shortcut: &'static str,
    /// Action this row dispatches.
    pub action: MenuAction,
}

/// The single-todo menu, in `TodoMenu.tsx` order.
pub const MENU_ITEMS: [MenuItem; 16] = [
    MenuItem {
        label: "Edit",
        shortcut: "e",
        action: MenuAction::Edit,
    },
    MenuItem {
        label: "Delete",
        shortcut: "del",
        action: MenuAction::Delete,
    },
    MenuItem {
        label: "Toggle Complete",
        shortcut: "space",
        action: MenuAction::Toggle,
    },
    MenuItem {
        label: "Set Due Date",
        shortcut: "d",
        action: MenuAction::Due,
    },
    MenuItem {
        label: "Set Threshold Date",
        shortcut: "t",
        action: MenuAction::Threshold,
    },
    MenuItem {
        label: "Set Recurrence",
        shortcut: "r",
        action: MenuAction::Recurrence,
    },
    MenuItem {
        label: "Set Priority",
        shortcut: "p",
        action: MenuAction::Priority,
    },
    MenuItem {
        label: "Modify Projects",
        shortcut: "+",
        action: MenuAction::AddProject,
    },
    MenuItem {
        label: "Modify Contexts",
        shortcut: "@",
        action: MenuAction::AddContext,
    },
    MenuItem {
        label: "Toggle Hidden",
        shortcut: "h",
        action: MenuAction::ToggleHidden,
    },
    MenuItem {
        label: "Show/Hide Hidden",
        shortcut: "H",
        action: MenuAction::ToggleHiddenView,
    },
    MenuItem {
        label: "Archive Completed",
        shortcut: "a",
        action: MenuAction::Archive,
    },
    MenuItem {
        label: "Copy",
        shortcut: "c",
        action: MenuAction::Copy,
    },
    MenuItem {
        label: "Undo",
        shortcut: "z",
        action: MenuAction::Undo,
    },
    MenuItem {
        label: "Redo",
        shortcut: "Z",
        action: MenuAction::Redo,
    },
    MenuItem {
        label: "Paste",
        shortcut: "v",
        action: MenuAction::Paste,
    },
];

/// The range-selection menu, in `TodoMenu.tsx` order.
///
/// Edit and the global commands (show/hide hidden, archive, undo, redo, paste)
/// stay in the single-todo menu, matching the Ink table.
pub const MULTI_SELECT_MENU_ITEMS: [MenuItem; 10] = [
    MenuItem {
        label: "Delete",
        shortcut: "del",
        action: MenuAction::Delete,
    },
    MenuItem {
        label: "Toggle Complete",
        shortcut: "space",
        action: MenuAction::Toggle,
    },
    MenuItem {
        label: "Set Due Date",
        shortcut: "d",
        action: MenuAction::Due,
    },
    MenuItem {
        label: "Set Threshold Date",
        shortcut: "t",
        action: MenuAction::Threshold,
    },
    MenuItem {
        label: "Set Recurrence",
        shortcut: "r",
        action: MenuAction::Recurrence,
    },
    MenuItem {
        label: "Set Priority",
        shortcut: "p",
        action: MenuAction::Priority,
    },
    MenuItem {
        label: "Modify Projects",
        shortcut: "+",
        action: MenuAction::AddProject,
    },
    MenuItem {
        label: "Modify Contexts",
        shortcut: "@",
        action: MenuAction::AddContext,
    },
    MenuItem {
        label: "Toggle Hidden",
        shortcut: "h",
        action: MenuAction::ToggleHidden,
    },
    MenuItem {
        label: "Copy",
        shortcut: "c",
        action: MenuAction::Copy,
    },
];

/// True when `key` is the displayed shortcut for `item`.
///
/// Only an unmodified character key (Shift allowed, for `H`/`Z`), `space`, or
/// the named `Delete` key matches. Return and Escape are named keys owned by
/// the list, so they never fall through here.
fn matches_shortcut(item: MenuItem, key: KeyEvent) -> bool {
    let modified = key
        .modifiers
        .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT | KeyModifiers::META);

    match item.shortcut {
        "del" => key.code == KeyCode::Delete,
        "space" => !modified && key.code == KeyCode::Char(' '),
        label => {
            !modified
                && matches!(key.code, KeyCode::Char(character) if character.to_string() == label)
        }
    }
}

/// Index of the item a key dispatches, if any.
fn shortcut_index(items: &[MenuItem], key: KeyEvent) -> Option<usize> {
    items.iter().position(|item| matches_shortcut(*item, key))
}

/// The two menu variants.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MenuKind {
    /// The single-todo menu.
    Single,
    /// The range-selection menu.
    MultiSelect,
}

impl MenuKind {
    /// The item table for this kind.
    #[must_use]
    pub const fn items(self) -> &'static [MenuItem] {
        match self {
            Self::Single => &MENU_ITEMS,
            Self::MultiSelect => &MULTI_SELECT_MENU_ITEMS,
        }
    }

    /// The title drawn on the modal border.
    #[must_use]
    pub const fn title(self) -> &'static str {
        match self {
            Self::Single => "Todo menu",
            Self::MultiSelect => "Multi-select menu",
        }
    }
}

/// The command-menu screen.
pub struct Menu {
    kind: MenuKind,
    ids: Vec<TodoId>,
    selected: usize,
    terminal_width: u16,
    terminal_height: u16,
}

impl Menu {
    /// A menu over `ids`, sized for the terminal it will open in.
    #[must_use]
    pub fn new(
        kind: MenuKind,
        ids: Vec<TodoId>,
        terminal_width: u16,
        terminal_height: u16,
    ) -> Self {
        Self {
            kind,
            ids,
            selected: 0,
            terminal_width,
            terminal_height,
        }
    }

    /// The single-todo menu over `ids`.
    #[must_use]
    pub fn single(ids: Vec<TodoId>, terminal_width: u16, terminal_height: u16) -> Self {
        Self::new(MenuKind::Single, ids, terminal_width, terminal_height)
    }

    /// The multi-select menu over `ids`.
    #[must_use]
    pub fn multi(ids: Vec<TodoId>, terminal_width: u16, terminal_height: u16) -> Self {
        Self::new(MenuKind::MultiSelect, ids, terminal_width, terminal_height)
    }

    fn items(&self) -> &'static [MenuItem] {
        self.kind.items()
    }

    /// The highlighted row.
    #[must_use]
    pub fn selected(&self) -> usize {
        self.selected
    }

    fn geometry(&self) -> ModalRect {
        geometry::resolve(
            Rect::new(0, 0, self.terminal_width, self.terminal_height),
            self.width(),
            self.body_rows(),
        )
    }

    fn move_down(&mut self) {
        let len = self.items().len();
        if len > 0 {
            self.selected = (self.selected + 1) % len;
        }
    }

    fn move_up(&mut self) {
        let len = self.items().len();
        if len > 0 {
            self.selected = (self.selected + len - 1) % len;
        }
    }

    /// Build the action for one row.
    fn action_for(&self, action: MenuAction) -> Action {
        let ids = || self.ids.clone();
        match action {
            MenuAction::Edit => Action::Open(ModalId::EditTodo),
            MenuAction::Delete => Action::Confirm(ConfirmRequest::delete(ids())),
            MenuAction::Toggle => Action::Toggle { ids: ids() },
            MenuAction::Due => Action::Open(ModalId::SetDueDate),
            MenuAction::Threshold => Action::Open(ModalId::SetThresholdDate),
            MenuAction::Recurrence => Action::Open(ModalId::SetRecurrence),
            MenuAction::Priority => Action::Open(ModalId::SetPriority),
            MenuAction::AddProject => Action::Open(ModalId::AddProject),
            MenuAction::AddContext => Action::Open(ModalId::AddContext),
            MenuAction::ToggleHidden => Action::ToggleHidden { ids: ids() },
            MenuAction::ToggleHiddenView => Action::ToggleHiddenView,
            MenuAction::Archive => Action::Confirm(ConfirmRequest::archive()),
            MenuAction::Copy => Action::Copy { ids: ids() },
            MenuAction::Undo => Action::Undo,
            MenuAction::Redo => Action::Redo,
            MenuAction::Paste => Action::Paste,
        }
    }

    fn activate(&self, index: usize) -> Outcome {
        match self.items().get(index) {
            Some(item) => Outcome::Actions(vec![self.action_for(item.action)]),
            None => Outcome::Continue,
        }
    }
}

impl Modal for Menu {
    fn id(&self) -> ModalId {
        match self.kind {
            MenuKind::Single => ModalId::TodoMenu,
            MenuKind::MultiSelect => ModalId::MultiSelectMenu,
        }
    }

    fn title(&self) -> &str {
        self.kind.title()
    }

    fn width(&self) -> ModalWidth {
        ModalWidth::Percent(50)
    }

    fn body_rows(&self) -> u16 {
        u16::try_from(self.items().len()).unwrap_or(u16::MAX)
    }

    fn resize(&mut self, width: u16, height: u16) {
        self.terminal_width = width;
        self.terminal_height = height;
    }

    fn handle_key(&mut self, key: KeyEvent) -> Outcome {
        match key.code {
            KeyCode::Esc => return Outcome::Close,
            KeyCode::Up => {
                self.move_up();
                return Outcome::Continue;
            }
            KeyCode::Down => {
                self.move_down();
                return Outcome::Continue;
            }
            KeyCode::Enter => return self.activate(self.selected),
            _ => {}
        }

        if let Some(index) = shortcut_index(self.items(), key) {
            self.selected = index;
            return self.activate(index);
        }
        Outcome::Continue
    }

    fn handle_mouse(&mut self, mouse: MouseInput) -> Outcome {
        let rect = self.geometry();
        let Some(row) = geometry::body_row(rect, mouse) else {
            return Outcome::Continue;
        };
        let index = usize::from(row);
        if index >= self.items().len() {
            return Outcome::Continue;
        }

        match mouse.kind {
            crate::event::MouseKind::Move => {
                self.selected = index;
                Outcome::Continue
            }
            crate::event::MouseKind::LeftClick => {
                self.selected = index;
                self.activate(index)
            }
            _ => Outcome::Continue,
        }
    }

    fn render(&self, frame: &mut Frame, rect: ModalRect) {
        let items = self.items();
        let base = Style::default()
            .fg(theme::FOREGROUND)
            .bg(theme::MODAL_BACKGROUND);
        let content_x = rect.body.x.saturating_add(1);
        let content_right = rect
            .body
            .x
            .saturating_add(rect.body.width)
            .saturating_sub(2);
        let content_width = usize::from(content_right.saturating_sub(content_x));

        for (index, item) in items.iter().enumerate() {
            let offset = u16::try_from(index).unwrap_or(u16::MAX);
            if offset >= rect.body.height {
                break;
            }
            let y = rect.body.y.saturating_add(offset);
            let area = Rect::new(content_x, y, u16::try_from(content_width).unwrap_or(0), 1);

            let marker = if index == self.selected { "» " } else { "  " };
            let label_width = item.label.chars().count();
            let shortcut_width = item.shortcut.chars().count();
            let gap = content_width.saturating_sub(2 + label_width + shortcut_width);

            let selected = index == self.selected;
            let mut spans = vec![
                Span::styled(marker, base.fg(theme::SECONDARY)),
                Span::styled(
                    item.label,
                    if selected {
                        base.add_modifier(Modifier::BOLD)
                    } else {
                        base
                    },
                ),
            ];
            if gap > 0 {
                spans.push(Span::raw(" ".repeat(gap)));
            }
            spans.push(Span::styled(item.shortcut, base.fg(theme::PRIMARY)));

            frame.render_widget(Paragraph::new(Line::from(spans)), area);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{MENU_ITEMS, MULTI_SELECT_MENU_ITEMS, Menu, MenuAction, MenuKind, shortcut_index};
    use crate::event::{MouseInput, MouseKind};
    use crate::modal::{Action, Modal, ModalId, Outcome};
    use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    use thar_core::TodoId;

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn single() -> Menu {
        Menu::single(vec![TodoId::new(1)], 100, 30)
    }

    fn action_of(outcome: Outcome) -> Action {
        match outcome {
            Outcome::Actions(actions) => actions.into_iter().next().expect("one action"),
            _ => panic!("expected one action"),
        }
    }

    #[test]
    fn the_single_menu_table_is_the_ink_table() {
        let table: Vec<(&str, &str, MenuAction)> = MENU_ITEMS
            .iter()
            .map(|item| (item.label, item.shortcut, item.action))
            .collect();
        assert_eq!(
            table,
            [
                ("Edit", "e", MenuAction::Edit),
                ("Delete", "del", MenuAction::Delete),
                ("Toggle Complete", "space", MenuAction::Toggle),
                ("Set Due Date", "d", MenuAction::Due),
                ("Set Threshold Date", "t", MenuAction::Threshold),
                ("Set Recurrence", "r", MenuAction::Recurrence),
                ("Set Priority", "p", MenuAction::Priority),
                ("Modify Projects", "+", MenuAction::AddProject),
                ("Modify Contexts", "@", MenuAction::AddContext),
                ("Toggle Hidden", "h", MenuAction::ToggleHidden),
                ("Show/Hide Hidden", "H", MenuAction::ToggleHiddenView),
                ("Archive Completed", "a", MenuAction::Archive),
                ("Copy", "c", MenuAction::Copy),
                ("Undo", "z", MenuAction::Undo),
                ("Redo", "Z", MenuAction::Redo),
                ("Paste", "v", MenuAction::Paste),
            ]
        );
    }

    #[test]
    fn the_multi_select_table_is_the_ink_table() {
        assert_eq!(
            MULTI_SELECT_MENU_ITEMS
                .iter()
                .map(|item| item.action)
                .collect::<Vec<_>>(),
            [
                MenuAction::Delete,
                MenuAction::Toggle,
                MenuAction::Due,
                MenuAction::Threshold,
                MenuAction::Recurrence,
                MenuAction::Priority,
                MenuAction::AddProject,
                MenuAction::AddContext,
                MenuAction::ToggleHidden,
                MenuAction::Copy,
            ]
        );
        for item in MULTI_SELECT_MENU_ITEMS {
            assert!(
                !matches!(
                    item.action,
                    MenuAction::Edit
                        | MenuAction::Archive
                        | MenuAction::ToggleHiddenView
                        | MenuAction::Undo
                        | MenuAction::Redo
                        | MenuAction::Paste
                ),
                "{} must stay in the single-todo menu",
                item.label
            );
        }
    }

    #[test]
    fn every_displayed_shortcut_dispatches_its_action() {
        for item in MENU_ITEMS {
            let key = match item.shortcut {
                "del" => key(KeyCode::Delete),
                "space" => key(KeyCode::Char(' ')),
                label => key(KeyCode::Char(label.chars().next().expect("one char"))),
            };
            let mut menu = single();
            assert_eq!(
                action_of(menu.handle_key(key)),
                menu.action_for(item.action),
                "shortcut {} should dispatch {:?}",
                item.shortcut,
                item.action
            );
        }
    }

    #[test]
    fn multi_select_shortcuts_never_dispatch_single_todo_actions() {
        for shortcut in ["e", "a", "H", "z", "Z", "v"] {
            let key = key(KeyCode::Char(shortcut.chars().next().expect("one char")));
            assert_eq!(
                shortcut_index(&MULTI_SELECT_MENU_ITEMS, key),
                None,
                "{shortcut} is not part of the multi-select menu"
            );
        }
    }

    #[test]
    fn return_and_escape_do_not_fall_through_to_literal_shortcuts() {
        assert_eq!(shortcut_index(&MENU_ITEMS, key(KeyCode::Enter)), None);
        assert_eq!(shortcut_index(&MENU_ITEMS, key(KeyCode::Esc)), None);
        assert_eq!(shortcut_index(&MENU_ITEMS, key(KeyCode::Delete)), Some(1));

        let mut menu = single();
        assert!(matches!(menu.handle_key(key(KeyCode::Esc)), Outcome::Close));
        // Enter activates the highlighted row, which starts on Edit.
        assert_eq!(
            action_of(menu.handle_key(key(KeyCode::Enter))),
            Action::Open(ModalId::EditTodo)
        );
    }

    #[test]
    fn up_and_down_wrap_and_move_the_marker() {
        let mut menu = single();
        assert_eq!(menu.selected(), 0);
        assert!(matches!(
            menu.handle_key(key(KeyCode::Up)),
            Outcome::Continue
        ));
        assert_eq!(menu.selected(), MENU_ITEMS.len() - 1);
        menu.handle_key(key(KeyCode::Down));
        assert_eq!(menu.selected(), 0);
        for _ in 0..MENU_ITEMS.len() {
            menu.handle_key(key(KeyCode::Down));
        }
        assert_eq!(menu.selected(), 0);
    }

    #[test]
    fn a_mouse_move_moves_the_marker_and_a_click_activates_the_row() {
        let mut menu = single();
        let rect = menu.geometry();
        // Row 4 is Set Threshold Date.
        let hover = MouseInput {
            kind: MouseKind::Move,
            x: rect.body.x + 1,
            y: rect.body.y + 5,
            shift: false,
        };
        assert!(matches!(menu.handle_mouse(hover), Outcome::Continue));
        assert_eq!(menu.selected(), 4);

        let click = MouseInput {
            kind: MouseKind::LeftClick,
            x: rect.body.x + 1,
            y: rect.body.y + 8,
            shift: false,
        };
        assert_eq!(
            action_of(menu.handle_mouse(click)),
            Action::Open(ModalId::AddProject)
        );
    }

    #[test]
    fn the_menu_is_the_ink_width_and_body_height() {
        let menu = single();
        assert_eq!(menu.width().resolve(100), 50);
        assert_eq!(menu.body_rows(), 16);
        assert_eq!(menu.title(), "Todo menu");
        assert_eq!(menu.id(), ModalId::TodoMenu);

        let multi = Menu::multi(vec![TodoId::new(1), TodoId::new(2)], 80, 24);
        assert_eq!(multi.body_rows(), 10);
        assert_eq!(multi.title(), "Multi-select menu");
        assert_eq!(multi.id(), ModalId::MultiSelectMenu);
        assert_eq!(MenuKind::MultiSelect.items().len(), 10);
    }

    #[test]
    fn delete_and_archive_go_through_a_confirmation() {
        let mut menu = single();
        let delete = action_of(menu.handle_key(key(KeyCode::Delete)));
        match delete {
            Action::Confirm(request) => {
                assert_eq!(request.title, "Delete Todo");
                assert_eq!(
                    request.message,
                    "Are you sure you want to delete this todo?"
                );
            }
            other => panic!("expected a confirmation, got {other:?}"),
        }

        let mut menu = single();
        let archive = action_of(menu.handle_key(key(KeyCode::Char('a'))));
        match archive {
            Action::Confirm(request) => {
                assert_eq!(request.title, "Archive Completed");
                assert_eq!(request.message, "Archive all completed todos to done.txt?");
                assert_eq!(*request.confirm, Action::ArchiveCompleted);
            }
            other => panic!("expected a confirmation, got {other:?}"),
        }
    }
}
