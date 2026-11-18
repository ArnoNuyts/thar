//! The search bar: one editable query plus its suggestion popup.
//!
//! The bar keeps the query in the shared [`Editor`] so the cursor is a character
//! index into the query, not a separate value that can drift out of range when
//! the sanitized (longer) render string is measured. It is a plain state
//! machine; the [`crate::app::App`] wraps every edit with the row-model rebuild
//! and suggestion refresh so a caller cannot forget one.
//!
//! Insertion is a verbatim splice: a bracketed paste keeps its order and text,
//! and only the clipboard path trims or validates whole todo lines.

use crate::editor::{Editor, Step};
use crate::suggest::{Suggestions, TagSources};

/// The query text, its cursor, focus, and the current suggestion list.
#[derive(Debug, Default)]
pub struct SearchBar {
    editor: Editor,
    focused: bool,
    suggestions: Suggestions,
}

impl SearchBar {
    /// The query text.
    #[must_use]
    pub fn query(&self) -> String {
        self.editor.value()
    }

    /// The query characters, for a renderer that windows them.
    #[must_use]
    pub fn chars(&self) -> &[char] {
        self.editor.chars()
    }

    /// The cursor as a character index into [`SearchBar::query`].
    #[must_use]
    pub fn cursor(&self) -> usize {
        self.editor.cursor()
    }

    /// True while the search bar has keyboard focus.
    #[must_use]
    pub fn focused(&self) -> bool {
        self.focused
    }

    /// The bar is visible while it is focused or holds a query.
    #[must_use]
    pub fn visible(&self) -> bool {
        self.focused || !self.editor.is_empty()
    }

    /// The current project/context suggestion list.
    #[must_use]
    pub fn suggestions(&self) -> &Suggestions {
        &self.suggestions
    }

    /// Replace the query and put the cursor at its end.
    pub fn set_query(&mut self, query: impl Into<String>) {
        self.editor = Editor::new(&query.into());
    }

    /// Clear the query and drop the suggestion list.
    pub fn clear(&mut self) {
        self.editor = Editor::default();
        self.suggestions.clear();
    }

    /// Focus the bar.
    pub fn focus(&mut self) {
        self.focused = true;
    }

    /// Blur the bar and close the popup, keeping the query and cursor.
    pub fn blur(&mut self) {
        self.focused = false;
        self.clear_suggestions();
    }

    /// Insert one character at the cursor.
    pub fn insert_char(&mut self, character: char) {
        let mut buffer = [0; 4];
        self.insert_text(character.encode_utf8(&mut buffer));
    }

    /// Splice pasted text at the cursor, verbatim and in order.
    pub fn insert_text(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        let cursor = self.editor.cursor();
        self.editor.replace_range(cursor, cursor, text);
    }

    /// Delete the character before the cursor.
    pub fn backspace(&mut self) {
        self.editor.backspace(Step::Char);
    }

    /// Delete the character at the cursor.
    pub fn delete(&mut self) {
        self.editor.delete_forward(Step::Char);
    }

    /// Move the cursor one character left, clamped at the start.
    pub fn move_left(&mut self) {
        self.editor.move_left(Step::Char);
    }

    /// Move the cursor one character right, clamped at the end.
    pub fn move_right(&mut self) {
        self.editor.move_right(Step::Char);
    }

    /// Recompute the suggestion list from the current query and cursor.
    pub fn refresh(&mut self, sources: &TagSources) {
        self.suggestions
            .update(sources, &self.query(), self.cursor());
    }

    /// Close the suggestion popup without changing the query.
    pub fn clear_suggestions(&mut self) {
        self.suggestions.clear();
    }

    /// Move the suggestion highlight up.
    pub fn suggestion_previous(&mut self) {
        self.suggestions.select_previous();
    }

    /// Move the suggestion highlight down.
    pub fn suggestion_next(&mut self) {
        self.suggestions.select_next();
    }

    /// Replace the typed word with the highlighted suggestion.
    ///
    /// Returns true when a suggestion was applied. The query and cursor become
    /// exactly what the suggestion computed.
    pub fn suggestion_apply(&mut self) -> bool {
        let Some((text, cursor)) = self.suggestions.apply(&self.query(), self.cursor()) else {
            return false;
        };
        self.editor = Editor::with_cursor(&text, cursor);
        self.suggestions.clear();
        true
    }
}
