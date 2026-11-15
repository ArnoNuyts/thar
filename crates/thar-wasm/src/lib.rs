//! WebAssembly batch boundary for the Thar core.
//!
//! Checkpoint CP2b of `docs/rust-port/PLAN.md`: the real batch surface the Node
//! app and the CP1 contract harness call. CP3b1 adds the row builder
//! ([`build_rows`]) on top of it. The boundary is deliberately coarse — one
//! call per file load or row build, no per-row getters — and every call returns
//! one deterministic JSON document that JavaScript can `JSON.parse`.
//!
//! # Envelope
//!
//! [`parse_file`] and [`parse_file_with_limits`] return either
//!
//! ```json
//! {"ok":true,"todos":[…records…]}
//! ```
//!
//! or
//!
//! ```json
//! {"ok":false,"error":{…}}
//! ```
//!
//! A record uses the CP1 contract field names and order exactly (`text`,
//! `state`, `priority`, `completionDate`, `creationDate`, `projects`,
//! `contexts`, `tags`, `isDone`, `isHidden`, `isVisibleInOverview`,
//! `isOverdue`, `toString`, `hash`). The error object uses the contract order
//! too: `name`, `code`, the numeric fields the variant carries (in the CP1
//! order `lineNumber`, `length`, `maxLineChars`, `lineCount`, `maxReadTodos`,
//! `actualBytes`, `maxBytes`, `codePoint`), then `message`.
//!
//! [`build_rows`] takes a structured request (documented in the `rows` module)
//! and answers with
//! `{"ok":true,"rows":[…],"order":[…]}` or the same error envelope.
//!
//! [`serialize_file`] takes the same structured records (documented in the
//! `record` module) and answers with `{"ok":true,"text":"…"}` or the error
//! envelope, including the write-time control-character rejection documented in
//! the `write` module.
//!
//! The JSON is written by hand: every key is emitted in a fixed order, strings
//! are escaped the way `JSON.stringify` would escape them, and no dependency is
//! added just to serialize a handful of fields. That keeps the module inside
//! the CP2 size budget (≤ 250 KB raw, ≤ 100 KB gzip) and makes the field order
//! a property of the code rather than of a serializer's configuration. The one
//! request document that arrives from JavaScript is read by the small parser in
//! the `json` module.
//!
//! # Serialization
//!
//! [`serialize_file`] is the whole-file write shape CP1 defines:
//! `todos.map(toString).join("\n") + "\n"`, i.e. per-record
//! [`thar_core::Todo::serialize`], joined with `"\n"`, plus one trailing `"\n"`
//! (so zero todos produce `"\n"`). It also runs the write-time guard from
//! `serializeTodosForWrite` (`logic/todo-file-helpers.ts`) before returning any
//! text; see the `write` module for the rejection envelope.
//!
//! # Decoding
//!
//! Text arrives already decoded. The Node reader and the candidate runner decode
//! file bytes lossily (`Buffer#toString("utf8")` / `String::from_utf8_lossy`),
//! so invalid UTF-8 reaches this crate as `U+FFFD` and is treated as ordinary
//! text, exactly like the TypeScript oracle. Nothing here rejects it.
//!
//! # Errors
//!
//! Limits and rejected control characters are *data* errors and come back in
//! the `{"ok":false,…}` envelope, never as a panic. The one caller bug — a
//! `today` that is not a real `YYYY-MM-DD` calendar day — is a rejected
//! function result ([`TodayError`]) that wasm-bindgen turns into a thrown
//! JavaScript `Error`; the TypeScript adapter catches it and disables the Rust
//! path instead of surfacing it in the TUI. [`TodayError`] implements
//! `std::error::Error`, so wasm-bindgen's blanket `From<E> for JsError` builds
//! the thrown error from its fixed, content-free `Display` message.

#![forbid(unsafe_code)]
#![deny(missing_docs)]

mod json;
mod record;
mod rows;
mod write;

use core::fmt;

use json::{
    push_json_bool, push_json_char, push_json_number, push_json_string, push_json_string_array,
    push_optional_date,
};
use thar_core::{
    CoreError, ReadLimits, Todo, TodoDate, parse_file as parse_core_file, validate_file_bytes,
};
use wasm_bindgen::prelude::*;

/// Why a call was rejected before any parsing happened.
///
/// This is not a `todo.txt` rule: it means the host passed a `today` that is
/// not a strict `YYYY-MM-DD` calendar day in years 1..=9999.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TodayError {
    /// `today` was not a valid `YYYY-MM-DD` calendar day.
    InvalidToday,
}

impl fmt::Display for TodayError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("today must be a valid YYYY-MM-DD calendar day in years 1..=9999")
    }
}

impl std::error::Error for TodayError {}

/// Version of the embedded `thar-core`, used by the Node smoke test.
#[wasm_bindgen(js_name = coreVersion)]
#[must_use]
pub fn core_version() -> String {
    thar_core::VERSION.to_owned()
}

/// Parse a whole file with the default read limits.
///
/// Returns the JSON envelope documented at the top of this module. `today` is
/// the local calendar day (`YYYY-MM-DD`) used by `isOverdue` and
/// `isVisibleInOverview`; an invalid value is an error, never a panic.
///
/// # Errors
///
/// Returns a JavaScript `Error` (via wasm-bindgen) carrying [`TodayError`] when
/// `today` is not a valid `YYYY-MM-DD` calendar day.
#[wasm_bindgen(js_name = parseFile)]
pub fn parse_file(text: &str, today: &str) -> Result<String, JsError> {
    parse_envelope(text, today, &ReadLimits::DEFAULT).map_err(JsError::from)
}

/// Parse a whole file with explicit read limits.
///
/// This is the same batch call as [`parse_file`], with the three limits the
/// TypeScript reader reads from `THAR_MAX_FILE_BYTES`,
/// `THAR_MAX_READ_TODOS` and `THAR_MAX_LINE_CHARS`. The host owns the
/// environment; the core only receives numbers, so a corpus run can pin them.
///
/// The limits arrive as `f64`, the JavaScript `Number` type, so the whole host
/// range crosses without a `BigInt` round-trip (wasm-bindgen maps `u64`
/// parameters to `BigInt`). They are clamped by [`js_u64`]/[`js_usize`]: a
/// non-finite or non-positive value accepts nothing, and a value beyond the
/// target range saturates instead of wrapping. `max_file_bytes` is a `u64`, so
/// there is no 4 GiB cap; on wasm32 only `max_read_todos`/`max_line_chars`
/// saturate at `usize::MAX`, which no real file reaches.
///
/// # Errors
///
/// Returns a JavaScript `Error` (via wasm-bindgen) carrying [`TodayError`] when
/// `today` is not a valid `YYYY-MM-DD` calendar day.
#[wasm_bindgen(js_name = parseFileWithLimits)]
pub fn parse_file_with_limits(
    text: &str,
    today: &str,
    max_file_bytes: f64,
    max_read_todos: f64,
    max_line_chars: f64,
) -> Result<String, JsError> {
    let limits = ReadLimits {
        max_file_bytes: js_u64(max_file_bytes),
        max_read_todos: js_usize(max_read_todos),
        max_line_chars: js_usize(max_line_chars),
    };
    parse_envelope(text, today, &limits).map_err(JsError::from)
}

/// Build the row model for one search, sort, and visibility state.
///
/// `input` is the JSON request documented in the `rows` module (todos, one
/// host-normalized search view per todo, normalized terms, `showHidden`,
/// `today`). The response is `{"ok":true,"rows":[…],"order":[…]}` or the
/// `{"ok":false,"error":{…}}` envelope; invalid input is a *data* error and
/// never panics.
///
/// One call per build, never per row: the host sends the whole list once and
/// receives the whole row model once.
///
/// # Conventions the host owns
///
/// - **Case folding and term extraction.** `searchViews[*].text/contexts/
///   projects` and `terms` must already be lowercased/extracted by the host
///   (`toLowerCase`, `extractSearchTerms`); the core never folds.
/// - **Collation.** Context names are collated with the en-US ICU order
///   `thar_core::sort_by_importance` implements, the same assumption the CP3a
///   probe pins (`docs/rust-port/PLAN.md` §13). The host must not pre-sort.
/// - **Opaque names.** Names the programme supplies (rather than names scanned
///   out of a line) are not normalized or validated here; they stay opaque
///   until CP3b2/CP4.
///
/// # Example
///
/// ```js
/// const rows = JSON.parse(core.buildRows(JSON.stringify({
///   today: "2026-11-15",
///   showHidden: false,
///   terms: ["work"],
///   todos: records,            // the `parseFile` records
///   searchViews,               // derived from those records, lowercased
/// })));
/// if (!rows.ok) fallbackToTypeScript(rows.error.code);
/// ```
#[wasm_bindgen(js_name = buildRows)]
#[must_use]
pub fn build_rows(input: &str) -> String {
    rows::build_rows_envelope(input)
}

/// Serialize todos exactly as the writer does, with the write-time guard.
///
/// `input` is the JSON request documented in the `write` module: the structured
/// records `build_rows` accepts, under `{"todos":[…]}`. The response is
/// `{"ok":true,"text":"…"}` where `text` is
/// `todos.map(toString).join("\n") + "\n"` (zero todos → `"\n"`), or
/// `{"ok":false,"error":…}`:
///
/// - `{"name":"TodoControlCharacterError","code":"UNSAFE_CONTROL_CHARACTER",
///   "message":…,"index":<1-based line>,"codePoint":<u32>}` when a serialized
///   line contains a control code point the writer refuses. The `index` is the
///   first offending line and the `codePoint` its first offending code point,
///   matching `findUnsafeTodoTextCodePoint` in the write path;
/// - `{"name":"TodoSerializeFileError","code":"INVALID_INPUT","message":…}` when
///   the request itself is malformed.
///
/// Invalid input is a *data* error and never panics: the host falls back to the
/// TypeScript serializer, or maps the control-character rejection back to
/// `TodoControlCharacterError`, before anything touches the file.
///
/// # Example
///
/// ```js
/// const { text, ok, error } = JSON.parse(core.serializeFile(JSON.stringify({
///   todos: records, // the structured records from the app's own Todos
/// })));
/// if (!ok && error.code === "UNSAFE_CONTROL_CHARACTER") {
///   throw new TodoControlCharacterError(error.index, error.codePoint);
/// }
/// ```
#[wasm_bindgen(js_name = serializeFile)]
#[must_use]
pub fn serialize_file(input: &str) -> String {
    write::serialize_envelope(input)
}

/// Clamp a JavaScript limit to a `u64`.
///
/// The host validates its environment before calling; this only defends the
/// boundary. Non-finite and non-positive values accept nothing (`0`) rather
/// than panicking or wrapping, and an oversized value saturates at the integer
/// bound, which for a byte limit is indistinguishable from "no limit".
fn js_u64(value: f64) -> u64 {
    if value.is_finite() && value > 0.0 {
        // `as` saturates at the integer bounds and floors the fraction.
        value as u64
    } else {
        0
    }
}

/// Clamp a JavaScript limit to `usize` (32-bit on wasm32).
fn js_usize(value: f64) -> usize {
    usize::try_from(js_u64(value)).unwrap_or(usize::MAX)
}

/// Build the JSON envelope for one file.
///
/// Split out from the wasm exports so the whole document — including the error
/// mapping — is testable on the native target without a JavaScript runtime.
fn parse_envelope(text: &str, today: &str, limits: &ReadLimits) -> Result<String, TodayError> {
    let today = TodoDate::parse(today).ok_or(TodayError::InvalidToday)?;

    // The reader checks the byte size first (stat, then the decoded bytes) and
    // only then validates lines and control characters; keep that order so the
    // first reported error matches the oracle.
    let parsed =
        validate_file_bytes(text.len() as u64, limits).and_then(|()| parse_core_file(text, limits));

    // A record spells out every field, so a file of short lines expands far
    // more than the input does. 50% of the input plus 256 bytes is right-sized
    // for typical todo lines; a miss only costs an amortized `String` growth,
    // while reserving more would double the peak allocation on a large
    // `todo.txt`.
    let mut out = String::with_capacity(text.len().saturating_mul(3) / 2 + 256);
    match parsed {
        Ok(todos) => {
            out.push_str("{\"ok\":true,\"todos\":[");
            for (index, todo) in todos.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                push_record(&mut out, todo, today);
            }
            out.push_str("]}");
        }
        Err(error) => push_error(&mut out, &error),
    }

    Ok(out)
}

/// Append one todo record in the CP1 field order.
fn push_record(out: &mut String, todo: &Todo, today: TodoDate) {
    out.push_str("{\"text\":");
    push_json_string(out, &todo.text);

    out.push_str(",\"state\":\"");
    out.push_str(if todo.is_done() { "done" } else { "todo" });
    out.push('"');

    out.push_str(",\"priority\":");
    match todo.priority {
        Some(priority) => push_json_char(out, priority.as_char()),
        None => out.push_str("null"),
    }

    out.push_str(",\"completionDate\":");
    push_optional_date(out, todo.completion_date);

    out.push_str(",\"creationDate\":");
    push_optional_date(out, todo.creation_date);

    out.push_str(",\"projects\":");
    push_json_string_array(out, &todo.projects);

    out.push_str(",\"contexts\":");
    push_json_string_array(out, &todo.contexts);

    out.push_str(",\"tags\":[");
    for (index, (key, value)) in todo.tags.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push('[');
        push_json_string(out, key);
        out.push(',');
        match value {
            thar_core::TagValue::One(single) => push_json_string(out, single),
            thar_core::TagValue::Many(values) => {
                out.push('[');
                for (value_index, single) in values.iter().enumerate() {
                    if value_index > 0 {
                        out.push(',');
                    }
                    push_json_string(out, single);
                }
                out.push(']');
            }
        }
        out.push(']');
    }
    out.push(']');

    out.push_str(",\"isDone\":");
    push_json_bool(out, todo.is_done());

    out.push_str(",\"isHidden\":");
    push_json_bool(out, todo.is_hidden());

    out.push_str(",\"isVisibleInOverview\":");
    push_json_bool(out, todo.is_visible_in_overview(today));

    out.push_str(",\"isOverdue\":");
    push_json_bool(out, todo.is_overdue(today));

    // `getHash()` is `toString()`; serialize once and reuse the same bytes.
    let line = todo.serialize();
    out.push_str(",\"toString\":");
    push_json_string(out, &line);
    out.push_str(",\"hash\":");
    push_json_string(out, &line);
    out.push('}');
}

/// Append the CP1 error object, with the numeric fields in contract order.
fn push_error(out: &mut String, error: &CoreError) {
    out.push_str("{\"ok\":false,\"error\":{\"name\":");
    push_json_string(out, error.name());
    out.push_str(",\"code\":");
    push_json_string(out, error.code());

    match *error {
        CoreError::FileTooLarge {
            actual_bytes,
            max_bytes,
        } => {
            out.push_str(",\"actualBytes\":");
            push_json_number(out, actual_bytes);
            out.push_str(",\"maxBytes\":");
            push_json_number(out, max_bytes);
        }
        CoreError::TooManyLines {
            line_count,
            max_read_todos,
        } => {
            out.push_str(",\"lineCount\":");
            push_json_number(out, line_count as u64);
            out.push_str(",\"maxReadTodos\":");
            push_json_number(out, max_read_todos as u64);
        }
        CoreError::LineTooLong {
            line_number,
            length,
            max_line_chars,
        } => {
            out.push_str(",\"lineNumber\":");
            push_json_number(out, line_number as u64);
            out.push_str(",\"length\":");
            push_json_number(out, length as u64);
            out.push_str(",\"maxLineChars\":");
            push_json_number(out, max_line_chars as u64);
        }
        CoreError::ControlCharacter {
            line_number,
            code_point,
        } => {
            out.push_str(",\"lineNumber\":");
            push_json_number(out, line_number as u64);
            out.push_str(",\"codePoint\":");
            push_json_number(out, u64::from(code_point));
        }
    }

    out.push_str(",\"message\":");
    push_json_string(out, &error.to_string());
    out.push_str("}}");
}

#[cfg(test)]
mod tests {
    use super::{TodayError, js_u64, js_usize, parse_envelope, parse_file_with_limits};
    use thar_core::ReadLimits;

    fn parse(text: &str, today: &str) -> String {
        parse_envelope(text, today, &ReadLimits::DEFAULT).expect("a valid today")
    }

    fn limits(max_file_bytes: u64, max_read_todos: usize, max_line_chars: usize) -> ReadLimits {
        ReadLimits {
            max_file_bytes,
            max_read_todos,
            max_line_chars,
        }
    }

    #[test]
    fn clamps_javascript_limits_instead_of_wrapping() {
        assert_eq!(js_u64(1_024.0), 1_024);
        // 4 GiB + 1: the old `u32` parameter would have wrapped to 1.
        assert_eq!(js_u64(4_294_967_297.0), 4_294_967_297);
        assert_eq!(js_u64(f64::NAN), 0);
        assert_eq!(js_u64(f64::INFINITY), 0);
        assert_eq!(js_u64(-1.0), 0);
        assert_eq!(js_u64(0.0), 0);
        assert_eq!(js_u64(2.9), 2);
        assert_eq!(js_usize(9.0), 9);
        // Saturates instead of wrapping on wasm32, where `usize` is 32-bit.
        assert_eq!(js_usize(1e30), usize::MAX);
    }

    #[test]
    fn accepts_a_file_limit_above_four_gibibytes() {
        // Native-target call of the real export: the mapping is pure Rust.
        let json = parse_file_with_limits("abc\n", "2026-11-15", 4_294_967_297.0, 10.0, 10.0)
            .expect("a valid today");
        assert!(json.starts_with("{\"ok\":true"), "{json}");
    }

    #[test]
    fn escapes_a_priority_like_any_other_string() {
        // `push_json_char` delegates to `push_json_string`; a `[A-Z]` priority
        // is unchanged, and the helper no longer has an unescaped fast path.
        let json = parse("(A) one\n", "2026-11-15");
        assert!(json.contains("\"priority\":\"A\""), "{json}");
    }

    #[test]
    fn emits_the_contract_field_order_byte_for_byte() {
        let json = parse("one\ntwo\n", "2026-11-15");
        assert_eq!(
            json,
            "{\"ok\":true,\"todos\":[\
             {\"text\":\"one\",\"state\":\"todo\",\"priority\":null,\
             \"completionDate\":null,\"creationDate\":null,\
             \"projects\":[],\"contexts\":[],\"tags\":[],\
             \"isDone\":false,\"isHidden\":false,\
             \"isVisibleInOverview\":true,\"isOverdue\":false,\
             \"toString\":\"one\",\"hash\":\"one\"},\
             {\"text\":\"two\",\"state\":\"todo\",\"priority\":null,\
             \"completionDate\":null,\"creationDate\":null,\
             \"projects\":[],\"contexts\":[],\"tags\":[],\
             \"isDone\":false,\"isHidden\":false,\
             \"isVisibleInOverview\":true,\"isOverdue\":false,\
             \"toString\":\"two\",\"hash\":\"two\"}]}"
        );
    }

    #[test]
    fn maps_every_parsed_field_and_clock_accessor() {
        let json = parse(
            "x (A) 2024-03-02 2024-03-01 ship +thar @work \
             alpha:one beta:one beta:two h:1 due:2024-01-01 t:2024-01-02",
            "2026-11-15",
        );
        let value: serde_json::Value = serde_json::from_str(&json).expect("valid JSON");
        let record = &value["todos"][0];

        assert_eq!(record["text"], "ship +thar @work");
        assert_eq!(record["state"], "done");
        assert_eq!(record["priority"], "A");
        assert_eq!(record["completionDate"], "2024-03-02");
        assert_eq!(record["creationDate"], "2024-03-01");
        assert_eq!(record["projects"], serde_json::json!(["thar"]));
        assert_eq!(record["contexts"], serde_json::json!(["work"]));
        assert_eq!(
            record["tags"],
            serde_json::json!([
                ["alpha", "one"],
                ["beta", ["one", "two"]],
                ["h", "1"],
                ["due", "2024-01-01"],
                ["t", "2024-01-02"],
            ])
        );
        assert_eq!(record["isDone"], true);
        assert_eq!(record["isHidden"], true);
        assert_eq!(record["isVisibleInOverview"], false);
        assert_eq!(record["isOverdue"], true);
        assert_eq!(record["toString"], record["hash"]);
    }

    #[test]
    fn empty_file_is_an_ok_envelope_with_no_records() {
        assert_eq!(parse("", "2026-11-15"), "{\"ok\":true,\"todos\":[]}");
        assert_eq!(
            parse("\n\n  \n", "2026-11-15"),
            "{\"ok\":true,\"todos\":[]}"
        );
    }

    #[test]
    fn rejects_an_invalid_today_without_panicking() {
        for today in [
            "",
            "2026-11-31",
            "0000-01-01",
            "15-11-2026",
            "2026-1-5",
            "2026-11-15T00:00:00",
        ] {
            assert_eq!(
                parse_envelope("x", today, &ReadLimits::DEFAULT),
                Err(TodayError::InvalidToday),
                "today {today:?}"
            );
        }
    }

    #[test]
    fn maps_control_characters_to_the_contract_error_object() {
        let json = parse("one\n\u{0000}two\n", "2026-11-15");
        assert_eq!(
            json,
            "{\"ok\":false,\"error\":{\"name\":\"TodoControlCharacterError\",\
             \"code\":\"CONTROL_CHARACTER\",\"lineNumber\":2,\"codePoint\":0,\
             \"message\":\"Todo file line 2 contains the control character U+0000. \
             Remove control characters from the file. Nothing was changed.\"}}"
        );
    }

    #[test]
    fn maps_the_limit_errors_in_contract_order() {
        let too_large =
            parse_envelope("abc", "2026-11-15", &limits(2, 10, 10)).expect("a valid today");
        assert_eq!(
            too_large,
            "{\"ok\":false,\"error\":{\"name\":\"TodoFileTooLargeError\",\
             \"code\":\"FILE_TOO_LARGE\",\"actualBytes\":3,\"maxBytes\":2,\
             \"message\":\"Todo file is 3 bytes; the limit is 2 bytes. \
             Trim the file or raise THAR_MAX_FILE_BYTES. Nothing was changed.\"}}"
        );

        let too_many =
            parse_envelope("a\nb\n", "2026-11-15", &limits(1024, 1, 10)).expect("a valid today");
        assert_eq!(
            too_many,
            "{\"ok\":false,\"error\":{\"name\":\"TodoLineCountLimitError\",\
             \"code\":\"TOO_MANY_LINES\",\"lineCount\":2,\"maxReadTodos\":1,\
             \"message\":\"Todo file has 2 lines; the limit is 1. \
             Trim the file or raise THAR_MAX_READ_TODOS. Nothing was changed.\"}}"
        );

        let too_long =
            parse_envelope("abc\n", "2026-11-15", &limits(1024, 10, 2)).expect("a valid today");
        assert_eq!(
            too_long,
            "{\"ok\":false,\"error\":{\"name\":\"TodoLineLengthLimitError\",\
             \"code\":\"LINE_TOO_LONG\",\"lineNumber\":1,\"length\":3,\
             \"maxLineChars\":2,\
             \"message\":\"Todo file line 1 is 3 characters; the limit is 2. \
             Shorten the line or raise THAR_MAX_LINE_CHARS. Nothing was changed.\"}}"
        );
    }

    #[test]
    fn byte_size_is_checked_before_line_rules() {
        // Both limits are violated; the reader reports the size first.
        let json =
            parse_envelope("\u{0000}\n", "2026-11-15", &limits(0, 0, 0)).expect("a valid today");
        assert!(json.contains("\"code\":\"FILE_TOO_LARGE\""), "{json}");
    }

    #[test]
    fn keeps_lossy_decoded_text_as_ordinary_content() {
        let json = parse("\u{FFFD}invalid bytes\n", "2026-11-15");
        let value: serde_json::Value = serde_json::from_str(&json).expect("valid JSON");
        assert_eq!(value["todos"][0]["text"], "\u{FFFD}invalid bytes");
    }

    #[test]
    fn escapes_quotes_backslashes_and_tabs() {
        let json = parse("quote \" backslash \\ tab\there", "2026-11-15");
        assert!(json.contains(r#""text":"quote \" backslash \\ tab\there""#));
        let value: serde_json::Value = serde_json::from_str(&json).expect("valid JSON");
        assert_eq!(
            value["todos"][0]["toString"],
            "quote \" backslash \\ tab\there"
        );
    }

    #[test]
    fn never_panics_on_arbitrary_lines() {
        for line in [
            "",
            "\u{0007}bell",
            "\u{007F}",
            "\u{2028}",
            "x",
            "x ",
            "(A)",
            "2023-02-29",
            "http://example.com",
            "a:b c:d",
            "\u{FEFF}bom",
            "🚀 astral",
        ] {
            let result = parse_envelope(line, "2026-11-15", &ReadLimits::DEFAULT);
            assert!(result.is_ok(), "line {line:?}");
        }
    }
}
