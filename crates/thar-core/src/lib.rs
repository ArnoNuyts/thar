//! `thar-core`: the pure `todo.txt` domain model for the Thar Rust port.
//!
//! This crate is the domain half of checkpoints CP2 and CP3a in
//! `docs/rust-port/PLAN.md`. It owns parsing, serialization, dates, limits, and
//! file validation, plus recurrence planning, the immutable setters and
//! `toggle_state`, sort/hidden-filter/search, the contiguous-context row model,
//! and the pure navigation helpers. It is deliberately tiny: no I/O, no clock,
//! no ambient time, no `unsafe`, and no third-party dependencies. The clock
//! enters as a [`TodoDate`] argument; the filesystem stays in the host.
//!
//! # TypeScript parity contract
//!
//! Behaviour is defined by the TypeScript oracle (`logic/todo.ts`,
//! `logic/dates.ts`, `logic/patterns.ts`, `logic/control-characters.ts`,
//! `logic/limits.ts`, `logic/todo-file-validation.ts`) and frozen by the CP0
//! corpus in `testdata/port/`. The non-obvious rules:
//!
//! - Line lengths are UTF-16 code units, because `String.prototype.length`
//!   counts them; an astral character counts as two.
//! - JavaScript `\s` and `.trim()` are not Rust's; one shared scanner
//!   implements the JS set, including `U+FEFF`.
//! - `\w`, `\d`, and tag keys are ASCII only.
//! - Tags are scanned left to right, non-overlapping, and removed in one pass;
//!   duplicate keys append in encounter order and serialize comma-joined.
//! - Invalid or ambiguous leading dates stay in `text`; a completed line with
//!   a literal completion date keeps `completion_date_in_text` so serialization
//!   never duplicates it.
//! - Serialization never loses a tag or reorders one.
//! - Case folding and search-term extraction belong to the host: JavaScript's
//!   `toLowerCase` applies the Unicode `Final_Sigma` rule with
//!   `Case_Ignorable` skipping, and `extractSearchTerms` is a JavaScript regex
//!   pipeline. Rust's Unicode version can trail the host's, so search takes
//!   already-normalized [`SearchView`]s and terms instead of approximating
//!   either.
//!
//! # Decoding boundary
//!
//! Everything above the byte layer takes `&str`, never bytes. The Node reader
//! decodes with `String::from_utf8_lossy`, exactly like the TypeScript oracle,
//! so invalid UTF-8 reaches this crate as `U+FFFD` and the crate never rejects
//! it. Callers that read files themselves must do the same lossy decode; the
//! corpus pins that (`invalid-utf8.txt`).
//!
//! # Example
//!
//! ```
//! use thar_core::{Todo, TodoId};
//!
//! let line = "x (A) 2024-03-02 fixed the bug +thar due:2024-03-01";
//! let todo = Todo::parse_line(line, TodoId::new(0));
//! assert_eq!(todo.text, "fixed the bug +thar");
//! assert_eq!(todo.serialize(), line);
//! ```
//!
//! (The corpus tests in `tests/corpus_parity.rs` pin every field and the exact
//! serialized bytes for the CP0 fixtures.)

#![forbid(unsafe_code)]
#![deny(missing_docs)]

mod date;
mod error;
mod input;
mod js;
mod limits;
mod model;
mod nav;
mod query;
mod recurrence;
mod rows;
mod scan;
mod validation;

pub use date::{
    TodoDate, add_days, add_months, add_weeks, add_years, days_in_month, end_of_month,
    start_of_month, start_of_week_monday, weekday,
};
pub use error::CoreError;
pub use input::{
    TodoInputError, TodoInputErrorCode, validate_default_batch, validate_todo_batch,
    validate_todo_text, validate_utf16,
};
pub use js::{is_js_whitespace, js_trim};
pub use limits::{
    DEFAULT_MAX_FILE_BYTES, DEFAULT_MAX_LINE_CHARS, DEFAULT_MAX_READ_TODOS, MAX_PASTE_TODOS,
    MAX_TODO_CHARS, MAX_TODOS, ReadLimits,
};
pub use model::{Priority, State, TagValue, Todo, TodoId, TodoParts, ToggleResult, serialize_file};
pub use nav::{
    SelectionRange, calculate_scroll_offset, find_todo_row, get_navigable_row,
    get_selection_range_rows, guesstimate_selection, validate_selection,
};
pub use query::{SearchView, filter_by_search, filter_hidden, sort_by_importance, view_matches};
pub use recurrence::{
    MAX_RECURRENCE_AMOUNT, Recurrence, RecurrenceError, RecurrenceUnit, is_valid_recurrence,
    plan_recurrence,
};
pub use rows::{NONE_CONTEXT, Row, RowError, RowInput, Rows, build_rows, create_rows};
pub use validation::{is_blank_line, validate_file_bytes, validate_file_content};

/// Crate version, surfaced through the WASM smoke test.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Parse a whole file into todos, assigning ids in load order.
///
/// This is the pure part of `readTodosFromFile` in
/// `logic/todo-file-helpers.ts`: validate the text, drop blank lines, and parse
/// the rest. Byte-size limits and file I/O stay with the caller; use
/// [`validate_file_bytes`] for the size rule.
///
/// `data` is already-decoded text (lossy `U+FFFD` for invalid UTF-8, as the
/// Node reader does), never raw bytes.
///
/// # Errors
///
/// Returns the first file-level violation from [`validate_file_content`]:
/// [`CoreError::TooManyLines`], [`CoreError::LineTooLong`], or
/// [`CoreError::ControlCharacter`]. Parse errors are not possible: every
/// non-blank line becomes one [`Todo`].
#[must_use = "the parsed todos are the result; ignoring them parses for nothing"]
pub fn parse_file(data: &str, limits: &ReadLimits) -> Result<Vec<Todo>, CoreError> {
    let lines = validate_file_content(data, limits)?;
    let mut todos = Vec::new();

    for line in lines {
        if is_blank_line(line) {
            continue;
        }
        let id = TodoId::new(todos.len() as u64);
        todos.push(Todo::parse_line(line, id));
    }

    Ok(todos)
}

#[cfg(test)]
mod tests {
    use super::{ReadLimits, TodoDate, parse_file, serialize_file};

    #[test]
    fn parses_a_file_and_skips_blank_lines() {
        let todos = parse_file("one\n\n  \ntwo\n", &ReadLimits::DEFAULT).expect("valid file");
        assert_eq!(todos.len(), 2);
        assert_eq!(todos[0].text, "one");
        assert_eq!(todos[1].text, "two");
        assert_eq!(todos[0].id.value(), 0);
        assert_eq!(todos[1].id.value(), 1);
    }

    #[test]
    fn empty_file_has_no_todos_and_serializes_to_one_newline() {
        let todos = parse_file("", &ReadLimits::DEFAULT).expect("valid file");
        assert!(todos.is_empty());
        assert_eq!(serialize_file(&todos), "\n");
    }

    #[test]
    fn crlf_is_normalized_on_the_round_trip() {
        let todos = parse_file("a\r\nb\r\n", &ReadLimits::DEFAULT).expect("valid file");
        assert_eq!(todos.len(), 2);
        assert_eq!(serialize_file(&todos), "a\nb\n");
    }

    #[test]
    fn rejects_invalid_files_with_typed_errors() {
        let error = parse_file("\u{0000}\n", &ReadLimits::DEFAULT).expect_err("control byte");
        assert_eq!(error.code(), "CONTROL_CHARACTER");
    }

    #[test]
    fn today_is_an_argument_not_a_clock_read() {
        let todos = parse_file("due:2026-11-14 old\n", &ReadLimits::DEFAULT).expect("valid file");
        let today = TodoDate::new(2026, 11, 15).expect("valid");
        assert!(todos[0].is_overdue(today));
        let tomorrow = TodoDate::new(2026, 11, 16).expect("valid");
        assert!(todos[0].is_overdue(tomorrow));
    }
}
