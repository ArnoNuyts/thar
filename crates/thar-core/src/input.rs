//! Write-side input validation, mirroring `logic/todo-input.ts`.
//!
//! A todo created or edited in the TUI is validated before it is parsed or
//! written. [`validate_todo_text`] enforces the rules the Ink app enforces, in
//! the same order, with the same bounded messages:
//!
//! 1. the text is not empty or whitespace only (JavaScript whitespace);
//! 2. it is a single line (`\n`, `\r`, `U+2028`, `U+2029`);
//! 3. it holds no rejected control code point (tab is allowed);
//! 4. it holds no unpaired surrogate;
//! 5. it is within the effective character cap (UTF-16 code units);
//! 6. it does not start with a leading date token, valid or not.
//!
//! Messages never echo the rejected payload, so they are safe to show in a
//! toast; the stable [`TodoInputError::code`] mirrors the TypeScript
//! `TodoInputErrorCode` union.
//!
//! # Character counts
//!
//! Lengths are measured in UTF-16 code units, exactly like
//! `String.prototype.length`, so an astral character counts as two. The edit
//! modal passes `max(MAX_TODO_CHARS, original_len)` so an unchanged legacy line
//! can still be saved while a growing value is rejected.
//!
//! # Unpaired surrogates
//!
//! A Rust `&str` is always well-formed UTF-16, so [`validate_todo_text`] can
//! never report [`TodoInputErrorCode::UnpairedSurrogate`]. The variant stays in
//! the vocabulary because it is part of the oracle contract, and
//! [`validate_utf16`] makes it reachable: that entry point takes the raw code
//! units a JavaScript host already holds.

use core::fmt;

use crate::js::{is_js_whitespace, js_trim};
use crate::limits::{MAX_PASTE_TODOS, MAX_TODO_CHARS, MAX_TODOS};
use crate::scan::scan_prefix;

/// Stable machine-readable reason a write-side input was rejected.
///
/// The string form (see [`TodoInputErrorCode::as_str`]) is identical to the
/// TypeScript `TodoInputErrorCode` union.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TodoInputErrorCode {
    /// Empty or whitespace-only text.
    Empty,
    /// More than one line.
    Multiline,
    /// A rejected C0/C1 control, DEL, or a Unicode line separator.
    ControlCharacter,
    /// A UTF-16 surrogate without its partner.
    UnpairedSurrogate,
    /// Longer than the effective cap.
    TooLong,
    /// The leading date token is not a real calendar day.
    InvalidDate,
    /// More than one leading date token.
    AmbiguousDate,
    /// A valid leading date token; the app owns creation dates.
    LeadingDate,
    /// More lines than one paste may add.
    BatchTooLarge,
    /// The in-memory list would exceed [`MAX_TODOS`].
    TooManyTodos,
}

impl TodoInputErrorCode {
    /// The TypeScript code string.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Empty => "empty",
            Self::Multiline => "multiline",
            Self::ControlCharacter => "control-character",
            Self::UnpairedSurrogate => "unpaired-surrogate",
            Self::TooLong => "too-long",
            Self::InvalidDate => "invalid-date",
            Self::AmbiguousDate => "ambiguous-date",
            Self::LeadingDate => "leading-date",
            Self::BatchTooLarge => "batch-too-large",
            Self::TooManyTodos => "too-many-todos",
        }
    }
}

/// A rejected write-side input.
///
/// The message is bounded and never echoes the rejected payload, so it can be
/// shown in a toast or logged as-is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TodoInputError {
    code: TodoInputErrorCode,
    message: String,
}

impl TodoInputError {
    /// Build an error with a bounded message.
    #[must_use]
    pub fn new(code: TodoInputErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    /// What was wrong.
    #[must_use]
    pub const fn code(&self) -> TodoInputErrorCode {
        self.code
    }

    /// The same reason as the TypeScript code string.
    #[must_use]
    pub const fn code_str(&self) -> &'static str {
        self.code.as_str()
    }

    /// The bounded, user-facing message.
    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for TodoInputError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl core::error::Error for TodoInputError {}

/// Rejected C0/C1 controls, DEL, and the two Unicode line separators.
///
/// Tab is in the C0 range but is allowed inside a todo, so callers exclude it
/// explicitly. This duplicates the read-path predicate on purpose: the write
/// path must not become permissive when the read path changes.
const fn is_rejected_control(character: char) -> bool {
    matches!(
        character,
        '\u{0000}'..='\u{001F}' | '\u{007F}'..='\u{009F}' | '\u{2028}' | '\u{2029}'
    )
}

/// The first rejected control code point that is not tab.
fn find_unsafe_control(text: &str) -> Option<char> {
    text.chars()
        .find(|character| *character != '\t' && is_rejected_control(*character))
}

/// True when the text contains one of the four line separators.
fn is_multiline(text: &str) -> bool {
    text.contains(['\n', '\r', '\u{2028}', '\u{2029}'])
}

fn empty_error() -> TodoInputError {
    TodoInputError::new(
        TodoInputErrorCode::Empty,
        "Todo text cannot be empty or whitespace only",
    )
}

fn multiline_error() -> TodoInputError {
    TodoInputError::new(TodoInputErrorCode::Multiline, "Todo must be a single line")
}

fn control_error() -> TodoInputError {
    TodoInputError::new(
        TodoInputErrorCode::ControlCharacter,
        "Todo contains a disallowed control character",
    )
}

fn surrogate_error() -> TodoInputError {
    TodoInputError::new(
        TodoInputErrorCode::UnpairedSurrogate,
        "Todo contains an unpaired surrogate",
    )
}

fn too_long_error(max_chars: usize) -> TodoInputError {
    TodoInputError::new(
        TodoInputErrorCode::TooLong,
        format!("Todo is too long; the limit is {max_chars} characters"),
    )
}

/// Validate one todo line before it is parsed or written.
///
/// `max_chars` is the effective character cap in UTF-16 code units; pass
/// [`MAX_TODO_CHARS`] for a new todo and `max(MAX_TODO_CHARS, original_len)` for
/// an edit.
///
/// # Errors
///
/// Returns the first [`TodoInputErrorCode`] the text violates, in the oracle's
/// order: empty, multiline, control-character, too-long, then the leading-date
/// rules.
///
/// # Example
///
/// ```
/// use thar_core::{MAX_TODO_CHARS, TodoInputErrorCode, validate_todo_text};
///
/// assert!(validate_todo_text("buy milk @home", MAX_TODO_CHARS).is_ok());
/// let error = validate_todo_text("2026-11-15 buy milk", MAX_TODO_CHARS)
///     .expect_err("a leading date is rejected");
/// assert_eq!(error.code(), TodoInputErrorCode::LeadingDate);
/// ```
pub fn validate_todo_text(text: &str, max_chars: usize) -> Result<(), TodoInputError> {
    if js_trim(text).is_empty() {
        return Err(empty_error());
    }
    if is_multiline(text) {
        return Err(multiline_error());
    }
    if find_unsafe_control(text).is_some() {
        return Err(control_error());
    }
    if text.encode_utf16().count() > max_chars {
        return Err(too_long_error(max_chars));
    }
    validate_leading_dates(text)
}

/// Validate a UTF-16 buffer, including its surrogate pairs.
///
/// This is the entry point for a host that already holds JavaScript code units
/// (the WASM boundary). A well-formed buffer is validated exactly like
/// [`validate_todo_text`]; a buffer with a lone surrogate is rejected with
/// [`TodoInputErrorCode::UnpairedSurrogate`], after the empty, multiline and
/// control checks that the oracle runs first.
///
/// # Errors
///
/// The same reasons as [`validate_todo_text`], plus
/// [`TodoInputErrorCode::UnpairedSurrogate`].
pub fn validate_utf16(units: &[u16], max_chars: usize) -> Result<(), TodoInputError> {
    let Ok(text) = String::from_utf16(units) else {
        return Err(unpaired_surrogate_error(units));
    };
    validate_todo_text(&text, max_chars)
}

/// The oracle's reason for a buffer that is not well-formed UTF-16.
///
/// `String::from_utf16` fails before the later rules run, so the earlier three
/// are re-checked here to keep the reported code identical to the oracle.
fn unpaired_surrogate_error(units: &[u16]) -> TodoInputError {
    let text: String = units
        .iter()
        .filter_map(|unit| char::from_u32(u32::from(*unit)))
        .collect();
    if units.iter().all(|unit| unit_is_whitespace(*unit)) {
        return empty_error();
    }
    if is_multiline(&text) || units.iter().any(|unit| *unit == 0x000A || *unit == 0x000D) {
        return multiline_error();
    }
    let unsafe_control = units.iter().any(|unit| {
        let character = char::from_u32(u32::from(*unit)).unwrap_or('\t');
        *unit == 0x2028 || *unit == 0x2029 || (character != '\t' && is_rejected_control(character))
    });
    if unsafe_control {
        return control_error();
    }
    surrogate_error()
}

/// True for a UTF-16 unit that JavaScript's `\s` matches.
///
/// A lone surrogate is not whitespace, so a buffer holding only whitespace and
/// a stray surrogate is "not empty" exactly like the oracle.
fn unit_is_whitespace(unit: u16) -> bool {
    match char::from_u32(u32::from(unit)) {
        Some(character) => is_js_whitespace(character),
        None => false,
    }
}

/// The leading-date rules (invalid, ambiguous, then leading).
fn validate_leading_dates(text: &str) -> Result<(), TodoInputError> {
    let prefix = scan_prefix(text);
    if !prefix.invalid_date_tokens.is_empty() {
        return Err(TodoInputError::new(
            TodoInputErrorCode::InvalidDate,
            "Todo starts with an impossible date",
        ));
    }
    if prefix.date_tokens.len() > 1 {
        return Err(TodoInputError::new(
            TodoInputErrorCode::AmbiguousDate,
            "Todo starts with more than one date",
        ));
    }
    if !prefix.date_tokens.is_empty() {
        return Err(TodoInputError::new(
            TodoInputErrorCode::LeadingDate,
            "Todo text cannot start with a date; use the date picker",
        ));
    }
    Ok(())
}

/// Validate a batch of todo lines atomically and check the list capacity.
///
/// `existing_count` is the number of todos already in the list. When this
/// returns an error the caller must not add any of the lines.
///
/// # Errors
///
/// [`TodoInputErrorCode::BatchTooLarge`] when the batch is longer than
/// `max_batch`, [`TodoInputErrorCode::TooManyTodos`] when the list would exceed
/// [`MAX_TODOS`], otherwise the first per-line [`TodoInputError`].
pub fn validate_todo_batch(
    texts: &[String],
    existing_count: usize,
    max_batch: usize,
) -> Result<(), TodoInputError> {
    if texts.len() > max_batch {
        return Err(TodoInputError::new(
            TodoInputErrorCode::BatchTooLarge,
            format!("Too many todos in one paste; the limit is {max_batch}"),
        ));
    }
    if existing_count.saturating_add(texts.len()) > MAX_TODOS {
        return Err(TodoInputError::new(
            TodoInputErrorCode::TooManyTodos,
            format!("Too many todos; the limit is {MAX_TODOS}"),
        ));
    }
    for text in texts {
        validate_todo_text(text, MAX_TODO_CHARS)?;
    }
    Ok(())
}

/// The default batch validator both the host and its tests use.
///
/// # Errors
///
/// See [`validate_todo_batch`].
pub fn validate_default_batch(
    texts: &[String],
    existing_count: usize,
) -> Result<(), TodoInputError> {
    validate_todo_batch(texts, existing_count, MAX_PASTE_TODOS)
}

#[cfg(test)]
mod tests {
    use super::{
        MAX_PASTE_TODOS, MAX_TODO_CHARS, MAX_TODOS, TodoInputError, TodoInputErrorCode,
        validate_default_batch, validate_todo_batch, validate_todo_text, validate_utf16,
    };

    /// (input, expected code) for the shared validation table; `None` means
    /// the text is accepted.
    const TABLE: &[(&str, Option<TodoInputErrorCode>)] = &[
        ("buy milk @home", None),
        ("x completed", None),
        ("keep\tthe tab", None),
        ("", Some(TodoInputErrorCode::Empty)),
        ("   ", Some(TodoInputErrorCode::Empty)),
        ("\t \u{00A0}", Some(TodoInputErrorCode::Empty)),
        ("one\ntwo", Some(TodoInputErrorCode::Multiline)),
        ("one\r\ntwo", Some(TodoInputErrorCode::Multiline)),
        ("one\u{2028}two", Some(TodoInputErrorCode::Multiline)),
        ("one\u{2029}two", Some(TodoInputErrorCode::Multiline)),
        ("one\u{0000}", Some(TodoInputErrorCode::ControlCharacter)),
        ("one\u{001B}two", Some(TodoInputErrorCode::ControlCharacter)),
        ("one\u{007F}", Some(TodoInputErrorCode::ControlCharacter)),
        ("one\u{0085}", Some(TodoInputErrorCode::ControlCharacter)),
        (
            "2026-02-30 impossible",
            Some(TodoInputErrorCode::InvalidDate),
        ),
        (
            "0000-01-01 impossible",
            Some(TodoInputErrorCode::InvalidDate),
        ),
        (
            "2026-11-15 2026-11-16 two dates",
            Some(TodoInputErrorCode::AmbiguousDate),
        ),
        (
            "2026-11-15 leading date",
            Some(TodoInputErrorCode::LeadingDate),
        ),
        ("2026-11-15", Some(TodoInputErrorCode::LeadingDate)),
    ];

    #[test]
    fn the_validation_table_matches_the_oracle() {
        for (text, expected) in TABLE {
            let result = validate_todo_text(text, MAX_TODO_CHARS);
            match expected {
                None => assert!(result.is_ok(), "{text:?} must be accepted: {result:?}"),
                Some(expected) => {
                    let error = result.expect_err("the table row is rejected");
                    assert_eq!(error.code(), *expected, "{text:?}");
                    assert_eq!(error.code_str(), expected.as_str());
                }
            }
        }
    }

    #[test]
    fn messages_are_the_oracle_strings_and_never_echo_the_payload() {
        let cases = [
            ("", "Todo text cannot be empty or whitespace only"),
            ("a\nb", "Todo must be a single line"),
            ("a\u{0007}b", "Todo contains a disallowed control character"),
            ("2026-13-01 x", "Todo starts with an impossible date"),
            (
                "2026-11-15 2026-11-16 x",
                "Todo starts with more than one date",
            ),
            (
                "2026-11-15 x",
                "Todo text cannot start with a date; use the date picker",
            ),
        ];
        for (text, message) in cases {
            let error = validate_todo_text(text, MAX_TODO_CHARS).expect_err("rejected");
            assert_eq!(error.message(), message, "{text:?}");
            assert_eq!(error.to_string(), message);
            if !text.is_empty() {
                assert!(
                    !error.message().contains(text),
                    "the message echoed the payload: {error}"
                );
            }
        }
    }

    #[test]
    fn the_cap_counts_utf16_units() {
        // 2 000 ASCII characters fit exactly; 2 001 do not. An emoji is two
        // units, so 1 001 of them exceed the cap while 1 000 fit.
        assert!(validate_todo_text(&"a".repeat(MAX_TODO_CHARS), MAX_TODO_CHARS).is_ok());
        let error = validate_todo_text(&"a".repeat(MAX_TODO_CHARS + 1), MAX_TODO_CHARS)
            .expect_err("over the cap");
        assert_eq!(error.code(), TodoInputErrorCode::TooLong);
        assert_eq!(
            error.message(),
            format!("Todo is too long; the limit is {MAX_TODO_CHARS} characters")
        );
        assert!(validate_todo_text(&"🎉".repeat(1000), MAX_TODO_CHARS).is_ok());
        assert_eq!(
            validate_todo_text(&"🎉".repeat(1001), MAX_TODO_CHARS)
                .expect_err("over the cap")
                .code(),
            TodoInputErrorCode::TooLong
        );
        // The edit modal's grandfather clause: a longer cap accepts the value.
        assert!(validate_todo_text(&"a".repeat(2_500), 2_500).is_ok());
    }

    #[test]
    fn an_unpaired_surrogate_is_reported_by_the_utf16_entry_point() {
        let units = [0x0061, 0xD83C]; // "a" + a lone high surrogate
        let error = validate_utf16(&units, MAX_TODO_CHARS).expect_err("unpaired");
        assert_eq!(error.code(), TodoInputErrorCode::UnpairedSurrogate);
        assert_eq!(error.message(), "Todo contains an unpaired surrogate");

        // A well-formed pair is just one astral character.
        assert!(validate_utf16(&[0xD83C, 0xDF89], MAX_TODO_CHARS).is_ok());
        // The earlier rules still win over the surrogate rule.
        assert_eq!(
            validate_utf16(&[0x0020, 0x0020], MAX_TODO_CHARS)
                .expect_err("blank")
                .code(),
            TodoInputErrorCode::Empty
        );
        assert_eq!(
            validate_utf16(&[0x000A, 0xD83C], MAX_TODO_CHARS)
                .expect_err("multiline")
                .code(),
            TodoInputErrorCode::Multiline
        );
        assert_eq!(
            validate_utf16(&[0x0001, 0xD83C], MAX_TODO_CHARS)
                .expect_err("control")
                .code(),
            TodoInputErrorCode::ControlCharacter
        );
    }

    #[test]
    fn batches_are_atomic_and_capacity_checked() {
        let one = vec!["buy milk".to_owned()];
        assert_eq!(validate_default_batch(&one, 0), Ok(()));

        let too_many: Vec<String> = (0..=MAX_PASTE_TODOS).map(|n| format!("todo {n}")).collect();
        let error = validate_default_batch(&too_many, 0).expect_err("batch too large");
        assert_eq!(error.code(), TodoInputErrorCode::BatchTooLarge);
        assert_eq!(
            error.message(),
            format!("Too many todos in one paste; the limit is {MAX_PASTE_TODOS}")
        );

        let error = validate_todo_batch(&one, MAX_TODOS, MAX_PASTE_TODOS).expect_err("capacity");
        assert_eq!(error.code(), TodoInputErrorCode::TooManyTodos);
        assert_eq!(
            error.message(),
            format!("Too many todos; the limit is {MAX_TODOS}")
        );

        // The first bad line rejects the whole batch.
        let mixed = vec!["good".to_owned(), "".to_owned()];
        assert_eq!(
            validate_default_batch(&mixed, 0)
                .expect_err("empty line")
                .code(),
            TodoInputErrorCode::Empty
        );
    }

    #[test]
    fn errors_are_constructible_and_printable() {
        let error = TodoInputError::new(TodoInputErrorCode::TooLong, "bounded");
        assert_eq!(error.to_string(), "bounded");
        assert_eq!(error.code_str(), "too-long");
    }
}
