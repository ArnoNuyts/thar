//! Project/context tag suggestions for the create/edit modal.
//!
//! This is the Rust counterpart of `logic/tag-sources.ts`, `matchTagWordStart`
//! in `logic/patterns.ts`, and `useSuggestionInput.ts`:
//!
//! - [`TagSources`] collects the unique projects and contexts used by the
//!   current list, sorted;
//! - [`match_tag_word_start`] detects a `+project`/`@context` word at the
//!   cursor, using the `[\w.\-_]` name alphabet;
//! - [`Suggestions`] filters case-insensitively with `starts_with` (no fuzzy
//!   ranking, no scoring), wraps the selection at both ends, and applies the
//!   selected item as `prefix + name + " "` in place of the typed word.
//!
//! There is no mouse support: the overlay is keyboard-only, like the Ink
//! suggestion list. The module is pure state, so filtering and application are
//! table tests.

use thar_core::Todo;

pub use crate::modal::TagKind;

/// The unique project and context names in the current list, sorted.
///
/// The order is byte order over ASCII names. The name alphabet is `[\w.\-_]`,
/// which is ASCII only, so this is also the JavaScript default sort order.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TagSources {
    /// Sorted `+project` names.
    pub projects: Vec<String>,
    /// Sorted `@context` names.
    pub contexts: Vec<String>,
}

impl TagSources {
    /// Collect the sources from every todo, hidden or not.
    ///
    /// Matching `collectTagSources` in the oracle, the whole list contributes,
    /// not just the visible rows, and the result is de-duplicated and sorted.
    /// The argument is any iterator of `&Todo`, so a caller that shares todos
    /// through `Rc<Todo>` can collect references without cloning the values.
    #[must_use]
    pub fn collect<'a>(todos: impl IntoIterator<Item = &'a Todo>) -> Self {
        let mut projects: Vec<String> = Vec::new();
        let mut contexts: Vec<String> = Vec::new();

        for todo in todos {
            for project in &todo.projects {
                if !projects.contains(project) {
                    projects.push(project.clone());
                }
            }
            for context in &todo.contexts {
                if !contexts.contains(context) {
                    contexts.push(context.clone());
                }
            }
        }

        projects.sort();
        contexts.sort();
        Self { projects, contexts }
    }

    /// The items for one tag kind.
    #[must_use]
    pub fn items(&self, kind: TagKind) -> &[String] {
        match kind {
            TagKind::Project => &self.projects,
            TagKind::Context => &self.contexts,
        }
    }

    /// True when any todo uses the name.
    #[must_use]
    pub fn contains(&self, kind: TagKind, name: &str) -> bool {
        self.items(kind).iter().any(|item| item == name)
    }
}

/// True for the characters a tag name may hold: JavaScript `\w`, `.` and `-`.
fn is_name_char(character: char) -> bool {
    character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | '-')
}

/// A `+project`/`@context` word being typed at the cursor.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TagWordStart {
    /// The word including its prefix, e.g. `+thar`.
    pub word: String,
    /// Character index of the prefix inside the text before the cursor.
    pub start: usize,
    /// Project or context.
    pub kind: TagKind,
    /// The text after the prefix, e.g. `thar`.
    pub term: String,
}

/// Detect the tag word at the end of `left` (the text before the cursor).
///
/// Two shapes match, mirroring `matchTagWordStart`: a whole-string
/// `^[+@][\w.\-_]*$`, or `\s[+@][\w.\-_]*$` — the word must start a word, and
/// an empty term (`+` alone) is a valid word start that lists everything.
#[must_use]
pub fn match_tag_word_start(left: &str) -> Option<TagWordStart> {
    let chars: Vec<char> = left.chars().collect();
    let len = chars.len();

    let mut start = len;
    while start > 0 && is_name_char(chars[start - 1]) {
        start -= 1;
    }
    if start == 0 {
        return None;
    }

    let prefix = chars[start - 1];
    let kind = match prefix {
        '+' => TagKind::Project,
        '@' => TagKind::Context,
        _ => return None,
    };
    let start = start - 1;

    // Either the prefix starts the text, or a whitespace character precedes it.
    if start > 0 && !thar_core::is_js_whitespace(chars[start - 1]) {
        return None;
    }

    Some(TagWordStart {
        word: chars[start..].iter().collect(),
        start,
        kind,
        term: chars[start + 1..].iter().collect(),
    })
}

/// The prefix a kind is written with.
#[must_use]
pub const fn tag_prefix(kind: TagKind) -> char {
    match kind {
        TagKind::Project => '+',
        TagKind::Context => '@',
    }
}

/// The current suggestion list, selection, and the word it belongs to.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Suggestions {
    kind: Option<TagKind>,
    items: Vec<String>,
    selected: usize,
    /// Character index where the typed word starts.
    start: usize,
}

impl Suggestions {
    /// An empty list.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// True while the popup owns Enter/Tab/Up/Down/Escape.
    #[must_use]
    pub fn is_open(&self) -> bool {
        !self.items.is_empty()
    }

    /// The matching names, in source order.
    #[must_use]
    pub fn items(&self) -> &[String] {
        &self.items
    }

    /// Index of the highlighted item.
    #[must_use]
    pub fn selected(&self) -> usize {
        self.selected
    }

    /// Project or context of the open list.
    #[must_use]
    pub fn kind(&self) -> TagKind {
        self.kind.unwrap_or(TagKind::Project)
    }

    /// Character index where the typed word starts.
    #[must_use]
    pub fn start(&self) -> usize {
        self.start
    }

    /// Drop the list.
    pub fn clear(&mut self) {
        *self = Self::default();
    }

    /// Recompute the list for `text` with the cursor at `cursor`.
    ///
    /// The selection always returns to the first item, matching
    /// `updateSuggestions`, so narrowing a query never leaves the highlight on
    /// a row the user can no longer see.
    pub fn update(&mut self, sources: &TagSources, text: &str, cursor: usize) {
        let chars: Vec<char> = text.chars().collect();
        let left: String = chars[..cursor.min(chars.len())].iter().collect();

        let Some(word_start) = match_tag_word_start(&left) else {
            self.clear();
            return;
        };

        let term = word_start.term.to_lowercase();
        let matches: Vec<String> = sources
            .items(word_start.kind)
            .iter()
            .filter(|item| item.to_lowercase().starts_with(&term))
            .cloned()
            .collect();

        if matches.is_empty() {
            self.clear();
            return;
        }

        self.kind = Some(word_start.kind);
        self.items = matches;
        self.selected = 0;
        self.start = word_start.start;
    }

    /// Move the highlight up, wrapping to the last item.
    pub fn select_previous(&mut self) {
        if self.items.is_empty() {
            return;
        }
        self.selected = if self.selected == 0 {
            self.items.len() - 1
        } else {
            self.selected - 1
        };
    }

    /// Move the highlight down, wrapping to the first item.
    pub fn select_next(&mut self) {
        if self.items.is_empty() {
            return;
        }
        self.selected = if self.selected + 1 >= self.items.len() {
            0
        } else {
            self.selected + 1
        };
    }

    /// The highlighted name, if any.
    #[must_use]
    pub fn selected_item(&self) -> Option<&str> {
        self.items.get(self.selected).map(String::as_str)
    }

    /// Apply the highlighted name to `text`, replacing the typed word.
    ///
    /// Returns the new text and cursor (both in character indexes). The insert
    /// is `prefix + name + " "` and everything after the cursor is preserved,
    /// exactly like `applySuggestion`.
    #[must_use]
    pub fn apply(&self, text: &str, cursor: usize) -> Option<(String, usize)> {
        let name = self.selected_item()?;
        let chars: Vec<char> = text.chars().collect();
        let cursor = cursor.min(chars.len());
        let start = self.start.min(cursor);

        let mut next: Vec<char> = chars[..start].to_vec();
        next.push(tag_prefix(self.kind()));
        next.extend(name.chars());
        next.push(' ');
        let new_cursor = next.len();
        next.extend(&chars[cursor..]);

        Some((next.into_iter().collect(), new_cursor))
    }
}

/// Largest number of suggestion rows drawn at once.
pub const MAX_ROWS: usize = 6;

/// The terminal cell where the typed `+`/`@` marker starts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Anchor {
    /// 0-based column.
    pub x: u16,
    /// 0-based row.
    pub y: u16,
}

/// A suggestion list plus the cell it should be anchored under.
///
/// The view layer owns the popup geometry; this type is the seam between the
/// editor/search state and that geometry. It borrows the list, so it cannot
/// outlive the screen that owns it.
pub struct Overlay<'a> {
    /// Cell of the typed marker.
    pub anchor: Anchor,
    /// The filtered list.
    pub suggestions: &'a Suggestions,
}

/// The visible slice of a suggestion list.
///
/// The whole list is drawn while it is short enough; otherwise the window
/// scrolls so the highlighted item is the last visible row at most.
#[must_use]
pub fn visible_range(len: usize, selected: usize, cap: usize) -> (usize, usize) {
    if len <= cap {
        return (0, len);
    }
    let start = selected.saturating_sub(cap.saturating_sub(1));
    (start, (start + cap).min(len))
}

#[cfg(test)]
mod tests {
    use super::{Suggestions, TagKind, TagSources, match_tag_word_start, tag_prefix};
    use thar_core::{Todo, TodoId};

    fn sources(projects: &[&str], contexts: &[&str]) -> TagSources {
        TagSources {
            projects: projects.iter().map(|name| (*name).to_owned()).collect(),
            contexts: contexts.iter().map(|name| (*name).to_owned()).collect(),
        }
    }

    #[test]
    fn sources_are_collected_unique_and_sorted_from_every_todo() {
        let lines = [
            "one +thar @work",
            "two +alpha @home +thar",
            "three @work +beta",
        ];
        let todos: Vec<Todo> = lines
            .iter()
            .enumerate()
            .map(|(index, line)| Todo::parse_line(line, TodoId::new(index as u64)))
            .collect();
        let sources = TagSources::collect(&todos);
        assert_eq!(sources.projects, ["alpha", "beta", "thar"]);
        assert_eq!(sources.contexts, ["home", "work"]);
        assert!(sources.contains(TagKind::Project, "thar"));
        assert!(!sources.contains(TagKind::Context, "thar"));
        assert_eq!(
            TagSources::collect(std::iter::empty::<&Todo>()),
            TagSources::default()
        );
    }

    #[test]
    fn word_starts_match_the_oracle_shapes() {
        let cases = [
            ("+thar", Some(("+thar", 0, TagKind::Project, "thar"))),
            ("@home", Some(("@home", 0, TagKind::Context, "home"))),
            ("buy +th", Some(("+th", 4, TagKind::Project, "th"))),
            ("buy\t@ho", Some(("@ho", 4, TagKind::Context, "ho"))),
            ("buy  +", Some(("+", 5, TagKind::Project, ""))),
            ("+", Some(("+", 0, TagKind::Project, ""))),
            // A name alphabet of `[\w.\-_]`.
            (
                "+a.b-c_d",
                Some(("+a.b-c_d", 0, TagKind::Project, "a.b-c_d")),
            ),
            // Not a word start: no whitespace before the prefix, or a
            // non-name character after it.
            ("buy+th", None),
            ("buy +th!", None),
            ("buy @th+ar", None),
            ("", None),
            ("   ", None),
            ("+th ar", None),
            // An emoji is not a name character.
            ("+th🎉", None),
        ];

        for (left, expected) in cases {
            let actual = match_tag_word_start(left)
                .map(|word| (word.word, word.start, word.kind, word.term));
            let expected = expected
                .map(|(word, start, kind, term)| (word.to_owned(), start, kind, term.to_owned()));
            assert_eq!(actual, expected, "{left:?}");
        }
    }

    #[test]
    fn filtering_is_case_insensitive_prefix_only_and_resets_the_selection() {
        let sources = sources(&["thar", "Thar-tui", "other"], &["home", "work"]);
        let mut suggestions = Suggestions::new();

        suggestions.update(&sources, "+th", 3);
        assert!(suggestions.is_open());
        assert_eq!(suggestions.kind(), TagKind::Project);
        assert_eq!(suggestions.items(), ["thar", "Thar-tui"]);
        assert_eq!(suggestions.selected(), 0);
        assert_eq!(suggestions.start(), 0);

        suggestions.select_next();
        assert_eq!(suggestions.selected(), 1);

        // Narrowing resets to the first match.
        suggestions.update(&sources, "+tha", 4);
        assert_eq!(suggestions.selected(), 0);
        assert_eq!(suggestions.items(), ["thar", "Thar-tui"]);

        // `starts_with`, not a substring or fuzzy match.
        suggestions.update(&sources, "+har", 4);
        assert!(!suggestions.is_open());

        // A mid-text word start still finds the right range.
        suggestions.update(&sources, "buy +th", 7);
        assert_eq!(suggestions.start(), 4);

        // No word start clears the list.
        suggestions.update(&sources, "buy milk", 8);
        assert!(!suggestions.is_open());
    }

    #[test]
    fn selection_wraps_at_both_ends() {
        let sources = sources(&["alpha", "beta", "gamma"], &[]);
        let mut suggestions = Suggestions::new();
        suggestions.update(&sources, "+", 1);
        assert_eq!(suggestions.items().len(), 3);

        suggestions.select_previous();
        assert_eq!(suggestions.selected(), 2);
        suggestions.select_next();
        assert_eq!(suggestions.selected(), 0);
        suggestions.select_next();
        assert_eq!(suggestions.selected(), 1);

        // A cleared list ignores movement.
        suggestions.clear();
        suggestions.select_next();
        suggestions.select_previous();
        assert_eq!(suggestions.selected(), 0);
        assert_eq!(suggestions.selected_item(), None);
    }

    #[test]
    fn apply_replaces_the_typed_word_and_adds_one_space() {
        let sources = sources(&["thar"], &["home"]);
        let mut suggestions = Suggestions::new();

        suggestions.update(&sources, "+th", 3);
        assert_eq!(suggestions.apply("+th", 3), Some(("+thar ".to_owned(), 6)));

        // Mid-text: the word is replaced, the tail after the cursor stays.
        suggestions.update(&sources, "buy +th later", 7);
        assert_eq!(
            suggestions.apply("buy +th later", 7),
            Some(("buy +thar  later".to_owned(), 10))
        );

        // Contexts use `@`.
        suggestions.update(&sources, "@ho", 3);
        assert_eq!(suggestions.apply("@ho", 3), Some(("@home ".to_owned(), 6)));

        // A closed list applies nothing.
        suggestions.clear();
        assert_eq!(suggestions.apply("+th", 3), None);
        assert_eq!(tag_prefix(TagKind::Project), '+');
        assert_eq!(tag_prefix(TagKind::Context), '@');
    }
}
