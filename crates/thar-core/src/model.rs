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
//! # Immutable setters
//!
//! The `set_*`/`add_*`/`remove_*`/`toggle_*` builders take `self` and return the
//! updated value, so a caller that wants copy-on-write clones first
//! (`todo.clone().set_due(day)`). Nothing here mutates a borrowed todo, and
//! `Clone` deep-copies `projects`, `contexts`, and every tag array, exactly
//! like `Todo#clone` in `logic/todo.ts`.
//!
//! Two oracle quirks are preserved on purpose:
//!
//! - `set_text` re-parses projects, contexts, and tags from the new text. With
//!   `preserve_tags` (used by the project/context editors) parsed tags override
//!   the programmatic ones while keeping their original insertion position.
//! - `remove_context`/`remove_project` interpolate the name into the oracle's
//!   `\s*@name(?=\s|$)` regex, where a `.` in the name is a regex any-character.
//!   A stored name is otherwise `[A-Za-z0-9_.\-]`, so `.` is the only
//!   metacharacter that can occur; `remove_mention` reproduces it. JavaScript's
//!   `.` matches exactly one UTF-16 code unit and never a line terminator, so
//!   it cannot consume an astral character (a surrogate pair). Other regex
//!   metacharacters are outside the parity surface: names are scanned from
//!   text, and programmatic names become opaque with the CP3b API.

use core::fmt;
use core::fmt::Write as _;

use crate::date::TodoDate;
use crate::js::{is_js_whitespace, js_trim, whitespace_prefix_len};
use crate::recurrence::{Recurrence, RecurrenceError, plan_recurrence};
use crate::scan::{ScannedTag, scan_contexts, scan_prefix, scan_projects, scan_tags};
use TagValue::{Many, One};

/// Stable todo identifier, assigned by parse/load order.
///
/// Encapsulated like the other value newtypes: the adapter converts it to a JS
/// number at the boundary. The TypeScript app uses `symbol` ids today; the
/// adapter maps between the two during the incremental phase.
///
/// The value is a load-order index, so it is bounded by the reader's todo
/// limit ([`crate::DEFAULT_MAX_READ_TODOS`], currently 10 000) and always
/// inside JavaScript's safe-integer range (`2^53 - 1`). A caller that
/// allocates ids itself must keep that bound: a larger value still converts
/// losslessly on the Rust side, but the JavaScript `number` round-trip does
/// not.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TodoId(u64);

impl TodoId {
    /// Wrap a load-order index.
    ///
    /// The caller owns the bound: keep it inside the safe-integer range if the
    /// id crosses into JavaScript as a `number` (see the type docs).
    #[must_use]
    pub const fn new(value: u64) -> Self {
        Self(value)
    }

    /// The numeric id, safe to hand to JavaScript as a `number` for
    /// load-order ids (see the type docs).
    #[must_use]
    pub const fn value(self) -> u64 {
        self.0
    }
}

/// Completion state of a todo.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum State {
    /// Open todo (no `x` marker).
    #[default]
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

/// The parsed pieces of a [`Todo`], used to rebuild one at a boundary.
///
/// A `Todo` cannot always be reconstructed by re-parsing its serialized line
/// (array-valued tags collapse into a comma list, and the round-trip flags are
/// not visible in the text), so a caller that already holds the parsed fields
/// hands them back through [`Todo::from_parts`] instead.
///
/// Every non-text field is a type that validates itself ([`State`],
/// [`Priority`], [`TodoDate`], [`TagValue`]), so a `TodoParts` is always a
/// valid todo body. The two flags are the round-trip decisions
/// [`Todo::parse_line`] records; a caller that did not parse the line itself
/// must pass `false` rather than guess.
///
/// # Example
///
/// ```
/// use thar_core::{Todo, TodoId, TodoParts};
///
/// let todo = Todo::from_parts(
///     TodoId::new(7),
///     TodoParts {
///         text: "ship it @work".to_owned(),
///         contexts: vec!["work".to_owned()],
///         ..TodoParts::default()
///     },
/// );
/// assert_eq!(todo.id, TodoId::new(7));
/// assert_eq!(todo.to_string(), "ship it @work");
/// ```
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TodoParts {
    /// Body text, already trimmed and with tags removed.
    pub text: String,
    /// Completion state.
    pub state: State,
    /// `(A)`..`(Z)` priority, if any.
    pub priority: Option<Priority>,
    /// Completion date, if any.
    pub completion_date: Option<TodoDate>,
    /// Creation date, if any.
    pub creation_date: Option<TodoDate>,
    /// `+projects` in first-occurrence order.
    pub projects: Vec<String>,
    /// `@contexts` in first-occurrence order.
    pub contexts: Vec<String>,
    /// Tags in insertion order; repeated keys stay grouped as
    /// [`TagValue::Many`].
    pub tags: Vec<(String, TagValue)>,
    /// True when leading date tokens stayed in `text`.
    pub dates_in_text: bool,
    /// True when the completion date is already the leading literal token in
    /// `text`.
    pub completion_date_in_text: bool,
}

impl Todo {
    /// Rebuild a todo from already-parsed parts.
    ///
    /// This does **not** re-parse `parts.text`, so the projects, contexts, and
    /// tags are taken exactly as supplied: it is the lossless direction for a
    /// boundary that already parsed the line (for example the WASM
    /// `build_rows` request). The parts are typed, so there is nothing to
    /// fail; the caller validates the wire form before building them.
    #[must_use]
    pub fn from_parts(id: TodoId, parts: TodoParts) -> Self {
        Self {
            id,
            text: parts.text,
            state: parts.state,
            priority: parts.priority,
            completion_date: parts.completion_date,
            creation_date: parts.creation_date,
            projects: parts.projects,
            contexts: parts.contexts,
            tags: parts.tags,
            dates_in_text: parts.dates_in_text,
            completion_date_in_text: parts.completion_date_in_text,
        }
    }
    /// The parsed pieces of this todo.
    ///
    /// The inverse of [`Todo::from_parts`]. A caller that hands a todo across a
    /// boundary (CP4's write path, or the row builder's request) passes these
    /// parts instead of the serialized line: the line collapses array-valued
    /// tags into a comma list and does not carry the two round-trip flags.
    ///
    /// The [`TodoId`] is not part of [`TodoParts`]; the receiving side assigns
    /// its own in load order.
    #[must_use]
    pub fn into_parts(self) -> TodoParts {
        TodoParts {
            text: self.text,
            state: self.state,
            priority: self.priority,
            completion_date: self.completion_date,
            creation_date: self.creation_date,
            projects: self.projects,
            contexts: self.contexts,
            tags: self.tags,
            dates_in_text: self.dates_in_text,
            completion_date_in_text: self.completion_date_in_text,
        }
    }

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
                .and_then(|token| token.parse::<TodoDate>().ok())
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

        todo.parse_text(text, false);
        todo
    }

    /// Strip and collect projects, contexts, and tags, then trim the text.
    ///
    /// Mirrors `internalParseText` in `logic/todo.ts`: the caller decides
    /// whether parsed tags replace or merge with the existing ones.
    fn parse_text(&mut self, text: &str, preserve_tags: bool) {
        self.projects = scan_projects(text);
        self.contexts = scan_contexts(text);

        // `scan_tags` owns the stripped copy, so trim it in place instead of
        // allocating a second `String` for the trimmed slice.
        let (scanned, mut stripped) = scan_tags(text);
        let parsed = collect_tags(scanned);

        if preserve_tags {
            // JavaScript object spread: an existing key keeps its position and
            // takes the new value; a new key is appended in scan order.
            for (key, value) in parsed {
                match self
                    .tags
                    .iter_mut()
                    .find(|(existing, _)| existing.as_str() == key)
                {
                    Some((_, existing)) => *existing = value,
                    None => self.tags.push((key, value)),
                }
            }
        } else {
            self.tags = parsed;
        }

        trim_in_place(&mut stripped);
        self.text = stripped;
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
    /// TODO(deferred optimization phase, not CP3b): this is a linear scan per
    /// lookup, so a line with many tags costs O(tags²) across
    /// `is_hidden`/`is_overdue`/`is_passed_threshold`. Replace the
    /// `Vec<(String, TagValue)>` with an insertion-ordered key→index map when
    /// the deferred row-builder optimization work lands (see
    /// `docs/rust-port/PLAN.md` §5 CP3b1/§13).
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
            .and_then(|value| value.parse::<TodoDate>().ok())
    }

    // ---- Immutable setters -------------------------------------------------
    //
    // Every builder consumes `self` and returns the updated todo. `Clone`
    // deep-copies the collections, so `todo.clone().set_due(day)` never
    // aliases the receiver's projects, contexts, or tag arrays.
    //
    // Date setters take a [`TodoDate`], which is always a real calendar day, so
    // the oracle's `isValidTodoDate` "return self unchanged" branch is
    // unreachable here instead of being an input case.

    /// Replace the body text, re-parsing projects, contexts, and tags.
    ///
    /// With `preserve_tags`, tags found in `text` override the current values
    /// but keep the current insertion order; without it the parsed tags replace
    /// the whole tag map. This mirrors `Todo#setText(text, { preserveTags })`.
    #[must_use]
    pub fn set_text(mut self, text: &str, preserve_tags: bool) -> Self {
        self.parse_text(text, preserve_tags);
        self
    }

    /// Set or clear the `(A)`..`(Z)` priority.
    #[must_use]
    pub fn set_priority(mut self, priority: Option<Priority>) -> Self {
        self.priority = priority;
        self
    }

    /// Set the creation date.
    ///
    /// A [`TodoDate`] is always a valid calendar day, so the oracle's
    /// `isValidTodoDate` guard cannot reject this call.
    #[must_use]
    pub fn set_creation_date(mut self, date: TodoDate) -> Self {
        self.creation_date = Some(date);
        self
    }

    /// Set or clear the completion date.
    ///
    /// Like `Todo#setCompletionDate`, this always clears
    /// `completion_date_in_text`, so the date is never serialized twice.
    #[must_use]
    pub fn set_completion_date(mut self, date: Option<TodoDate>) -> Self {
        self.completion_date = date;
        self.completion_date_in_text = false;
        self
    }

    /// Set the open/done state without touching the dates.
    #[must_use]
    pub fn set_state(mut self, state: State) -> Self {
        self.state = state;
        self
    }

    /// Set the `due:` date.
    #[must_use]
    pub fn set_due(mut self, date: TodoDate) -> Self {
        self.set_tag("due", date.to_string());
        self
    }

    /// Remove the `due:` tag.
    #[must_use]
    pub fn remove_due(mut self) -> Self {
        self.remove_tag("due");
        self
    }

    /// Set the `t:` (threshold) date.
    #[must_use]
    pub fn set_threshold(mut self, date: TodoDate) -> Self {
        self.set_tag("t", date.to_string());
        self
    }

    /// Remove the `t:` (threshold) tag.
    #[must_use]
    pub fn remove_threshold(mut self) -> Self {
        self.remove_tag("t");
        self
    }

    /// Toggle the `h:` hidden tag.
    ///
    /// A todo that is currently hidden loses the tag; anything else (including
    /// `h:0`) gets `h:1`, exactly like `Todo#toggleHidden`.
    #[must_use]
    pub fn toggle_hidden(mut self) -> Self {
        if self.is_hidden() {
            self.remove_tag("h");
        } else {
            self.set_tag("h", "1".to_owned());
        }
        self
    }

    /// Set the `rec:` recurrence value.
    ///
    /// A [`Recurrence`] is parsed and range-checked when it is built, so it is
    /// always storable.
    #[must_use]
    pub fn set_recurrence(mut self, value: Recurrence) -> Self {
        self.set_tag("rec", value.to_string());
        self
    }

    /// Remove the `rec:` tag.
    #[must_use]
    pub fn remove_recurrence(mut self) -> Self {
        self.remove_tag("rec");
        self
    }

    /// Append `@context` to the text, unless it is already present.
    #[must_use]
    pub fn add_context(mut self, context: &str) -> Self {
        if self.contexts.iter().any(|existing| existing == context) {
            return self;
        }
        let text = format!("{} @{context}", self.text);
        self.parse_text(&text, true);
        self
    }

    /// Remove `@context` from the text, unless it is absent.
    ///
    /// The match mirrors the oracle's `\s*@context(?=\s|$)` regex, including
    /// the `.`-as-any-character quirk documented on `remove_mention`.
    #[must_use]
    pub fn remove_context(mut self, context: &str) -> Self {
        if !self.contexts.iter().any(|existing| existing == context) {
            return self;
        }
        let text = remove_mention(&self.text, '@', context);
        self.parse_text(js_trim(&text), true);
        self
    }

    /// Append `+project` to the text, unless it is already present.
    #[must_use]
    pub fn add_project(mut self, project: &str) -> Self {
        if self.projects.iter().any(|existing| existing == project) {
            return self;
        }
        let text = format!("{} +{project}", self.text);
        self.parse_text(&text, true);
        self
    }

    /// Remove `+project` from the text, unless it is absent.
    #[must_use]
    pub fn remove_project(mut self, project: &str) -> Self {
        if !self.projects.iter().any(|existing| existing == project) {
            return self;
        }
        let text = remove_mention(&self.text, '+', project);
        self.parse_text(js_trim(&text), true);
        self
    }

    /// Flip open/done and plan the next instance of a recurring todo.
    ///
    /// Completing records `today` as the completion date, and recurrence is
    /// planned **from `today`** (the completion day), never from the existing
    /// `due:` tag. The new instance is open, has no completion date, and takes
    /// `recurring_id` because the host owns id allocation.
    ///
    /// An invalid or out-of-range `rec:` value still completes the todo and
    /// returns the completed value in [`ToggleOutcome::updated`]; the reason is
    /// in [`ToggleOutcome::recurring`]. Nothing is stored here and nothing
    /// panics.
    pub fn toggle_state(&self, today: TodoDate, recurring_id: TodoId) -> ToggleOutcome {
        let mut updated = self.clone();
        updated.state = if self.state.is_done() {
            State::Todo
        } else {
            State::Done
        };

        if updated.state.is_done() {
            // Completing always records today, even when the line had no
            // creation date or kept its dates as literal text.
            updated.completion_date = Some(today);
            updated.completion_date_in_text = false;
        } else if updated.completion_date.is_some() {
            updated.completion_date = None;
            updated.completion_date_in_text = false;
        }

        let plan = if updated.state.is_done() {
            match updated.tag("rec") {
                Some(TagValue::One(value)) => Some(plan_recurrence(value, today)),
                // A repeated `rec` key is an array-valued tag, which the oracle
                // passes to `planRecurrence` as a non-string and rejects.
                Some(TagValue::Many(_)) => Some(Err(RecurrenceError::Invalid)),
                None => None,
            }
        } else {
            None
        };

        let recurring = match plan {
            None => Ok(None),
            Some(Err(error)) => Err(error),
            Some(Ok(next_due)) => {
                // The oracle serializes the completed todo, re-parses it, and
                // then opens the copy with the next due date. Re-parsing keeps
                // the literal-date flags consistent.
                let recurring = Todo::parse_line(&updated.to_string(), recurring_id)
                    .set_state(State::Todo)
                    .set_completion_date(None)
                    .set_due(next_due);
                Ok(Some(recurring))
            }
        };

        ToggleOutcome { updated, recurring }
    }

    /// Set `key` to a single value, replacing an existing key in place.
    fn set_tag(&mut self, key: &str, value: String) {
        match self.tags.iter_mut().find(|(existing, _)| existing == key) {
            Some((_, existing)) => *existing = TagValue::One(value),
            None => self.tags.push((key.to_owned(), TagValue::One(value))),
        }
    }

    /// Remove every occurrence of `key`.
    fn remove_tag(&mut self, key: &str) {
        self.tags.retain(|(existing, _)| existing != key);
    }
}

/// The result of [`Todo::toggle_state`]: the flipped todo and its recurrence.
///
/// A failed recurrence plan is a partial success: the state change still
/// happened, so [`ToggleOutcome::updated`] is always stored.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToggleOutcome {
    /// The todo flipped between open and done.
    pub updated: Todo,
    /// `Ok(Some(next))` for a planned recurrence, `Ok(None)` for a normal
    /// toggle, `Err(reason)` when `rec:` could not be planned.
    pub recurring: Result<Option<Todo>, RecurrenceError>,
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

/// Remove every `sigilname` token and the whitespace in front of it.
///
/// Mirrors `new RegExp("\\s*" + sigil + name + "(?=\\s|$)", "g")` in
/// `logic/todo.ts`:
///
/// - the leading whitespace run is consumed together with the token;
/// - matching is leftmost and non-overlapping, and every match is removed;
/// - a `.` in the name is a regex any-character (but not a line terminator and
///   not a surrogate half — JavaScript's `.` is one UTF-16 code unit), which is
///   the only metacharacter a stored `[A-Za-z0-9_.\-]` name can contain, so
///   removing `a.b` also removes an earlier `@aXb` but not `@a😀b`;
/// - the token must be followed by JavaScript whitespace or the end of the
///   text.
fn remove_mention(text: &str, sigil: char, name: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut copied = 0;
    let mut index = 0;

    while index < text.len() {
        let Some(character) = text[index..].chars().next() else {
            break;
        };

        if let Some((start, end)) = match_at(text, index, sigil, name) {
            output.push_str(&text[copied..start]);
            copied = end;
            index = end;
        } else if is_js_whitespace(character) {
            // A failed match cannot start inside the leading whitespace run:
            // every start in it is followed by the same sigil.
            index += whitespace_prefix_len(&text[index..]);
        } else {
            index += character.len_utf8();
        }
    }

    output.push_str(&text[copied..]);
    output
}

/// Match `\s*sigil+name(?=\s|$)` at `start`, returning the matched byte range.
///
/// The range starts at `start` because `\s*` is greedy and the token after it
/// is fixed; it ends after the name, before the required lookahead whitespace.
fn match_at(text: &str, start: usize, sigil: char, name: &str) -> Option<(usize, usize)> {
    let rest = text.get(start..)?;
    let mut cursor = start + whitespace_prefix_len(rest);

    let actual_sigil = text[cursor..].chars().next()?;
    if actual_sigil != sigil {
        return None;
    }
    cursor += actual_sigil.len_utf8();

    for expected in name.chars() {
        let actual = text[cursor..].chars().next()?;
        let matched = if expected == '.' {
            // JavaScript's `.` matches one UTF-16 code unit and skips line
            // terminators. A BMP character is 1..=3 UTF-8 bytes; an astral
            // character is 4 and is a surrogate pair in UTF-16, so `.` cannot
            // consume it.
            !matches!(actual, '\n' | '\r' | '\u{2028}' | '\u{2029}') && actual.len_utf8() != 4
        } else {
            actual == expected
        };
        if !matched {
            return None;
        }
        cursor += actual.len_utf8();
    }

    match text[cursor..].chars().next() {
        None => Some((start, cursor)),
        Some(next) if is_js_whitespace(next) => Some((start, cursor)),
        Some(_) => None,
    }
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
///
/// The argument is any iterator of `&Todo`, so a caller that shares todos
/// through `Rc<Todo>` can pass its reference list without cloning the values.
#[must_use]
pub fn serialize_file<'a>(todos: impl IntoIterator<Item = &'a Todo>) -> String {
    let mut output = String::new();
    for (index, todo) in todos.into_iter().enumerate() {
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
    use super::{Priority, State, TagValue, Todo, TodoId, TodoParts, serialize_file};
    use crate::date::TodoDate;
    use crate::recurrence::Recurrence;

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
            todo.to_string(),
            "x (A) 2024-03-02 2024-03-01 done with priority"
        );
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
            todo.to_string(),
            "x 2023-05-04 2023-02-29 second date is invalid"
        );
    }

    #[test]
    fn parts_round_trip_keeps_duplicate_tags_and_round_trip_flags() {
        // The two reasons `TodoParts` exists: a serialized line collapses a
        // duplicate tag key into a comma list, and the round-trip flags are not
        // visible in the text at all.
        for line in [
            "x (A) 2024-03-02 2024-03-01 ship it @work +thar \
             alpha:one beta:one beta:two h:1",
            "x 2023-05-04 2023-02-29 second date is invalid beta:one beta:two",
            "(B) 2023-05-04 2023-05-05 two leading dates",
        ] {
            let todo = parse(line);
            let rebuilt = Todo::from_parts(TodoId::new(7), todo.clone().into_parts());

            assert_eq!(rebuilt.to_string(), todo.to_string(), "line {line:?}");
            assert_eq!(rebuilt.text, todo.text, "line {line:?}");
            assert_eq!(rebuilt.state, todo.state, "line {line:?}");
            assert_eq!(rebuilt.priority, todo.priority, "line {line:?}");
            assert_eq!(
                rebuilt.completion_date, todo.completion_date,
                "line {line:?}"
            );
            assert_eq!(rebuilt.creation_date, todo.creation_date, "line {line:?}");
            assert_eq!(rebuilt.projects, todo.projects, "line {line:?}");
            assert_eq!(rebuilt.contexts, todo.contexts, "line {line:?}");
            assert_eq!(rebuilt.tags, todo.tags, "line {line:?}");
            assert_eq!(rebuilt.dates_in_text, todo.dates_in_text, "line {line:?}");
            assert_eq!(
                rebuilt.completion_date_in_text, todo.completion_date_in_text,
                "line {line:?}"
            );
        }

        // The specific shapes the round-trip must not lose.
        let duplicate = parse("beta:one beta:two body");
        let parts = duplicate.clone().into_parts();
        assert_eq!(
            parts.tags,
            vec![(
                "beta".to_owned(),
                TagValue::Many(vec!["one".to_owned(), "two".to_owned()])
            )]
        );
        assert!(!parts.dates_in_text);
        assert!(!parts.completion_date_in_text);

        let ambiguous = parse("x 2023-05-04 2023-02-29 second date is invalid");
        let parts = ambiguous.into_parts();
        assert!(parts.dates_in_text);
        assert!(parts.completion_date_in_text);
    }

    #[test]
    fn two_valid_dates_without_done_marker_stay_literal() {
        let todo = parse("2023-05-04 2023-05-05 two leading dates");
        assert_eq!(todo.text, "2023-05-04 2023-05-05 two leading dates");
        assert!(todo.dates_in_text);
        assert_eq!(todo.creation_date, None);
        assert_eq!(todo.to_string(), "2023-05-04 2023-05-05 two leading dates");
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
        assert_eq!(todo.to_string(), "2023-05-04");
    }

    #[test]
    fn x_alone_is_an_open_todo() {
        let todo = parse("x");
        assert_eq!(todo.state, State::Todo);
        assert_eq!(todo.text, "x");
        assert_eq!(todo.to_string(), "x");
    }

    #[test]
    fn priority_without_text_keeps_its_trailing_space() {
        let todo = parse("(A) ");
        assert_eq!(todo.text, "");
        assert_eq!(todo.priority.map(Priority::as_char), Some('A'));
        assert_eq!(todo.to_string(), "(A) ");
    }

    #[test]
    fn tags_move_to_the_end_in_insertion_order() {
        let todo = parse("alpha:one single tag");
        assert_eq!(todo.text, "single tag");
        assert_eq!(
            todo.tags,
            vec![("alpha".to_owned(), TagValue::One("one".to_owned()))]
        );
        assert_eq!(todo.to_string(), "single tag alpha:one");
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
        assert_eq!(todo.to_string(), "text beta:one,two");
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
        assert_eq!(todo.to_string(), "+a +b +a @x @y @x text");
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
        assert_eq!(todo.to_string(), " alpha:one");
    }

    #[test]
    fn blank_line_parses_to_an_empty_open_todo() {
        let todo = parse("   \t ");
        assert_eq!(todo.state, State::Todo);
        assert_eq!(todo.text, "");
        assert_eq!(todo.to_string(), "");
    }

    #[test]
    fn js_whitespace_and_bom_are_trimmed_but_nel_is_text() {
        // `bom.txt`: the BOM is not stripped by the reader, only by trim.
        let bom = parse("\u{FEFF}first todo after a BOM");
        assert_eq!(bom.text, "first todo after a BOM");
        assert_eq!(bom.to_string(), "first todo after a BOM");

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
            assert_eq!(todo.to_string(), "text with tag:x");
        }

        // U+0085 (NEL) is not ECMAScript whitespace, so it stays in the text.
        let nel = parse("\u{0085}kept\u{0085}");
        assert_eq!(nel.text, "\u{0085}kept\u{0085}");
        assert_eq!(nel.to_string(), "\u{0085}kept\u{0085}");
    }

    #[test]
    fn tabs_survive_inside_text() {
        let todo = parse("tab\tinside\tline");
        assert_eq!(todo.text, "tab\tinside\tline");
        assert_eq!(todo.to_string(), "tab\tinside\tline");
    }

    #[test]
    fn serialize_file_joins_with_a_final_newline() {
        let todos = vec![parse("one"), parse("two")];
        assert_eq!(serialize_file(&todos), "one\ntwo\n");
        assert_eq!(serialize_file(std::iter::empty::<&Todo>()), "\n");
    }

    #[test]
    fn ids_are_kept() {
        let todo = Todo::parse_line("task", TodoId::new(42));
        assert_eq!(todo.id, TodoId::new(42));
    }

    // ---- Setters ----------------------------------------------------------

    const FIXTURE: &str =
        "task +project @context rec:1d due:2024-01-01 t:2024-01-01 multi:one multi:two h:1";

    fn rich() -> Todo {
        parse(FIXTURE)
    }

    fn date(value: &str) -> TodoDate {
        value.parse::<TodoDate>().expect("valid test date")
    }

    fn recurrence(value: &str) -> Recurrence {
        value.parse::<Recurrence>().expect("valid test recurrence")
    }

    /// Every field a setter can touch, so a mutation of the receiver fails.
    fn snapshot(todo: &Todo) -> String {
        format!(
            "{:?}|{:?}|{:?}|{:?}|{:?}|{:?}|{:?}|{:?}|{}",
            todo.text,
            todo.state,
            todo.priority,
            todo.completion_date,
            todo.creation_date,
            todo.projects,
            todo.contexts,
            todo.tags,
            todo
        )
    }

    #[test]
    fn setters_leave_the_receiver_untouched() {
        let original = rich();
        let before = snapshot(&original);

        let cases: Vec<Box<dyn Fn(Todo) -> Todo>> = vec![
            Box::new(|todo| todo.set_text("renamed +project @context", true)),
            Box::new(|todo| todo.set_priority(Priority::new('A'))),
            Box::new(|todo| todo.set_creation_date(date("2024-06-15"))),
            Box::new(|todo| todo.set_completion_date(Some(date("2024-06-15")))),
            Box::new(|todo| todo.set_state(State::Done)),
            Box::new(|todo| todo.set_due(date("2024-06-15"))),
            Box::new(|todo| todo.remove_due()),
            Box::new(|todo| todo.set_threshold(date("2024-06-15"))),
            Box::new(|todo| todo.remove_threshold()),
            Box::new(|todo| todo.toggle_hidden()),
            Box::new(|todo| todo.set_recurrence(recurrence("2w"))),
            Box::new(|todo| todo.remove_recurrence()),
            Box::new(|todo| todo.add_context("errand")),
            Box::new(|todo| todo.remove_context("context")),
            Box::new(|todo| todo.add_project("side")),
            Box::new(|todo| todo.remove_project("project")),
        ];

        for (index, apply) in cases.into_iter().enumerate() {
            let updated = apply(original.clone());
            assert_eq!(updated.id, original.id, "case {index}: id");
            assert_eq!(
                snapshot(&original),
                before,
                "case {index}: receiver mutated"
            );
        }
    }

    #[test]
    fn setters_deep_copy_projects_contexts_and_tag_arrays() {
        let original = rich();
        let mut updated = original.clone().set_priority(Priority::new('B'));

        assert_ne!(updated.projects.as_ptr(), original.projects.as_ptr());
        assert_ne!(updated.contexts.as_ptr(), original.contexts.as_ptr());
        assert_ne!(updated.tags.as_ptr(), original.tags.as_ptr());

        // Mutating the receiver after a setter must not leak into the result,
        // and mutating the result must not leak back.
        updated.projects.push("updated-only".to_owned());
        updated.contexts.push("updated-only".to_owned());

        assert_eq!(original.projects, vec!["project".to_owned()]);
        assert_eq!(original.contexts, vec!["context".to_owned()]);
        assert_eq!(
            updated
                .tag("multi")
                .map(|value| value.values().collect::<Vec<_>>()),
            Some(vec!["one", "two"])
        );
        assert_eq!(
            original
                .tag("multi")
                .map(|value| value.values().collect::<Vec<_>>()),
            Some(vec!["one", "two"])
        );
    }

    #[test]
    fn set_text_replaces_or_preserves_tags_like_the_oracle() {
        let todo = parse("old gamma:three");

        let replaced = todo.clone().set_text("new alpha:one", false);
        assert_eq!(replaced.text, "new");
        assert_eq!(replaced.to_string(), "new alpha:one");

        let preserved = todo.clone().set_text("new alpha:one", true);
        assert_eq!(preserved.to_string(), "new gamma:three alpha:one");

        // An existing key keeps its insertion position but takes the new value.
        let overridden = todo.clone().set_text("new gamma:changed alpha:one", true);
        assert_eq!(overridden.to_string(), "new gamma:changed alpha:one");
    }

    #[test]
    fn set_text_reparses_projects_and_contexts() {
        let todo = parse("one @old +old").set_text("two @new +new", true);
        assert_eq!(todo.contexts, vec!["new".to_owned()]);
        assert_eq!(todo.projects, vec!["new".to_owned()]);
        assert_eq!(todo.text, "two @new +new");
    }

    #[test]
    fn priority_and_dates_serialize_after_each_change() {
        let todo = parse("plain");
        assert_eq!(
            todo.clone().set_priority(Priority::new('A')).to_string(),
            "(A) plain"
        );
        assert_eq!(
            todo.clone()
                .set_priority(Priority::new('A'))
                .set_priority(None)
                .to_string(),
            "plain"
        );
        assert_eq!(
            todo.clone()
                .set_creation_date(date("2024-06-15"))
                .to_string(),
            "2024-06-15 plain"
        );
        assert_eq!(
            parse("x 2024-01-01 done")
                .set_completion_date(None)
                .to_string(),
            "x done"
        );
        assert_eq!(
            parse("x 2024-01-01 done")
                .set_completion_date(Some(date("2024-02-02")))
                .to_string(),
            "x 2024-02-02 done"
        );
        assert_eq!(
            parse("x 2024-03-02 2024-03-01 done")
                .set_state(State::Todo)
                .to_string(),
            "2024-03-02 2024-03-01 done"
        );
    }

    #[test]
    fn due_and_threshold_are_replaced_in_place_and_removed() {
        let todo = parse("task due:2024-01-01 t:2024-01-02 other:keep");
        assert_eq!(
            todo.clone().set_due(date("2024-06-15")).to_string(),
            "task due:2024-06-15 t:2024-01-02 other:keep"
        );
        assert_eq!(
            todo.clone().set_threshold(date("2024-06-16")).to_string(),
            "task due:2024-01-01 t:2024-06-16 other:keep"
        );
        assert_eq!(
            todo.clone().remove_due().to_string(),
            "task t:2024-01-02 other:keep"
        );
        assert_eq!(
            todo.clone().remove_threshold().to_string(),
            "task due:2024-01-01 other:keep"
        );
        // Removing an absent tag is a no-op.
        assert_eq!(
            parse("plain").remove_due().remove_threshold().to_string(),
            "plain"
        );
    }

    #[test]
    fn toggle_hidden_follows_the_ts_rules() {
        assert_eq!(parse("task h:1").toggle_hidden().to_string(), "task");
        assert_eq!(parse("task h:x").toggle_hidden().to_string(), "task");
        assert_eq!(parse("task h:0").toggle_hidden().to_string(), "task h:1");
        assert_eq!(parse("task").toggle_hidden().to_string(), "task h:1");
    }

    #[test]
    fn recurrence_is_stored_canonically() {
        let plus = "+1d".parse::<Recurrence>().expect("valid");
        let zeros = "0001d".parse::<Recurrence>().expect("valid");
        assert_eq!(
            parse("task").set_recurrence(plus).to_string(),
            "task rec:1d"
        );
        assert_eq!(
            parse("task").set_recurrence(zeros).to_string(),
            "task rec:1d"
        );
    }

    #[test]
    fn recurrence_is_validated_when_it_is_parsed() {
        let todo = parse("task");
        assert_eq!(
            todo.clone().set_recurrence(recurrence("2w")).to_string(),
            "task rec:2w"
        );
        assert_eq!(
            todo.clone()
                .set_recurrence(recurrence("2w"))
                .remove_recurrence()
                .to_string(),
            "task"
        );
    }

    #[test]
    fn context_and_project_edits_go_through_the_text() {
        let todo = parse("task +project @context other:keep");
        assert_eq!(
            todo.clone().add_context("errand").to_string(),
            "task +project @context @errand other:keep"
        );
        assert_eq!(
            todo.clone()
                .add_context("errand")
                .remove_context("context")
                .to_string(),
            "task +project @errand other:keep"
        );
        assert_eq!(
            todo.clone().add_project("side").to_string(),
            "task +project @context +side other:keep"
        );
        assert_eq!(
            todo.clone()
                .add_project("side")
                .remove_project("project")
                .to_string(),
            "task @context +side other:keep"
        );

        // Already present: the receiver is returned unchanged.
        assert_eq!(
            todo.clone().add_context("context").to_string(),
            todo.to_string()
        );
        assert_eq!(
            todo.clone().add_project("project").to_string(),
            todo.to_string()
        );
        assert_eq!(
            todo.clone().remove_context("missing").to_string(),
            todo.to_string()
        );
        assert_eq!(
            todo.clone().remove_project("missing").to_string(),
            todo.to_string()
        );
    }

    #[test]
    fn remove_context_mirrors_the_regex_dot_quirk() {
        // The oracle builds `\s*@a.b(?=\s|$)`, so `@aXb` matches first and is
        // removed even though the todo also carries the literal `@a.b`.
        let todo = parse("one @aXb two @a.b");
        assert_eq!(todo.contexts, vec!["aXb".to_owned(), "a.b".to_owned()]);
        assert_eq!(todo.remove_context("a.b").to_string(), "one two");
    }

    #[test]
    fn remove_context_dot_matches_one_utf16_code_unit() {
        // BMP characters are one UTF-16 code unit however many UTF-8 bytes they
        // take, so `.` consumes the 3-byte € and removes `@a€b` too.
        assert_eq!(
            parse("task @a€b @a.b").remove_context("a.b").to_string(),
            "task"
        );

        // An astral character is a surrogate pair in UTF-16, so `.` cannot
        // consume it and `@a😀b` survives.
        assert_eq!(
            parse("task @a.b @a😀b").remove_context("a.b").to_string(),
            "task @a😀b"
        );
        assert_eq!(
            parse("task @a😀b @a.b").remove_context("a.b").to_string(),
            "task @a😀b"
        );
    }

    #[test]
    fn remove_project_dot_matches_one_utf16_code_unit() {
        assert_eq!(
            parse("task +a😀b +a.b").remove_project("a.b").to_string(),
            "task +a😀b"
        );
        assert_eq!(
            parse("task +aéb +a.b").remove_project("a.b").to_string(),
            "task"
        );
    }

    #[test]
    fn parts_and_state_default_to_an_empty_open_todo() {
        assert_eq!(State::default(), State::Todo);
        let parts = TodoParts::default();
        assert_eq!(parts.state, State::Todo);
        assert_eq!(parts.text, "");
        assert!(parts.priority.is_none());
        assert!(parts.tags.is_empty());
        assert!(!parts.dates_in_text);
    }

    #[test]
    fn toggle_state_completes_and_plans_from_today() {
        let today = date("2026-11-15");
        let todo = parse("due:2026-11-01 rec:2d");
        let outcome = todo.clone().toggle_state(today, TodoId::new(7));

        assert_eq!(
            outcome.updated.to_string(),
            "x 2026-11-15  due:2026-11-01 rec:2d"
        );
        let recurring = outcome
            .recurring
            .expect("planned")
            .expect("a next instance");
        assert_eq!(recurring.id, TodoId::new(7));
        assert!(!recurring.is_done());
        assert_eq!(recurring.completion_date, None);
        assert_eq!(
            recurring.tag("due").and_then(TagValue::as_single),
            Some("2026-11-17")
        );
        assert_eq!(recurring.to_string(), " due:2026-11-17 rec:2d");
    }

    #[test]
    fn toggle_state_uses_the_completion_day_not_the_due_date() {
        let outcome =
            parse("due:2026-12-31 rec:1m").toggle_state(date("2026-11-15"), TodoId::new(0));
        assert_eq!(
            outcome
                .recurring
                .expect("planned")
                .expect("a next instance")
                .tag("due")
                .and_then(TagValue::as_single),
            Some("2026-12-15")
        );
    }

    #[test]
    fn toggle_state_reports_bad_recurrence_without_storing_it() {
        let today = date("2026-11-15");
        for (line, message) in [
            (
                "task rec:1D",
                "Invalid recurrence value; no new todo was created",
            ),
            (
                "task rec:0d",
                "Recurrence is out of range; no new todo was created",
            ),
            (
                "task rec:1d rec:2d",
                "Invalid recurrence value; no new todo was created",
            ),
        ] {
            let outcome = parse(line).toggle_state(today, TodoId::new(0));
            assert!(outcome.updated.is_done(), "line {line:?}");
            let error = outcome.recurring.expect_err("recurrence error");
            assert_eq!(error.message(), message, "line {line:?}");
            assert_eq!(error.to_string(), message, "line {line:?}");
        }
    }

    #[test]
    fn toggle_state_reopens_a_done_todo_without_planning() {
        let today = date("2026-11-15");
        let outcome =
            parse("x 2024-03-02 2024-03-01 done rec:1w").toggle_state(today, TodoId::new(0));
        assert!(!outcome.updated.is_done());
        assert_eq!(outcome.updated.to_string(), "2024-03-01 done rec:1w");
        assert_eq!(outcome.recurring, Ok(None));

        // A plain todo has nothing to plan.
        let plain = parse("plain").toggle_state(today, TodoId::new(0));
        assert_eq!(plain.updated.to_string(), "x 2026-11-15 plain");
        assert_eq!(plain.recurring, Ok(None));
    }

    #[test]
    fn toggle_state_preserves_literal_dates_in_text() {
        let outcome =
            parse("2023-02-29 literal rec:1d").toggle_state(date("2026-11-15"), TodoId::new(0));
        assert!(outcome.updated.is_done());
        assert_eq!(
            outcome.updated.to_string(),
            "x 2026-11-15 2023-02-29 literal rec:1d"
        );
        let recurring = outcome
            .recurring
            .expect("planned")
            .expect("a next instance");
        assert_eq!(
            recurring.to_string(),
            "2026-11-15 2023-02-29 literal rec:1d due:2026-11-16"
        );
    }
}
