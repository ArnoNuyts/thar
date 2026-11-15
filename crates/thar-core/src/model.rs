//! The `Todo` model, its `todo.txt` parser, and serialization.
//!
//! Behaviour follows `logic/todo.ts` exactly:
//!
//! - leading `x`, `(A)`, and `YYYY-MM-DD` tokens are consumed only when they
//!   are valid and unambiguous; otherwise they stay in `text` so the line
//!   round-trips;
//! - completed lines take a completion date and an optional creation date;
//! - `+project` / `@context` names dedupe in first-occurrence order;
//! - tag keys keep insertion order and duplicate keys become
//!   [`TagValue::Many`];
//! - tags are stripped from the text and serialized at the end.
//!
//! Everything here takes `&str` that is already decoded. The Node reader decodes
//! file bytes with [`String::from_utf8_lossy`], so invalid UTF-8 reaches this
//! module as `U+FFFD` and is treated as ordinary text; the crate never rejects
//! it. Keeping that boundary lossy is what makes the corpus byte-parity hold
//! for `invalid-utf8.txt`.
//!
//! TODO(CP3): the immutable setters (`toggle`, `set_due`, `set_priority`, …) are
//! deliberately not here yet. When CP2b/CP3 adds them, keep them encapsulated
//! (private fields, `fn(self) -> Self` builders) rather than exposing mutable
//! fields, so `dates_in_text`/`completion_date_in_text` cannot be desynchronized
//! from the text by a caller.

use core::fmt;
use core::fmt::Write as _;

use crate::date::TodoDate;
use crate::js::{is_js_whitespace, js_trim};
use crate::scan::{ScannedTag, scan_contexts, scan_prefix, scan_projects, scan_tags};
use TagValue::{Many, One};

/// Stable todo identifier, assigned by parse/load order.
///
/// Encapsulated like the other value newtypes: the adapter converts it to a JS
/// number at the boundary. The TypeScript app uses `symbol` ids today; the
/// adapter maps between the two during the incremental phase.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TodoId(u64);

impl TodoId {
    /// Wrap a load-order index.
    #[must_use]
    pub const fn new(value: u64) -> Self {
        Self(value)
    }

    /// The numeric id, safe to hand to JavaScript as a `number`.
    #[must_use]
    pub const fn value(self) -> u64 {
        self.0
    }
}

/// Completion state of a todo.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum State {
    /// Open todo (no `x` marker).
    Todo,
    /// Completed todo (leading `x`).
    Done,
}

impl State {
    /// True for [`State::Done`].
    #[must_use]
    pub const fn is_done(self) -> bool {
        matches!(self, Self::Done)
    }
}

/// A validated `(A)` .. `(Z)` priority.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Priority(char);

impl Priority {
    /// Build a priority from an uppercase ASCII letter.
    #[must_use = "a rejected letter is a deliberate None"]
    pub const fn new(letter: char) -> Option<Self> {
        if letter.is_ascii_uppercase() {
            Some(Self(letter))
        } else {
            None
        }
    }

    /// The letter, always `A`..`Z`.
    #[must_use]
    pub const fn as_char(self) -> char {
        self.0
    }
}

/// A tag value: one occurrence, or an array when the key repeats.
///
/// The TypeScript model stores `string | string[]`; duplicate keys append in
/// encounter order and serialize comma-joined, so a repeated `beta` tag becomes
/// `beta:one,two`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TagValue {
    /// A single occurrence.
    One(String),
    /// Two or more occurrences, in encounter order.
    Many(Vec<String>),
}

impl TagValue {
    /// Iterate over the values in encounter order.
    pub fn values(&self) -> impl Iterator<Item = &str> {
        let values: &[String] = match self {
            Self::One(value) => core::slice::from_ref(value),
            Self::Many(values) => values,
        };
        values.iter().map(String::as_str)
    }

    /// The value when the key occurs exactly once.
    #[must_use = "a repeated key is a deliberate None"]
    pub fn as_single(&self) -> Option<&str> {
        match self {
            Self::One(value) => Some(value),
            Self::Many(_) => None,
        }
    }

    /// Append a duplicate occurrence, converting `One` into `Many`.
    fn push_value(&mut self, value: String) {
        match self {
            Self::Many(values) => values.push(value),
            Self::One(first) => {
                // One `match` instead of two sequential `if let`s: reaching
                // this arm proves the value is `One`.
                let first = core::mem::take(first);
                *self = Self::Many(vec![first, value]);
            }
        }
    }
}

/// One `todo.txt` line, in parsed form.
///
/// Fields are public so the model stays a plain data type; use
/// [`Todo::parse_line`] to build one, because the flag fields
/// (`dates_in_text`, `completion_date_in_text`) encode round-trip decisions
/// that cannot be re-derived from the other fields alone.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Todo {
    /// Identifier assigned by the caller (parse/load order).
    pub id: TodoId,
    /// Remaining text after the prefix and all tags were removed, trimmed.
    pub text: String,
    /// Completion state.
    pub state: State,
    /// `(A)`..`(Z)` priority, if any.
    pub priority: Option<Priority>,
    /// Completion date (`x DATE ...`), if any.
    pub completion_date: Option<TodoDate>,
    /// Creation date (`DATE ...` or `x COMPLETION CREATION ...`), if any.
    pub creation_date: Option<TodoDate>,
    /// `+projects` in first-occurrence order.
    pub projects: Vec<String>,
    /// `@contexts` in first-occurrence order.
    pub contexts: Vec<String>,
    /// Tags in insertion order; repeated keys are grouped into [`TagValue::Many`].
    pub tags: Vec<(String, TagValue)>,
    /// True when leading date tokens stayed in `text`, so the creation date
    /// must not be prepended again.
    pub dates_in_text: bool,
    /// True when the completion date is already the leading literal token in
    /// `text` (invalid or ambiguous done line), so it must not be prepended.
    pub completion_date_in_text: bool,
}

impl Todo {
    /// Parse one raw line.
    ///
    /// This never fails: every `&str` is accepted, including control
    /// characters and blank lines. The input must already be decoded text (the
    /// Node reader decodes file bytes lossily, so invalid UTF-8 is `U+FFFD`
    /// here). File-level policy (limits, CRLF, rejected controls) lives in
    /// [`crate::validate_file_content`].
    #[must_use]
    pub fn parse_line(line: &str, id: TodoId) -> Self {
        let prefix = scan_prefix(line);
        let date_section = &line[prefix.date_start_index..];
        let remainder = &line[prefix.end_index..];
        let has_body = !js_trim(remainder).is_empty();
        let can_consume_dates = !prefix.date_tokens.is_empty()
            && prefix.invalid_date_tokens.is_empty()
            && has_body
            && (prefix.has_done_marker || prefix.date_tokens.len() == 1);

        let mut todo = Self {
            id,
            text: String::new(),
            state: if prefix.has_done_marker {
                State::Done
            } else {
                State::Todo
            },
            priority: prefix.priority,
            completion_date: None,
            creation_date: None,
            projects: Vec::new(),
            contexts: Vec::new(),
            tags: Vec::new(),
            dates_in_text: false,
            completion_date_in_text: false,
        };

        let date_at = |index: usize| {
            prefix
                .date_tokens
                .get(index)
                .and_then(|token| TodoDate::parse(token))
        };

        let text = if can_consume_dates {
            if prefix.has_done_marker {
                todo.completion_date = date_at(0);
                todo.creation_date = date_at(1);
            } else {
                todo.creation_date = date_at(0);
            }
            remainder
        } else {
            if !prefix.date_tokens.is_empty() {
                // Keep invalid or ambiguous leading dates literal so the line
                // round-trips, but still expose the unambiguous dates.
                todo.dates_in_text = true;
                if prefix.has_done_marker {
                    todo.completion_date = date_at(0);
                    todo.completion_date_in_text = todo.completion_date.is_some();
                    todo.creation_date = date_at(1);
                } else if prefix.date_tokens.len() == 1 && prefix.invalid_date_tokens.is_empty() {
                    todo.creation_date = date_at(0);
                }
            }
            date_section
        };

        todo.parse_text(text);
        todo
    }

    /// Strip and collect projects, contexts, and tags, then trim the text.
    fn parse_text(&mut self, text: &str) {
        self.projects = scan_projects(text);
        self.contexts = scan_contexts(text);

        // `scan_tags` owns the stripped copy, so trim it in place instead of
        // allocating a second `String` for the trimmed slice.
        let (scanned, mut stripped) = scan_tags(text);
        self.tags = collect_tags(scanned);
        trim_in_place(&mut stripped);
        self.text = stripped;
    }

    /// Serialize back to a `todo.txt` line.
    ///
    /// Order: `x `, `(P) `, completion date (unless it is in the text),
    /// creation date (unless the dates are in the text), text, and one leading
    /// space plus the space-joined tags when any tag exists.
    ///
    /// This is exactly [`Display`](fmt::Display) for [`Todo`]; the method stays
    /// because it reads better at call sites and names the domain operation.
    #[must_use]
    pub fn serialize(&self) -> String {
        let mut line = String::with_capacity(self.text.len() + 32);
        write!(&mut line, "{self}").expect("writing to a String cannot fail");
        line
    }

    /// True for completed todos.
    #[must_use]
    pub fn is_done(&self) -> bool {
        self.state.is_done()
    }

    /// True when the `h` tag hides the todo (`h:0` does not hide it).
    ///
    /// A repeated `h` key is always hidden, matching the array-valued tag
    /// behaviour in the TypeScript model.
    #[must_use]
    pub fn is_hidden(&self) -> bool {
        match self.tag("h") {
            None => false,
            Some(One(value)) => value != "0",
            Some(Many(_)) => true,
        }
    }

    /// True when `due` is a valid date and `due <= today`.
    ///
    /// A missing, malformed, or array-valued `due` tag is never overdue.
    #[must_use]
    pub fn is_overdue(&self, today: TodoDate) -> bool {
        self.date_tag("due").is_some_and(|due| due <= today)
    }

    /// True when the `t` (threshold) tag does not hide the todo.
    ///
    /// A missing or malformed threshold does not hide the todo.
    #[must_use]
    pub fn is_passed_threshold(&self, today: TodoDate) -> bool {
        self.date_tag("t")
            .is_none_or(|threshold| threshold <= today)
    }

    /// True when the todo is neither hidden nor inside its threshold window.
    #[must_use]
    pub fn is_visible_in_overview(&self, today: TodoDate) -> bool {
        !self.is_hidden() && self.is_passed_threshold(today)
    }

    /// Look up a tag by key; the first occurrence wins.
    ///
    /// TODO(CP3): this is a linear scan per lookup, so a line with many tags
    /// costs O(tags²) across `is_hidden`/`is_overdue`/`is_passed_threshold`.
    /// Replace the `Vec<(String, TagValue)>` with an insertion-ordered
    /// key→index map once row building does the same lookups per frame.
    #[must_use = "a missing tag is meaningful"]
    pub fn tag(&self, key: &str) -> Option<&TagValue> {
        self.tags
            .iter()
            .find(|(existing, _)| existing == key)
            .map(|(_, value)| value)
    }

    /// Parse the tag `key` as a strict `YYYY-MM-DD` date.
    ///
    /// Array-valued tags are not dates.
    #[must_use = "an absent or array-valued tag is a deliberate None"]
    pub fn date_tag(&self, key: &str) -> Option<TodoDate> {
        self.tag(key)
            .and_then(TagValue::as_single)
            .and_then(TodoDate::parse)
    }

    /// Identity of the todo, identical to its serialized line.
    #[must_use]
    pub fn hash(&self) -> String {
        self.serialize()
    }
}

impl fmt::Display for Todo {
    /// The canonical `todo.txt` line, written without intermediate `String`s.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.state.is_done() {
            f.write_str("x ")?;
        }
        if let Some(priority) = self.priority {
            write!(f, "({}) ", priority.as_char())?;
        }
        if !self.completion_date_in_text
            && let Some(date) = self.completion_date
        {
            write!(f, "{date} ")?;
        }
        if !self.dates_in_text
            && let Some(date) = self.creation_date
        {
            write!(f, "{date} ")?;
        }

        f.write_str(&self.text)?;

        if !self.tags.is_empty() {
            f.write_str(" ")?;
            for (index, (key, value)) in self.tags.iter().enumerate() {
                if index > 0 {
                    f.write_str(" ")?;
                }
                f.write_str(key)?;
                f.write_str(":")?;
                for (value_index, value) in value.values().enumerate() {
                    if value_index > 0 {
                        f.write_str(",")?;
                    }
                    f.write_str(value)?;
                }
            }
        }

        Ok(())
    }
}

/// Trim JavaScript whitespace from both ends of an owned string in place.
fn trim_in_place(text: &mut String) {
    let Some(start) = text.find(|character| !is_js_whitespace(character)) else {
        text.clear();
        return;
    };
    let end = text.trim_end_matches(is_js_whitespace).len();
    text.truncate(end);
    text.drain(..start);
}

/// Group scanned tags into insertion-ordered values.
fn collect_tags(scanned: Vec<ScannedTag<'_>>) -> Vec<(String, TagValue)> {
    let mut tags: Vec<(String, TagValue)> = Vec::new();

    for tag in scanned {
        match tags
            .iter_mut()
            .find(|(existing, _)| existing.as_str() == tag.key)
        {
            Some((_, value)) => value.push_value(tag.value.to_owned()),
            None => tags.push((tag.key.to_owned(), One(tag.value.to_owned()))),
        }
    }

    tags
}

/// Serialize todos exactly as the file writer does: lines joined by `\n` plus
/// one trailing newline. Serializing no todos yields `"\n"`, matching
/// `lines.join("\n") + "\n"` in `logic/todo-file-helpers.ts`.
#[must_use]
pub fn serialize_file(todos: &[Todo]) -> String {
    let mut output = String::new();
    for (index, todo) in todos.iter().enumerate() {
        if index > 0 {
            output.push('\n');
        }
        write!(&mut output, "{todo}").expect("writing to a String cannot fail");
    }
    output.push('\n');
    output
}

#[cfg(test)]
mod tests {
    use super::{Priority, State, TagValue, Todo, TodoId, serialize_file};
    use crate::date::TodoDate;

    fn parse(line: &str) -> Todo {
        Todo::parse_line(line, TodoId::new(0))
    }

    fn today() -> TodoDate {
        TodoDate::new(2026, 11, 15).expect("valid today")
    }

    #[test]
    fn parses_prefixes_and_serializes_them() {
        let todo = parse("x (A) 2024-03-02 2024-03-01 done with priority");
        assert_eq!(todo.state, State::Done);
        assert_eq!(todo.priority.map(Priority::as_char), Some('A'));
        assert_eq!(
            todo.completion_date,
            Some(TodoDate::new(2024, 3, 2).expect("valid"))
        );
        assert_eq!(
            todo.creation_date,
            Some(TodoDate::new(2024, 3, 1).expect("valid"))
        );
        assert_eq!(todo.text, "done with priority");
        assert_eq!(
            todo.serialize(),
            "x (A) 2024-03-02 2024-03-01 done with priority"
        );
        assert_eq!(todo.hash(), todo.serialize());
    }

    #[test]
    fn keeps_invalid_leading_dates_in_text() {
        let todo = parse("x 2023-05-04 2023-02-29 second date is invalid");
        assert_eq!(todo.text, "2023-05-04 2023-02-29 second date is invalid");
        assert!(todo.dates_in_text);
        assert!(todo.completion_date_in_text);
        assert_eq!(
            todo.completion_date,
            Some(TodoDate::new(2023, 5, 4).expect("valid"))
        );
        assert_eq!(todo.creation_date, None);
        assert_eq!(
            todo.serialize(),
            "x 2023-05-04 2023-02-29 second date is invalid"
        );
    }

    #[test]
    fn two_valid_dates_without_done_marker_stay_literal() {
        let todo = parse("2023-05-04 2023-05-05 two leading dates");
        assert_eq!(todo.text, "2023-05-04 2023-05-05 two leading dates");
        assert!(todo.dates_in_text);
        assert_eq!(todo.creation_date, None);
        assert_eq!(todo.serialize(), "2023-05-04 2023-05-05 two leading dates");
    }

    #[test]
    fn single_valid_date_needs_a_body_to_be_consumed() {
        let todo = parse("2023-05-04");
        assert_eq!(todo.text, "2023-05-04");
        assert!(todo.dates_in_text);
        assert_eq!(
            todo.creation_date,
            Some(TodoDate::new(2023, 5, 4).expect("valid"))
        );
        assert_eq!(todo.serialize(), "2023-05-04");
    }

    #[test]
    fn x_alone_is_an_open_todo() {
        let todo = parse("x");
        assert_eq!(todo.state, State::Todo);
        assert_eq!(todo.text, "x");
        assert_eq!(todo.serialize(), "x");
    }

    #[test]
    fn priority_without_text_keeps_its_trailing_space() {
        let todo = parse("(A) ");
        assert_eq!(todo.text, "");
        assert_eq!(todo.priority.map(Priority::as_char), Some('A'));
        assert_eq!(todo.serialize(), "(A) ");
    }

    #[test]
    fn tags_move_to_the_end_in_insertion_order() {
        let todo = parse("alpha:one single tag");
        assert_eq!(todo.text, "single tag");
        assert_eq!(
            todo.tags,
            vec![("alpha".to_owned(), TagValue::One("one".to_owned()))]
        );
        assert_eq!(todo.serialize(), "single tag alpha:one");
    }

    #[test]
    fn duplicate_tag_keys_become_many_and_join_with_commas() {
        let todo = parse("beta:one beta:two text");
        assert_eq!(
            todo.tags,
            vec![(
                "beta".to_owned(),
                TagValue::Many(vec!["one".to_owned(), "two".to_owned()])
            )]
        );
        assert_eq!(todo.serialize(), "text beta:one,two");
    }

    #[test]
    fn http_is_parsed_as_a_tag() {
        let todo = parse("see http://example.com now");
        assert_eq!(todo.text, "see now");
        assert_eq!(
            todo.tag("http").and_then(TagValue::as_single),
            Some("//example.com")
        );
    }

    #[test]
    fn projects_and_contexts_dedupe_in_order() {
        let todo = parse("+a +b +a @x @y @x text");
        assert_eq!(todo.projects, vec!["a".to_owned(), "b".to_owned()]);
        assert_eq!(todo.contexts, vec!["x".to_owned(), "y".to_owned()]);
        assert_eq!(todo.serialize(), "+a +b +a @x @y @x text");
    }

    #[test]
    fn hidden_and_threshold_follow_the_ts_rules() {
        let today = today();
        assert!(!parse("plain").is_hidden());
        assert!(!parse("h:0 anything").is_hidden());
        assert!(parse("h:1 anything").is_hidden());
        assert!(parse("h:x anything").is_hidden());
        assert!(parse("h:1 h:0 anything").is_hidden());

        assert!(!parse("future t:2026-11-16").is_visible_in_overview(today));
        assert!(parse("today t:2026-11-15").is_visible_in_overview(today));
        assert!(parse("past t:2026-11-14").is_visible_in_overview(today));
        assert!(parse("invalid t:2026-02-30").is_visible_in_overview(today));
        assert!(parse("missing threshold").is_visible_in_overview(today));
    }

    #[test]
    fn overdue_requires_a_valid_single_due_date() {
        let today = today();
        assert!(parse("due:2026-11-14 overdue").is_overdue(today));
        assert!(parse("due:2026-11-15 due today").is_overdue(today));
        assert!(!parse("due:2026-11-16 future").is_overdue(today));
        assert!(!parse("due:2026-02-30 invalid").is_overdue(today));
        assert!(!parse("due:2026-11-14 due:2026-11-15 array").is_overdue(today));
        assert!(!parse("no due").is_overdue(today));
    }

    #[test]
    fn tag_only_line_serializes_with_one_leading_space() {
        let todo = parse("alpha:one");
        assert_eq!(todo.text, "");
        assert_eq!(todo.serialize(), " alpha:one");
    }

    #[test]
    fn blank_line_parses_to_an_empty_open_todo() {
        let todo = parse("   \t ");
        assert_eq!(todo.state, State::Todo);
        assert_eq!(todo.text, "");
        assert_eq!(todo.serialize(), "");
    }

    #[test]
    fn js_whitespace_and_bom_are_trimmed_but_nel_is_text() {
        // `bom.txt`: the BOM is not stripped by the reader, only by trim.
        let bom = parse("\u{FEFF}first todo after a BOM");
        assert_eq!(bom.text, "first todo after a BOM");
        assert_eq!(bom.serialize(), "first todo after a BOM");

        // The rest of the JS `\s` set behaves like `String.prototype.trim()`.
        for whitespace in ["\u{00A0}", "\u{2003}", "\u{3000}", "\u{2029}"] {
            let todo = parse(&format!(
                "{whitespace}text with{whitespace}tag:x{whitespace}"
            ));
            assert_eq!(todo.text, "text with", "whitespace {whitespace:?}");
            assert_eq!(
                todo.tags,
                vec![("tag".to_owned(), TagValue::One("x".to_owned()))]
            );
            assert_eq!(todo.serialize(), "text with tag:x");
        }

        // U+0085 (NEL) is not ECMAScript whitespace, so it stays in the text.
        let nel = parse("\u{0085}kept\u{0085}");
        assert_eq!(nel.text, "\u{0085}kept\u{0085}");
        assert_eq!(nel.serialize(), "\u{0085}kept\u{0085}");
    }

    #[test]
    fn tabs_survive_inside_text() {
        let todo = parse("tab\tinside\tline");
        assert_eq!(todo.text, "tab\tinside\tline");
        assert_eq!(todo.serialize(), "tab\tinside\tline");
    }

    #[test]
    fn serialize_file_joins_with_a_final_newline() {
        let todos = vec![parse("one"), parse("two")];
        assert_eq!(serialize_file(&todos), "one\ntwo\n");
        assert_eq!(serialize_file(&[]), "\n");
    }

    #[test]
    fn ids_are_kept() {
        let todo = Todo::parse_line("task", TodoId::new(42));
        assert_eq!(todo.id, TodoId::new(42));
    }
}
