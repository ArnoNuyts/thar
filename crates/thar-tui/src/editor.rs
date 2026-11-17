//! A single-line text editor for the create/edit modal.
//!
//! The editor is the Rust counterpart of `ControlledTextInput.tsx`: one line of
//! text plus a cursor, driven by crossterm key events and a bracketed paste. It
//! is deliberately a plain state machine — no widget, no terminal, no I/O — so
//! the keymap is a table test and the modal only has to decide what Enter, Tab
//! and Escape mean.
//!
//! # Cursor unit
//!
//! The cursor is a **`char` index** (Unicode scalar values), `0..=len`, not a
//! byte offset and not a UTF-16 offset. Rendering maps it to a cell column, so
//! an astral character (one `char`, two UTF-16 units) moves the cursor by one
//! and is painted as one cell. This differs from the validation cap on purpose:
//! [`thar_core::MAX_TODO_CHARS`] counts UTF-16 code units because
//! `String.prototype.length` does, while the editor counts the units a user
//! perceives as one character. A grapheme cluster (a base letter plus a
//! combining mark) is still several cursor steps, exactly like the Ink input.
//!
//! # Paste
//!
//! [`Editor::insert_text`] mirrors `insertAtCursor`: CR and LF are stripped (a
//! paste into a one-line field never creates a second line), and a
//! multi-character input is trimmed before it is inserted. A single character
//! is inserted verbatim so a typed space is not trimmed away. There is no
//! length cap here; the modal validates on submit.

use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

/// One line of editable text and its cursor.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Editor {
    chars: Vec<char>,
    cursor: usize,
}

/// True for the modifiers that make `Ctrl`/`Meta` word commands.
fn is_word_modifier(modifiers: KeyModifiers) -> bool {
    modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT | KeyModifiers::META)
}

/// True when a key press carries a modifier that makes it a command, not text.
fn is_command_modifier(modifiers: KeyModifiers) -> bool {
    modifiers.intersects(
        KeyModifiers::CONTROL
            | KeyModifiers::ALT
            | KeyModifiers::META
            | KeyModifiers::SUPER
            | KeyModifiers::HYPER,
    )
}

impl Editor {
    /// A new editor with the cursor at the end of `value`.
    #[must_use]
    pub fn new(value: &str) -> Self {
        let chars: Vec<char> = value.chars().collect();
        Self {
            cursor: chars.len(),
            chars,
        }
    }

    /// A new editor with the cursor at a character offset (clamped).
    #[must_use]
    pub fn with_cursor(value: &str, cursor: usize) -> Self {
        let chars: Vec<char> = value.chars().collect();
        let cursor = cursor.min(chars.len());
        Self { chars, cursor }
    }

    /// The text.
    #[must_use]
    pub fn value(&self) -> String {
        self.chars.iter().collect()
    }

    /// The characters, for a renderer that needs to window them.
    #[must_use]
    pub fn chars(&self) -> &[char] {
        &self.chars
    }

    /// The cursor as a character index.
    #[must_use]
    pub fn cursor(&self) -> usize {
        self.cursor
    }

    /// Move the cursor one character left, clamped at the start.
    pub fn move_left(&mut self, word: bool) {
        self.cursor = if word {
            self.word_left()
        } else {
            self.cursor.saturating_sub(1)
        };
    }

    /// Move the cursor one character right, clamped at the end.
    pub fn move_right(&mut self, word: bool) {
        self.cursor = if word {
            self.word_right(false)
        } else {
            (self.cursor + 1).min(self.chars.len())
        };
    }

    /// Delete the character, or the word when `word` is set, before the cursor.
    ///
    /// A backspace at the start is a no-op, so callers can drive it from a key
    /// event without a bounds check.
    pub fn backspace(&mut self, word: bool) {
        if self.cursor == 0 {
            return;
        }
        let start = if word {
            self.word_left()
        } else {
            self.cursor - 1
        };
        self.delete_range(start, self.cursor);
    }

    /// Delete the character, or the word when `word` is set, at the cursor.
    pub fn delete_forward(&mut self, word: bool) {
        if self.cursor >= self.chars.len() {
            return;
        }
        let end = if word {
            self.word_right(self.chars[self.cursor] == ' ')
        } else {
            self.cursor + 1
        };
        self.delete_range(self.cursor, end);
    }

    /// Number of characters.
    #[must_use]
    pub fn len(&self) -> usize {
        self.chars.len()
    }

    /// True when the value is empty.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.chars.is_empty()
    }

    /// The text before the cursor, as a string.
    #[must_use]
    pub fn left(&self) -> String {
        self.chars[..self.cursor].iter().collect()
    }

    /// The start of the word before the cursor.
    ///
    /// Spaces are the only separator, matching `moveWordLeft` in the Ink input.
    #[must_use]
    pub fn word_left(&self) -> usize {
        let mut index = self.cursor;
        while index > 0 && self.chars[index - 1] == ' ' {
            index -= 1;
        }
        while index > 0 && self.chars[index - 1] != ' ' {
            index -= 1;
        }
        index
    }

    /// The end of the word right of the cursor.
    ///
    /// With `space_first`, a space run at the cursor is skipped before the next
    /// word is consumed and the spaces after that word stay in place; that is
    /// the Ctrl+Delete shape when the cursor already sits on whitespace.
    #[must_use]
    pub fn word_right(&self, space_first: bool) -> usize {
        let mut index = self.cursor;
        if space_first {
            while index < self.chars.len() && self.chars[index] == ' ' {
                index += 1;
            }
        }
        while index < self.chars.len() && self.chars[index] != ' ' {
            index += 1;
        }
        if !space_first {
            while index < self.chars.len() && self.chars[index] == ' ' {
                index += 1;
            }
        }
        index
    }

    /// Apply one key press.
    ///
    /// Returns true when the editor consumed the key. Enter, Tab, Escape and
    /// the vertical arrows are left to the modal, so this never submits or
    /// closes anything.
    pub fn handle_key(&mut self, key: KeyEvent) -> bool {
        let word = is_word_modifier(key.modifiers);

        match key.code {
            KeyCode::Left => {
                self.move_left(word);
                true
            }
            KeyCode::Right => {
                self.move_right(word);
                true
            }
            KeyCode::Home => {
                self.cursor = 0;
                true
            }
            KeyCode::End => {
                self.cursor = self.chars.len();
                true
            }
            KeyCode::Backspace => {
                self.backspace(word);
                true
            }
            KeyCode::Delete => {
                self.delete_forward(word);
                true
            }
            KeyCode::Char(character) if !is_command_modifier(key.modifiers) => {
                if matches!(character, '\r' | '\n') {
                    return false;
                }
                self.insert_text(&character.to_string());
                true
            }
            _ => false,
        }
    }

    /// Insert typed or pasted text, applying the one-line paste rules.
    ///
    /// Returns true when the text changed the value.
    pub fn insert_text(&mut self, text: &str) -> bool {
        let stripped: String = text
            .chars()
            .filter(|character| !matches!(character, '\r' | '\n'))
            .collect();
        let stripped_len = stripped.chars().count();
        if stripped_len == 0 {
            return false;
        }

        // Multi-character input is a paste: trim it. A single character keeps
        // its spaces.
        let text = if stripped_len > 1 {
            stripped
                .trim_matches(thar_core::is_js_whitespace)
                .to_owned()
        } else {
            stripped
        };
        if text.is_empty() {
            return false;
        }

        let inserted: Vec<char> = text.chars().collect();
        let count = inserted.len();
        self.chars.splice(self.cursor..self.cursor, inserted);
        self.cursor += count;
        true
    }

    /// Replace one character range with `text` and leave the cursor after it.
    ///
    /// Character indexes are clamped, so a stale suggestion range can never
    /// panic.
    pub fn replace_range(&mut self, start: usize, end: usize, text: &str) {
        let start = start.min(self.chars.len());
        let end = end.max(start).min(self.chars.len());
        let inserted: Vec<char> = text.chars().collect();
        let count = inserted.len();
        self.chars.splice(start..end, inserted);
        self.cursor = start + count;
    }

    /// Delete one character range.
    fn delete_range(&mut self, start: usize, end: usize) {
        let start = start.min(self.chars.len());
        let end = end.max(start).min(self.chars.len());
        self.chars.drain(start..end);
        self.cursor = start;
    }
}

#[cfg(test)]
mod tests {
    use super::Editor;
    use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

    const NONE: KeyModifiers = KeyModifiers::NONE;
    const CTRL: KeyModifiers = KeyModifiers::CONTROL;
    const META: KeyModifiers = KeyModifiers::META;

    fn key(code: KeyCode, modifiers: KeyModifiers) -> KeyEvent {
        KeyEvent::new(code, modifiers)
    }

    /// (start, cursor, key, expected value, expected cursor).
    type Case = (&'static str, usize, KeyEvent, &'static str, usize);

    #[test]
    fn the_keymap_is_table_driven() {
        let cases: &[Case] = &[
            // Plain movement.
            ("abc", 1, key(KeyCode::Left, NONE), "abc", 0),
            ("abc", 1, key(KeyCode::Right, NONE), "abc", 2),
            ("abc", 0, key(KeyCode::Left, NONE), "abc", 0),
            ("abc", 3, key(KeyCode::Right, NONE), "abc", 3),
            ("abc", 3, key(KeyCode::Home, NONE), "abc", 0),
            ("abc", 0, key(KeyCode::End, NONE), "abc", 3),
            // Word movement on spaces.
            (
                "one two three",
                13,
                key(KeyCode::Left, CTRL),
                "one two three",
                8,
            ),
            (
                "one two three",
                13,
                key(KeyCode::Left, META),
                "one two three",
                8,
            ),
            (
                "one two three",
                4,
                key(KeyCode::Left, CTRL),
                "one two three",
                0,
            ),
            ("one  two", 8, key(KeyCode::Left, CTRL), "one  two", 5),
            ("one two", 0, key(KeyCode::Right, CTRL), "one two", 4),
            // Backspace and Delete.
            ("abc", 2, key(KeyCode::Backspace, NONE), "ac", 1),
            ("abc", 0, key(KeyCode::Backspace, NONE), "abc", 0),
            ("abc", 3, key(KeyCode::Delete, NONE), "abc", 3),
            ("abc", 0, key(KeyCode::Delete, NONE), "bc", 0),
            // Ctrl+Backspace deletes the word before the cursor.
            ("one two", 7, key(KeyCode::Backspace, CTRL), "one ", 4),
            ("one two", 4, key(KeyCode::Backspace, CTRL), "two", 0),
            // Ctrl+Delete deletes the word at the cursor. On whitespace it
            // skips the space run first and keeps trailing spaces.
            ("one two", 0, key(KeyCode::Delete, CTRL), "two", 0),
            ("one two", 3, key(KeyCode::Delete, CTRL), "one", 3),
            ("one  two", 4, key(KeyCode::Delete, CTRL), "one ", 4),
            // Printable insert; modified characters are commands, not text.
            ("ac", 1, key(KeyCode::Char('b'), NONE), "abc", 2),
            ("ac", 1, key(KeyCode::Char(' '), NONE), "a c", 2),
            (
                "ac",
                1,
                key(KeyCode::Char('B'), KeyModifiers::SHIFT),
                "aBc",
                2,
            ),
            ("ac", 1, key(KeyCode::Char('b'), CTRL), "ac", 1),
            ("ac", 1, key(KeyCode::Char('b'), KeyModifiers::ALT), "ac", 1),
            // Enter/Escape/Tab/arrows are the modal's.
            ("ac", 1, key(KeyCode::Enter, NONE), "ac", 1),
            ("ac", 1, key(KeyCode::Esc, NONE), "ac", 1),
            ("ac", 1, key(KeyCode::Tab, NONE), "ac", 1),
            ("ac", 1, key(KeyCode::Up, NONE), "ac", 1),
            ("ac", 1, key(KeyCode::Down, NONE), "ac", 1),
        ];

        for (start, cursor, event, expected, expected_cursor) in cases {
            let mut editor = Editor::with_cursor(start, *cursor);
            editor.handle_key(*event);
            assert_eq!(
                editor.value(),
                *expected,
                "value after {:?} from {start:?}@{cursor}",
                event.code
            );
            assert_eq!(
                editor.cursor(),
                *expected_cursor,
                "cursor after {:?} from {start:?}@{cursor}",
                event.code
            );
        }
    }

    #[test]
    fn handle_key_reports_whether_it_consumed_the_key() {
        let mut editor = Editor::new("a");
        assert!(editor.handle_key(key(KeyCode::Char('b'), NONE)));
        assert!(editor.handle_key(key(KeyCode::Left, NONE)));
        assert!(!editor.handle_key(key(KeyCode::Enter, NONE)));
        assert!(!editor.handle_key(key(KeyCode::Esc, NONE)));
        assert!(!editor.handle_key(key(KeyCode::Tab, NONE)));
        assert!(!editor.handle_key(key(KeyCode::Char('a'), CTRL)));
        assert_eq!(editor.value(), "ab");
    }

    #[test]
    fn paste_strips_line_breaks_and_trims_a_multi_character_value() {
        let mut editor = Editor::new("buy ");
        assert!(editor.insert_text("oat milk\r\n@home"));
        assert_eq!(editor.value(), "buy oat milk@home");
        assert_eq!(editor.cursor(), editor.len());

        let mut editor = Editor::new("");
        assert!(editor.insert_text("  spaced  "));
        assert_eq!(editor.value(), "spaced");

        // A single pasted/typed space is kept verbatim.
        let mut editor = Editor::new("a");
        assert!(editor.insert_text(" "));
        assert_eq!(editor.value(), "a ");

        // Nothing to insert.
        let mut editor = Editor::new("a");
        assert!(!editor.insert_text("\n\r"));
        assert!(!editor.insert_text("   "));
        assert_eq!(editor.value(), "a");

        // JS whitespace, not Rust's: NEL (U+0085) is kept so the validator
        // rejects it, while a pasted BOM (U+FEFF) is trimmed.
        let mut editor = Editor::new("");
        assert!(editor.insert_text("a\u{0085}"));
        assert_eq!(editor.value(), "a\u{0085}");
        let mut editor = Editor::new("");
        assert!(editor.insert_text("\u{FEFF}text\u{FEFF}"));
        assert_eq!(editor.value(), "text");
    }

    #[test]
    fn the_cursor_is_a_character_index() {
        let mut editor = Editor::new("a🎉b");
        assert_eq!(editor.len(), 3);
        assert_eq!(editor.cursor(), 3);
        editor.handle_key(key(KeyCode::Left, NONE));
        assert_eq!(editor.cursor(), 2);
        editor.handle_key(key(KeyCode::Backspace, NONE));
        assert_eq!(editor.value(), "ab");
        assert_eq!(editor.cursor(), 1);
    }

    #[test]
    fn replace_range_clamps_and_places_the_cursor_after_the_insert() {
        let mut editor = Editor::new("+wor");
        editor.replace_range(0, 4, "+work ");
        assert_eq!(editor.value(), "+work ");
        assert_eq!(editor.cursor(), 6);

        let mut editor = Editor::new("abc");
        editor.replace_range(99, 200, "!");
        assert_eq!(editor.value(), "abc!");
        let mut editor = Editor::new("abc");
        editor.replace_range(1, 99, "Z");
        assert_eq!(editor.value(), "aZ");
        assert_eq!(editor.cursor(), 2);
    }

    #[test]
    fn with_cursor_clamps_and_preserves_the_value() {
        let editor = Editor::with_cursor("abc", 99);
        assert_eq!(editor.cursor(), 3);
        assert_eq!(editor.value(), "abc");
        assert_eq!(editor.left(), "abc");
        assert!(!editor.is_empty());
        assert!(Editor::new("").is_empty());
    }
}
