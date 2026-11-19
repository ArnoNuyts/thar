//! Write-side input validation, mirroring `logic/todo-input.ts`.
//!
//! A todo created or edited in the TUI is validated before it is parsed or
//! written. [`validate_todo_text`] enforces the rules the Ink app enforces, in
//! the same order, with the same bounded messages:
//!
//! 1. the text is not empty or whitespace only (JavaScript whitespace);
//! 2. it is a single line (`\n`, `\r`, `U+2028`, `U+2029`);
//! 3. it holds no rejected control code point (tab is allowed);
//! 4. it is within the effective character cap (UTF-16 code units);
//! 5. it does not start with a leading date token, valid or not.
//!
//! Messages never echo the rejected payload, so they are safe to show in a
//! toast; the [`Display`](core::fmt::Display) string is the user-facing text the
//! TypeScript `TodoInputError` carries.
//!
//! # Character counts
//!
//! Lengths are measured in UTF-16 code units, exactly like
//! `String.prototype.length`, so an astral character counts as two. The edit
//! modal passes `max(MAX_TODO_CHARS, original_len)` so an unchanged legacy line
//! can still be saved while a growing value is rejected.

use core::fmt;

use crate::js::{find_unsafe_control, js_trim};
use crate::limits::{MAX_PASTE_TODOS, MAX_TODO_CHARS, MAX_TODOS};
use crate::scan::scan_prefix;

/// A rejected write-side input.
///
/// The message is bounded and never echoes the rejected payload, so it can be
/// shown in a toast or logged as-is. Variants that carry a limit include it in
/// the message, exactly like the TypeScript oracle.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TodoInputError {
    /// Empty or whitespace-only text.
    Empty,
    /// More than one line.
    Multiline,
    /// A rejected C0/C1 control, DEL, or a Unicode line separator.
    ControlCharacter,
    /// Longer than the effective cap, in UTF-16 code units.
    TooLong {
        /// The effective cap that was exceeded.
        max_chars: usize,
    },
    /// The leading date token is not a real calendar day.
    InvalidDate,
    /// More than one leading date token.
    AmbiguousDate,
    /// A valid leading date token; the app owns creation dates.
    LeadingDate,
    /// More lines than one paste may add.
    BatchTooLarge {
        /// The maximum number of lines one paste may add.
        max_batch: usize,
    },
    /// The in-memory list would exceed [`MAX_TODOS`].
    TooManyTodos {
        /// The maximum number of todos the list may hold.
        limit: usize,
    },
}

impl fmt::Display for TodoInputError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => formatter.write_str("Todo text cannot be empty or whitespace only"),
            Self::Multiline => formatter.write_str("Todo must be a single line"),
            Self::ControlCharacter => {
                formatter.write_str("Todo contains a disallowed control character")
            }
            Self::TooLong { max_chars } => {
                write!(
                    formatter,
                    "Todo is too long; the limit is {max_chars} characters"
                )
            }
            Self::InvalidDate => formatter.write_str("Todo starts with an impossible date"),
            Self::AmbiguousDate => formatter.write_str("Todo starts with more than one date"),
            Self::LeadingDate => {
                formatter.write_str("Todo text cannot start with a date; use the date picker")
            }
            Self::BatchTooLarge { max_batch } => {
                write!(
                    formatter,
                    "Too many todos in one paste; the limit is {max_batch}"
                )
            }
            Self::TooManyTodos { limit } => {
                write!(formatter, "Too many todos; the limit is {limit}")
            }
        }
    }
}

impl std::error::Error for TodoInputError {}

/// True when the text contains one of the four line separators.
fn is_multiline(text: &str) -> bool {
    text.contains(['\n', '\r', '\u{2028}', '\u{2029}'])
}

/// Validate one todo line before it is parsed or written.
///
/// `max_chars` is the effective character cap in UTF-16 code units; pass
/// [`MAX_TODO_CHARS`] for a new todo and `max(MAX_TODO_CHARS, original_len)` for
/// an edit.
///
/// # Errors
///
/// Returns the first [`TodoInputError`] the text violates, in the oracle's
/// order: empty, multiline, control-character, too-long, then the leading-date
/// rules.
///
/// # Example
///
/// ```
/// use thar_core::{MAX_TODO_CHARS, TodoInputError, validate_todo_text};
///
/// assert!(validate_todo_text("buy milk @home", MAX_TODO_CHARS).is_ok());
/// let error = validate_todo_text("2026-11-15 buy milk", MAX_TODO_CHARS)
///     .expect_err("a leading date is rejected");
/// assert_eq!(error, TodoInputError::LeadingDate);
/// ```
pub fn validate_todo_text(text: &str, max_chars: usize) -> Result<(), TodoInputError> {
    if js_trim(text).is_empty() {
        return Err(TodoInputError::Empty);
    }
    if is_multiline(text) {
        return Err(TodoInputError::Multiline);
    }
    if find_unsafe_control(text).is_some() {
        return Err(TodoInputError::ControlCharacter);
    }
    if text.encode_utf16().count() > max_chars {
        return Err(TodoInputError::TooLong { max_chars });
    }
    validate_leading_dates(text)
}

/// The leading-date rules (invalid, ambiguous, then leading).
fn validate_leading_dates(text: &str) -> Result<(), TodoInputError> {
    let prefix = scan_prefix(text);
    if !prefix.invalid_date_tokens.is_empty() {
        return Err(TodoInputError::InvalidDate);
    }
    if prefix.date_tokens.len() > 1 {
        return Err(TodoInputError::AmbiguousDate);
    }
    if !prefix.date_tokens.is_empty() {
        return Err(TodoInputError::LeadingDate);
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
/// [`TodoInputError::BatchTooLarge`] when the batch is longer than `max_batch`,
/// [`TodoInputError::TooManyTodos`] when the list would exceed [`MAX_TODOS`],
/// otherwise the first per-line [`TodoInputError`].
pub fn validate_todo_batch(
    texts: &[String],
    existing_count: usize,
    max_batch: usize,
) -> Result<(), TodoInputError> {
    if texts.len() > max_batch {
        return Err(TodoInputError::BatchTooLarge { max_batch });
    }
    if existing_count.saturating_add(texts.len()) > MAX_TODOS {
        return Err(TodoInputError::TooManyTodos { limit: MAX_TODOS });
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
        MAX_PASTE_TODOS, MAX_TODO_CHARS, MAX_TODOS, TodoInputError, validate_default_batch,
        validate_todo_batch, validate_todo_text,
    };
    use crate::js::is_js_whitespace;

    /// (input, expected error) for the shared validation table; `None` means
    /// the text is accepted.
    const TABLE: &[(&str, Option<TodoInputError>)] = &[
        ("buy milk @home", None),
        ("x completed", None),
        ("keep\tthe tab", None),
        ("", Some(TodoInputError::Empty)),
        ("   ", Some(TodoInputError::Empty)),
        ("\t \u{00A0}", Some(TodoInputError::Empty)),
        ("one\ntwo", Some(TodoInputError::Multiline)),
        ("one\r\ntwo", Some(TodoInputError::Multiline)),
        ("one\u{2028}two", Some(TodoInputError::Multiline)),
        ("one\u{2029}two", Some(TodoInputError::Multiline)),
        ("one\u{0000}", Some(TodoInputError::ControlCharacter)),
        ("one\u{001B}two", Some(TodoInputError::ControlCharacter)),
        ("one\u{007F}", Some(TodoInputError::ControlCharacter)),
        ("one\u{0085}", Some(TodoInputError::ControlCharacter)),
        ("2026-02-30 impossible", Some(TodoInputError::InvalidDate)),
        ("0000-01-01 impossible", Some(TodoInputError::InvalidDate)),
        (
            "2026-11-15 2026-11-16 two dates",
            Some(TodoInputError::AmbiguousDate),
        ),
        ("2026-11-15 leading date", Some(TodoInputError::LeadingDate)),
        ("2026-11-15", Some(TodoInputError::LeadingDate)),
    ];

    #[test]
    fn the_validation_table_matches_the_oracle() {
        for (text, expected) in TABLE {
            let result = validate_todo_text(text, MAX_TODO_CHARS);
            assert_eq!(result.err().as_ref(), expected.as_ref(), "{text:?}");
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
            assert_eq!(error.to_string(), message, "{text:?}");
            if !text.is_empty() {
                assert!(
                    !error.to_string().contains(text),
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
        assert_eq!(
            error,
            TodoInputError::TooLong {
                max_chars: MAX_TODO_CHARS
            }
        );
        assert_eq!(
            error.to_string(),
            format!("Todo is too long; the limit is {MAX_TODO_CHARS} characters")
        );
        assert!(validate_todo_text(&"🎉".repeat(1000), MAX_TODO_CHARS).is_ok());
        assert_eq!(
            validate_todo_text(&"🎉".repeat(1001), MAX_TODO_CHARS),
            Err(TodoInputError::TooLong {
                max_chars: MAX_TODO_CHARS
            })
        );
        // The edit modal's grandfather clause: a longer cap accepts the value.
        assert!(validate_todo_text(&"a".repeat(2_500), 2_500).is_ok());
    }

    #[test]
    fn batches_are_atomic_and_capacity_checked() {
        let one = vec!["buy milk".to_owned()];
        assert_eq!(validate_default_batch(&one, 0), Ok(()));

        let too_many: Vec<String> = (0..=MAX_PASTE_TODOS).map(|n| format!("todo {n}")).collect();
        let error = validate_default_batch(&too_many, 0).expect_err("batch too large");
        assert_eq!(
            error,
            TodoInputError::BatchTooLarge {
                max_batch: MAX_PASTE_TODOS
            }
        );
        assert_eq!(
            error.to_string(),
            format!("Too many todos in one paste; the limit is {MAX_PASTE_TODOS}")
        );

        let error = validate_todo_batch(&one, MAX_TODOS, MAX_PASTE_TODOS).expect_err("capacity");
        assert_eq!(error, TodoInputError::TooManyTodos { limit: MAX_TODOS });
        assert_eq!(
            error.to_string(),
            format!("Too many todos; the limit is {MAX_TODOS}")
        );

        // The first bad line rejects the whole batch.
        let mixed = vec!["good".to_owned(), "".to_owned()];
        assert_eq!(
            validate_default_batch(&mixed, 0),
            Err(TodoInputError::Empty)
        );
    }

    #[test]
    fn whitespace_only_matches_javascript() {
        for text in ["", " ", "\t", "\u{FEFF}", "\u{00A0}"] {
            assert!(
                text.chars().all(is_js_whitespace),
                "{text:?} must be JavaScript whitespace"
            );
            assert_eq!(
                validate_todo_text(text, MAX_TODO_CHARS),
                Err(TodoInputError::Empty)
            );
        }
    }
}
