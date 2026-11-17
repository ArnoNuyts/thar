//! The create and edit todo screens.
//!
//! Both screens are one [`Editor`] plus a Save/Cancel row, so they share this
//! module the way `CreateTodoModal.tsx` and `EditTodoModal.tsx` share
//! `ModalTodoInput.tsx`. The differences are small and explicit:
//!
//! - **Create** prefills the input with the tags and contexts found in the
//!   current search query (`extractTagsAndContextsFromSearch`) and puts the
//!   cursor at offset 0, so typing starts in front of the `+project`/`@context`
//!   tokens.
//! - **Edit** starts at the cursor todo's `text` with the cursor at the end and
//!   grandfathers an overlong legacy value: the cap is
//!   `max(MAX_TODO_CHARS, original_len)`, so an unchanged long line can still be
//!   saved while a growing value is rejected.
//!
//! Everything is expressed as [`Outcome`]s and [`Action`]s; the screen never
//! mutates the list. A rejected value returns `Action::Toast` without closing,
//! so the user can fix the text.
//!
//! # Keyboard
//!
//! - printable characters, Left/Right/Home/End, word movement and
//!   Backspace/Delete edit the text (see [`Editor`]);
//! - while the suggestion list is open, Up/Down move the highlight, Enter/Tab
//!   apply the highlighted name and Escape only closes the list;
//! - Tab/Shift+Tab toggle Save/Cancel when no list is open;
//! - Enter activates the selected button (Save validates and submits, Cancel
//!   closes) and Escape closes the screen.
//!
//! # Rendering
//!
//! The input is drawn as `» ` plus the text with the character under the cursor
//! in an inverse cell, exactly like the Ink input. The suggestion list is a
//! floating popup owned by [`crate::view::suggestion`]: it is sized to the
//! longest name and anchored under the typed `+`/`@`, and the modal itself
//! keeps a fixed body height so it never jumps while the list opens or closes.
//! The Save/Cancel row is a pair of bordered boxes.

use ratatui::Frame;
use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use thar_core::{MAX_TODO_CHARS, TodoId, validate_todo_batch, validate_todo_text};

use crate::app::App;
use crate::display::sanitize_for_display;
use crate::editor::Editor;
use crate::modal::{Action, Modal, ModalId, ModalRect, ModalWidth, Outcome};
use crate::suggest::{Anchor, Overlay, Suggestions, TagSources};
use crate::theme;

/// Help line under the buttons, copied from `ModalTodoInput.tsx` so the Rust
/// and Ink screens describe the same keys.
const HELP_TEXT: &str = "Tab/Shift+Tab = toggle action, Enter = selected action, Esc = cancel";

/// The input prompt, two cells wide.
const PROMPT: &str = "» ";

/// Rows in the fixed body: the input, a spacer, the three bordered-button rows,
/// a spacer and the help line. Suggestions float above this and never change
/// the height.
const BASE_ROWS: u16 = 7;

/// Which screen this is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    Create,
    Edit,
}

/// The create/edit screen.
pub struct TextModal {
    mode: Mode,
    editor: Editor,
    sources: TagSources,
    suggestions: Suggestions,
    /// 0 = Save, 1 = Cancel.
    selected_button: usize,
    max_chars: usize,
    existing_count: usize,
    ids: Vec<TodoId>,
}

impl TextModal {
    /// Finish the screen and submit the current value.
    fn submit(&self) -> Outcome {
        let value = self.editor.value();
        if let Err(error) = validate_todo_text(&value, self.max_chars) {
            return Outcome::Actions(vec![Action::Toast(error.to_string())]);
        }

        match self.mode {
            Mode::Create => {
                if let Err(error) =
                    validate_todo_batch(std::slice::from_ref(&value), self.existing_count, 1)
                {
                    return Outcome::Actions(vec![Action::Toast(error.to_string())]);
                }
                Outcome::Actions(vec![Action::AddTodos(vec![value])])
            }
            Mode::Edit => Outcome::Actions(vec![Action::UpdateText {
                ids: self.ids.clone(),
                text: value,
            }]),
        }
    }

    /// Recompute the suggestion list for the current text and cursor.
    fn refresh_suggestions(&mut self) {
        let value = self.editor.value();
        self.suggestions
            .update(&self.sources, &value, self.editor.cursor());
    }

    /// Replace the typed tag word with the highlighted suggestion.
    fn apply_suggestion(&mut self) {
        let value = self.editor.value();
        let cursor = self.editor.cursor();
        if let Some((next, next_cursor)) = self.suggestions.apply(&value, cursor) {
            self.editor = Editor::with_cursor(&next, next_cursor);
        }
        self.suggestions.clear();
    }

    /// Enter: activate the selected button.
    fn activate(&self) -> Outcome {
        if self.selected_button == 1 {
            Outcome::Close
        } else {
            self.submit()
        }
    }

    /// Toggle Save/Cancel.
    fn toggle_button(&mut self) {
        self.selected_button = if self.selected_button == 0 { 1 } else { 0 };
    }
}
impl Modal for TextModal {
    fn id(&self) -> ModalId {
        match self.mode {
            Mode::Create => ModalId::CreateTodo,
            Mode::Edit => ModalId::EditTodo,
        }
    }

    fn title(&self) -> &str {
        match self.mode {
            Mode::Create => "Create new todo",
            Mode::Edit => "Edit todo",
        }
    }

    fn width(&self) -> ModalWidth {
        // The Ink modal is a 50%-wide centred box.
        ModalWidth::Percent(50)
    }

    fn body_rows(&self) -> u16 {
        BASE_ROWS
    }

    fn handle_key(&mut self, key: KeyEvent) -> Outcome {
        let command = key.modifiers.intersects(
            KeyModifiers::CONTROL
                | KeyModifiers::ALT
                | KeyModifiers::META
                | KeyModifiers::SUPER
                | KeyModifiers::HYPER,
        );

        if self.suggestions.is_open() {
            match key.code {
                KeyCode::Up => {
                    self.suggestions.select_previous();
                    return Outcome::Continue;
                }
                KeyCode::Down => {
                    self.suggestions.select_next();
                    return Outcome::Continue;
                }
                KeyCode::Enter | KeyCode::Tab | KeyCode::BackTab => {
                    self.apply_suggestion();
                    return Outcome::Continue;
                }
                KeyCode::Esc => {
                    self.suggestions.clear();
                    return Outcome::Continue;
                }
                _ => {}
            }
        }

        match key.code {
            KeyCode::Esc => Outcome::Close,
            // Ctrl+C cannot reach the app keymap while a modal owns the
            // keyboard, so it closes the screen instead of quitting silently.
            KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => Outcome::Close,
            KeyCode::Tab | KeyCode::BackTab if !command => {
                self.toggle_button();
                Outcome::Continue
            }
            KeyCode::Enter => self.activate(),
            _ => {
                if self.editor.handle_key(key) {
                    self.refresh_suggestions();
                }
                Outcome::Continue
            }
        }
    }

    fn handle_paste(&mut self, text: &str) -> Outcome {
        if self.editor.insert_text(text) {
            self.refresh_suggestions();
        }
        Outcome::Continue
    }

    fn render(&self, frame: &mut Frame, rect: ModalRect) {
        let content = content_rect(rect.body);
        if content.width == 0 || content.height == 0 {
            return;
        }

        let mut row = 0;
        render_input(frame, content, row, &self.editor);
        row += 1;

        // Spacer, buttons, spacer, help.
        row += 1;
        render_buttons(frame, content, row, self.selected_button);
        row += 3;
        row += 1;
        render_help(frame, content, row);
    }

    fn suggestion_overlay(&self, rect: ModalRect) -> Option<Overlay<'_>> {
        if !self.suggestions.is_open() {
            return None;
        }
        let content = content_rect(rect.body);
        let cursor = self.editor.cursor();
        let chars = self.editor.chars();
        let available = usize::from(content.width.saturating_sub(2));
        if available == 0 {
            return None;
        }
        let (window_start, _) = input_window(chars, cursor, available);
        let word_start = self.suggestions.start();
        let before_word = if word_start <= window_start {
            String::new()
        } else {
            chars
                .get(window_start..word_start.min(chars.len()))
                .unwrap_or(&[])
                .iter()
                .collect()
        };
        let width = u16::try_from(Line::from(sanitize_for_display(&before_word)).width())
            .unwrap_or(u16::MAX);
        let max_x = content.x.saturating_add(content.width.saturating_sub(1));
        let x = content
            .x
            .saturating_add(u16::try_from(PROMPT.chars().count()).unwrap_or(0))
            .saturating_add(width)
            .min(max_x);
        Some(Overlay {
            anchor: Anchor {
                x,
                y: content.y.saturating_add(1),
            },
            suggestions: &self.suggestions,
        })
    }
}

/// The drawable body: the modal's body rectangle inside its side borders.
fn content_rect(body: Rect) -> Rect {
    Rect::new(
        body.x.saturating_add(1),
        body.y,
        body.width.saturating_sub(2),
        body.height,
    )
}

/// Display width of one character after sanitization.
fn char_width(character: char) -> usize {
    Line::from(sanitize_for_display(&character.to_string())).width()
}

/// Display width of a run of characters in terminal cells.
fn cells_width(chars: &[char]) -> usize {
    chars.iter().map(|character| char_width(*character)).sum()
}

/// The cell-based input window: the first and exclusive last char indexes that
/// fit `available` terminal cells while keeping the cursor visible.
///
/// The editor stores a char index, but rendering and anchoring are in cells.
/// A CJK glyph is two cells and a sanitized control character can be six, so a
/// char window would overflow the input row and detach the popup from the
/// marker.
fn input_window(chars: &[char], cursor: usize, available: usize) -> (usize, usize) {
    if available == 0 {
        return (cursor.min(chars.len()), cursor.min(chars.len()));
    }

    let cursor = cursor.min(chars.len());
    let mut start = 0;
    let mut before = cells_width(&chars[..cursor]);
    // Leave one cell for the inverse cursor cell.
    while start < cursor && before.saturating_add(1) > available {
        before = before.saturating_sub(char_width(chars[start]));
        start += 1;
    }

    let mut end = cursor;
    let mut used = before.saturating_add(1);
    if let Some(at) = chars.get(cursor) {
        let width = char_width(*at);
        if used.saturating_add(width) <= available {
            used = used.saturating_add(width);
            end = cursor + 1;
        }
    }
    while end < chars.len() {
        let width = char_width(chars[end]);
        if used.saturating_add(width) > available {
            break;
        }
        used = used.saturating_add(width);
        end += 1;
    }

    (start, end)
}

/// One row of the content rectangle, if it is still inside the modal.
fn row_rect(content: Rect, offset: u16) -> Option<Rect> {
    (offset < content.height).then(|| {
        Rect::new(
            content.x,
            content.y.saturating_add(offset),
            content.width,
            1,
        )
    })
}

/// Draw the prompt and the text with an inverse cursor cell.
fn render_input(frame: &mut Frame, content: Rect, offset: u16, editor: &Editor) {
    let Some(area) = row_rect(content, offset) else {
        return;
    };

    let prompt_style = Style::default().fg(theme::SECONDARY);
    let text_style = Style::default().fg(theme::FOREGROUND);
    let cursor_style = text_style.add_modifier(Modifier::REVERSED);

    let chars = editor.chars();
    let cursor = editor.cursor();
    let available = usize::from(area.width.saturating_sub(2));
    if available == 0 {
        return;
    }

    let (start, end) = input_window(chars, cursor, available);
    let window = chars.get(start..end).unwrap_or(&[]);

    let cursor_at = cursor.saturating_sub(start);
    let before: String = window[..cursor_at.min(window.len())].iter().collect();
    let at = chars
        .get(cursor)
        .copied()
        .filter(|_| cursor < end)
        .unwrap_or(' ');
    let after: String = window[window.len().min(cursor_at.saturating_add(1))..]
        .iter()
        .collect();

    let mut spans = vec![Span::styled(PROMPT, prompt_style)];
    if !before.is_empty() {
        spans.push(Span::styled(sanitize_for_display(&before), text_style));
    }
    spans.push(Span::styled(
        sanitize_for_display(&at.to_string()),
        cursor_style,
    ));
    if !after.is_empty() {
        spans.push(Span::styled(sanitize_for_display(&after), text_style));
    }

    frame.render_widget(
        Paragraph::new(Line::from(spans)).style(Style::default().bg(theme::MODAL_BACKGROUND)),
        area,
    );
}

/// Draw the bordered Save/Cancel row across three body rows.
fn render_buttons(frame: &mut Frame, content: Rect, offset: u16, selected: usize) {
    let labels = ["Save", "Cancel"];
    let widths: Vec<u16> = labels
        .iter()
        .map(|label| u16::try_from(label.chars().count() + 4).unwrap_or(0))
        .collect();
    let spacing: u16 = 2;
    let total = widths.iter().sum::<u16>() + spacing;
    let left = content.x + content.width.saturating_sub(total) / 2;

    let mut x = left;
    for (index, label) in labels.iter().enumerate() {
        let width = widths[index];
        let is_selected = index == selected;
        let style = if is_selected {
            Style::default()
                .bg(theme::BUTTON_BACKGROUND)
                .fg(theme::INVERSE_FOREGROUND)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default()
                .bg(theme::MODAL_BACKGROUND)
                .fg(theme::MUTED)
        };

        let lines = [
            format!("┌{}┐", "─".repeat(usize::from(width.saturating_sub(2)))),
            format!("│ {label} │"),
            format!("└{}┘", "─".repeat(usize::from(width.saturating_sub(2)))),
        ];
        for (line_index, line) in lines.iter().enumerate() {
            let row = offset.saturating_add(u16::try_from(line_index).unwrap_or(0));
            let Some(full) = row_rect(content, row) else {
                continue;
            };
            let available = full.width.saturating_sub(x.saturating_sub(content.x));
            let area = Rect::new(x, full.y, width.min(available), 1);
            if area.width == 0 {
                continue;
            }
            frame.render_widget(
                Paragraph::new(Span::styled(sanitize_for_display(line), style)).style(style),
                area,
            );
        }
        x = x.saturating_add(width).saturating_add(spacing);
    }
}

/// Draw the muted help line, clipped to the modal width.
fn render_help(frame: &mut Frame, content: Rect, offset: u16) {
    let Some(area) = row_rect(content, offset) else {
        return;
    };
    let style = Style::default()
        .bg(theme::MODAL_BACKGROUND)
        .fg(theme::MUTED);
    frame.render_widget(
        Paragraph::new(sanitize_for_display(HELP_TEXT)).style(style),
        area,
    );
}

/// True for the characters the search-token regex accepts after a sigil.
///
/// `SEARCH_TAG_NAME_CHARS` in `logic/patterns.ts` is `[\w.\\_\-]`, which keeps a
/// literal backslash that the todo parser does not accept. The create prefill
/// mirrors the search extractor, not the parser.
fn is_search_name_char(character: char) -> bool {
    character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | '\\' | '-')
}

/// Every `sigil+name` token in `text`, without the sigil.
fn search_tokens(text: &str, sigil: char) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut tokens = Vec::new();
    let mut index = 0;

    while index < chars.len() {
        if chars[index] == sigil {
            let start = index + 1;
            let mut end = start;
            while end < chars.len() && is_search_name_char(chars[end]) {
                end += 1;
            }
            if end > start {
                tokens.push(chars[start..end].iter().collect());
                index = end;
                continue;
            }
        }
        index += 1;
    }

    tokens
}

/// `extractTagsAndContextsFromSearch`: the create modal's prefill.
///
/// Projects come first, then contexts, each in query order. A non-empty result
/// is wrapped in one leading and one trailing space, so the cursor at offset 0
/// leaves a space before the first token.
#[must_use]
pub fn extract_tags_and_contexts(query: &str) -> String {
    let trimmed = thar_core::js_trim(query);
    if trimmed.is_empty() {
        return String::new();
    }

    let mut tags: Vec<String> = Vec::new();
    for name in search_tokens(trimmed, '+') {
        tags.push(format!("+{name}"));
    }
    for name in search_tokens(trimmed, '@') {
        tags.push(format!("@{name}"));
    }

    if tags.is_empty() {
        String::new()
    } else {
        format!(" {} ", tags.join(" "))
    }
}

/// Build the create screen from the current app snapshot.
#[must_use]
pub fn create(app: &App) -> Box<dyn Modal> {
    let prefill = extract_tags_and_contexts(&app.search().query());
    let todos = app.todos();
    Box::new(TextModal {
        mode: Mode::Create,
        editor: Editor::with_cursor(&prefill, 0),
        sources: TagSources::collect(todos.iter()),
        suggestions: Suggestions::new(),
        selected_button: 0,
        max_chars: MAX_TODO_CHARS,
        existing_count: todos.len(),
        ids: Vec::new(),
    })
}

/// Build the edit screen for the cursor todo.
///
/// With no cursor todo the screen still opens with an empty input, matching the
/// Ink modal (`initialValue={todo?.text || ""}`); submitting then produces an
/// `UpdateText` with no ids, which the host treats as a no-op.
#[must_use]
pub fn edit(app: &App) -> Box<dyn Modal> {
    let todo = app.selected_todo();
    let text = todo.map(|todo| todo.text.clone()).unwrap_or_default();
    let ids = todo.map(|todo| vec![todo.id]).unwrap_or_default();
    let max_chars = MAX_TODO_CHARS.max(text.encode_utf16().count());
    let todos = app.todos();

    Box::new(TextModal {
        mode: Mode::Edit,
        editor: Editor::new(&text),
        sources: TagSources::collect(todos.iter()),
        suggestions: Suggestions::new(),
        selected_button: 0,
        max_chars,
        existing_count: todos.len(),
        ids,
    })
}

#[cfg(test)]
mod tests {
    use super::extract_tags_and_contexts;
    use crate::app::App;
    use crate::modal::{Action, Modal, ModalId, Outcome};
    use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    use thar_core::{Todo, TodoDate, TodoId};

    const NONE: KeyModifiers = KeyModifiers::NONE;

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, NONE)
    }

    fn overlay_open(modal: &dyn Modal) -> bool {
        let rect = crate::modal::geometry::resolve(
            ratatui::layout::Rect::new(0, 0, 80, 24),
            modal.width(),
            modal.body_rows(),
        );
        modal.suggestion_overlay(rect).is_some()
    }

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
        app.set_read_only(false);
        app
    }

    fn type_text(modal: &mut dyn Modal, text: &str) {
        for character in text.chars() {
            modal.handle_key(key(KeyCode::Char(character)));
        }
    }

    fn actions(outcome: Outcome) -> Vec<Action> {
        match outcome {
            Outcome::Actions(actions) => actions,
            other => panic!("expected actions, got {}", describe(&other)),
        }
    }

    fn describe(outcome: &Outcome) -> &'static str {
        match outcome {
            Outcome::Continue => "continue",
            Outcome::Close => "close",
            Outcome::Actions(_) => "actions",
        }
    }

    #[test]
    fn the_prefill_extracts_projects_then_contexts() {
        let cases = [
            ("", ""),
            ("   ", ""),
            ("milk", ""),
            ("+thar", " +thar "),
            ("+thar @home", " +thar @home "),
            ("@home +thar", " +thar @home "),
            ("+a +b @c", " +a +b @c "),
            // The search alphabet keeps a backslash.
            ("+a\\b", " +a\\b "),
            // A bare sigil is not a token.
            ("+ @", ""),
            // Tokens inside a word still match, like the global token regex.
            ("buy+milk @home", " +milk @home "),
            // Duplicates are preserved, like the oracle.
            ("+thar +thar", " +thar +thar "),
        ];
        for (query, expected) in cases {
            assert_eq!(extract_tags_and_contexts(query), expected, "{query:?}");
        }
    }

    #[test]
    fn create_prefills_from_the_search_and_starts_at_offset_zero() {
        let mut app = app(&["one +thar @home"]);
        app.set_query("+thar @home");
        let modal = super::create(&app);
        assert_eq!(modal.id(), ModalId::CreateTodo);
        assert_eq!(modal.title(), "Create new todo");

        let mut modal = modal;
        // Typing inserts in front of the prefilled tokens.
        type_text(&mut *modal, "buy milk");
        let actions = actions(modal.handle_key(key(KeyCode::Enter)));
        assert_eq!(
            actions,
            [Action::AddTodos(vec!["buy milk +thar @home ".to_owned()])]
        );
    }

    #[test]
    fn create_rejects_empty_text_and_keeps_the_modal_open() {
        let app = app(&["one"]);
        let mut modal = super::create(&app);
        let actions = actions(modal.handle_key(key(KeyCode::Enter)));
        match &actions[..] {
            [Action::Toast(message)] => {
                assert_eq!(message, "Todo text cannot be empty or whitespace only");
            }
            other => panic!("expected one toast, got {other:?}"),
        }
    }

    #[test]
    fn create_rejects_a_leading_date() {
        let app = app(&["one"]);
        let mut modal = super::create(&app);
        type_text(&mut *modal, "2026-11-15 buy milk");
        let actions = actions(modal.handle_key(key(KeyCode::Enter)));
        match &actions[..] {
            [Action::Toast(message)] => {
                assert_eq!(
                    message,
                    "Todo text cannot start with a date; use the date picker"
                );
            }
            other => panic!("expected one toast, got {other:?}"),
        }
    }

    #[test]
    fn tab_toggles_the_buttons_and_enter_activates_the_selection() {
        let app = app(&["one"]);
        let mut modal = super::create(&app);
        type_text(&mut *modal, "buy milk");

        // Tab selects Cancel; Enter closes without an action.
        assert!(matches!(
            modal.handle_key(key(KeyCode::Tab)),
            Outcome::Continue
        ));
        assert!(matches!(
            modal.handle_key(key(KeyCode::Enter)),
            Outcome::Close
        ));

        // Shift+Tab returns to Save.
        let mut modal = super::create(&app);
        type_text(&mut *modal, "buy milk");
        assert!(matches!(
            modal.handle_key(key(KeyCode::BackTab)),
            Outcome::Continue
        ));
        assert!(matches!(
            modal.handle_key(key(KeyCode::BackTab)),
            Outcome::Continue
        ));
        assert_eq!(
            actions(modal.handle_key(key(KeyCode::Enter))),
            [Action::AddTodos(vec!["buy milk".to_owned()])]
        );
    }

    #[test]
    fn escape_closes_the_screen() {
        let app = app(&["one"]);
        let mut modal = super::create(&app);
        type_text(&mut *modal, "half typed");
        assert!(matches!(
            modal.handle_key(key(KeyCode::Esc)),
            Outcome::Close
        ));
    }

    #[test]
    fn edit_starts_at_the_text_end_and_updates_the_cursor_todo() {
        let mut app = app(&["buy milk +thar @home", "second"]);
        app.set_cursor(Some(app.todos()[0].id));
        let mut modal = super::edit(&app);
        assert_eq!(modal.id(), ModalId::EditTodo);
        assert_eq!(modal.title(), "Edit todo");

        // `Todo::text` keeps the `+project`/`@context` tokens (only
        // `key:value` tags are stripped), so the editor shows the full body.
        let id = app.todos()[0].id;
        assert_eq!(
            actions(modal.handle_key(key(KeyCode::Enter))),
            [Action::UpdateText {
                ids: vec![id],
                text: "buy milk +thar @home".to_owned()
            }]
        );
    }

    #[test]
    fn edit_appends_at_the_end_and_grandfathers_an_overlong_value() {
        let long = "a".repeat(2_500);
        let app = app(&[&long]);
        let mut modal = super::edit(&app);
        // The cap is the original length, so an unchanged value saves.
        assert_eq!(
            actions(modal.handle_key(key(KeyCode::Enter))),
            [Action::UpdateText {
                ids: vec![app.todos()[0].id],
                text: long.clone()
            }]
        );

        // One more character is rejected: the value grew past the cap.
        let mut modal = super::edit(&app);
        type_text(&mut *modal, "b");
        match &actions(modal.handle_key(key(KeyCode::Enter)))[..] {
            [Action::Toast(message)] => {
                assert_eq!(message, "Todo is too long; the limit is 2500 characters");
            }
            other => panic!("expected one toast, got {other:?}"),
        }
    }

    #[test]
    fn edit_without_a_cursor_todo_opens_empty() {
        let mut app = app(&[]);
        app.set_cursor(None);
        let mut modal = super::edit(&app);
        assert_eq!(
            actions(modal.handle_key(key(KeyCode::Enter)))[..],
            [Action::Toast(
                "Todo text cannot be empty or whitespace only".to_owned()
            )]
        );
        type_text(&mut *modal, "new");
        assert_eq!(
            actions(modal.handle_key(key(KeyCode::Enter))),
            [Action::UpdateText {
                ids: Vec::new(),
                text: "new".to_owned()
            }]
        );
    }

    #[test]
    fn suggestions_open_on_a_word_start_and_apply_with_enter() {
        let app = app(&["one +thar @home", "two +thar-tui @work"]);
        let mut modal = super::create(&app);

        type_text(&mut *modal, "buy +tha");
        assert_eq!(modal.body_rows(), super::BASE_ROWS);
        assert!(overlay_open(&*modal));

        // Enter applies the first match instead of submitting.
        assert!(matches!(
            modal.handle_key(key(KeyCode::Enter)),
            Outcome::Continue
        ));
        assert_eq!(modal.body_rows(), super::BASE_ROWS);
        assert!(!overlay_open(&*modal));

        // Arrow keys move and wrap the highlight.
        type_text(&mut *modal, "@");
        assert_eq!(modal.body_rows(), super::BASE_ROWS);
        assert!(overlay_open(&*modal));
        assert!(matches!(
            modal.handle_key(key(KeyCode::Down)),
            Outcome::Continue
        ));
        assert!(matches!(
            modal.handle_key(key(KeyCode::Down)),
            Outcome::Continue
        ));
        assert!(matches!(
            modal.handle_key(key(KeyCode::Up)),
            Outcome::Continue
        ));
        // Tab applies while the list is open (so it does not toggle buttons).
        assert!(matches!(
            modal.handle_key(key(KeyCode::Tab)),
            Outcome::Continue
        ));
        assert_eq!(modal.body_rows(), super::BASE_ROWS);
        assert!(!overlay_open(&*modal));

        let actions = actions(modal.handle_key(key(KeyCode::Enter)));
        assert_eq!(
            actions,
            [Action::AddTodos(vec!["buy +thar @work ".to_owned()])]
        );
    }

    #[test]
    fn escape_clears_suggestions_before_it_closes() {
        let app = app(&["one +thar"]);
        let mut modal = super::create(&app);
        type_text(&mut *modal, "+th");
        assert!(overlay_open(&*modal));

        assert!(matches!(
            modal.handle_key(key(KeyCode::Esc)),
            Outcome::Continue
        ));
        assert!(!overlay_open(&*modal));
        assert_eq!(modal.body_rows(), super::BASE_ROWS);
        assert!(matches!(
            modal.handle_key(key(KeyCode::Esc)),
            Outcome::Close
        ));
    }

    #[test]
    fn a_paste_is_stripped_trimmed_and_updates_suggestions() {
        let app = app(&["one +thar @home"]);

        // A multi-character paste loses its line breaks and surrounding
        // spaces; the result is one line.
        let mut modal = super::create(&app);
        assert!(matches!(
            modal.handle_paste("  buy milk  \r\n"),
            Outcome::Continue
        ));
        assert_eq!(
            actions(modal.handle_key(key(KeyCode::Enter))),
            [Action::AddTodos(vec!["buy milk".to_owned()])]
        );

        // A paste that starts a tag word opens the list.
        let mut modal = super::create(&app);
        assert!(matches!(modal.handle_paste("+th"), Outcome::Continue));
        assert!(overlay_open(&*modal));
        assert_eq!(modal.body_rows(), super::BASE_ROWS);
    }

    #[test]
    fn a_control_character_is_rejected_on_submit() {
        let app = app(&["one"]);
        let mut modal = super::create(&app);
        modal.handle_paste("bad\u{1}text");
        match &actions(modal.handle_key(key(KeyCode::Enter)))[..] {
            [Action::Toast(message)] => {
                assert_eq!(message, "Todo contains a disallowed control character");
            }
            other => panic!("expected one toast, got {other:?}"),
        }
    }

    #[test]
    fn typing_q_inserts_instead_of_quitting() {
        let app = app(&["one"]);
        let mut modal = super::create(&app);
        type_text(&mut *modal, "q");
        assert_eq!(
            actions(modal.handle_key(key(KeyCode::Enter))),
            [Action::AddTodos(vec!["q".to_owned()])]
        );
    }

    #[test]
    fn the_editor_keys_reach_the_editor() {
        let app = app(&["one"]);
        let mut modal: Box<dyn Modal> = super::create(&app);
        type_text(&mut *modal, "ab");
        modal.handle_key(key(KeyCode::Home));
        modal.handle_key(key(KeyCode::Delete));
        assert_eq!(
            actions(modal.handle_key(key(KeyCode::Enter))),
            [Action::AddTodos(vec!["b".to_owned()])]
        );
    }

    #[test]
    fn the_input_window_counts_display_cells_not_chars() {
        let text = format!("{} +th", "日".repeat(30));
        let chars: Vec<char> = text.chars().collect();
        let cursor = chars.len();
        let (start, end) = super::input_window(&chars, cursor, 36);
        assert!(start > 0, "the wide prefix must scroll");
        assert_eq!(end, cursor);
        assert!(super::cells_width(&chars[start..cursor]) < 36);
    }

    #[test]
    fn the_body_stays_fixed_while_the_popup_windows() {
        let lines: Vec<String> = std::iter::once("one".to_owned())
            .chain((0..20).map(|index| format!("todo {index} +project{index:02}")))
            .collect();
        let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
        let app = app(&refs);
        let mut modal = super::create(&app);
        type_text(&mut *modal, "+project");
        assert_eq!(modal.body_rows(), super::BASE_ROWS);

        let rect = crate::modal::geometry::resolve(
            ratatui::layout::Rect::new(0, 0, 80, 24),
            modal.width(),
            modal.body_rows(),
        );
        let overlay = modal.suggestion_overlay(rect).expect("the popup is open");
        assert_eq!(overlay.suggestions.items().len(), 20);

        assert_eq!(
            crate::suggest::visible_range(20, 0, crate::suggest::MAX_ROWS),
            (0, crate::suggest::MAX_ROWS)
        );
        assert_eq!(
            crate::suggest::visible_range(20, 19, crate::suggest::MAX_ROWS),
            (14, 20),
            "the window scrolls to keep the selection visible"
        );
        assert_eq!(
            crate::suggest::visible_range(3, 2, crate::suggest::MAX_ROWS),
            (0, 3)
        );
    }
}
