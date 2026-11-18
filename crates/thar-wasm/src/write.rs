//! The `serialize_file` request and its JSON envelope.
//!
//! CP4's write path: the host hands over the structured records it already
//! holds (the same DTO `build_rows` accepts, see [`crate::record`]) and gets
//! back the exact file text `writeTodosToFile` would write, or the write-time
//! control-character rejection.
//!
//! # Request
//!
//! ```json
//! { "todos": [ …the records documented in `crate::record`… ] }
//! ```
//!
//! `todos` is required and may be empty. Unknown fields are ignored, so a CP1
//! parse record with its extra `isDone`/`toString`/`hash` fields can be sent
//! without a second projection. As everywhere on this boundary, missing
//! required fields are a *data* error, never a panic.
//!
//! # Response
//!
//! ```json
//! { "ok": true, "text": "one\ntwo\n" }
//! ```
//!
//! or
//!
//! ```json
//! { "ok": false, "error": { "name": …, "code": …, "message": …, … } }
//! ```
//!
//! The shape is the CP1 write shape exactly: one `Todo::to_string()` per record,
//! joined with `"\n"`, plus one trailing `"\n"`. Serializing **zero** todos
//! therefore yields `"\n"`, because the TypeScript oracle is
//! `todos.map(toString).join("\n") + "\n"` and `[].join("\n")` is `""`; the
//! empty list is not a special case and its file is not empty.
//!
//! # Write-time guard
//!
//! `serializeTodosForWrite` refuses to persist a control character that could
//! reach state through a programmatic caller (`logic/control-characters.ts`).
//! The same rule runs here, on the serialized lines, **before** any text is
//! returned: per line in order, the first rejected code point wins, so a
//! rejection always names the first offending line and the first offending code
//! point on it. Tab stays allowed because the reader and the renderer preserve
//! it.
//!
//! That rejection is the one `ok: false` envelope with a
//! `TodoControlCharacterError` class; the TypeScript adapter maps it back to the
//! same user-facing error it would have thrown itself. The `code` is
//! `UNSAFE_CONTROL_CHARACTER`, deliberately distinct from the read path's
//! `CONTROL_CHARACTER`: it tells the adapter which policy rejected the value,
//! and the numeric field is `index` (the 1-based line) rather than the reader's
//! `lineNumber`.
//!
//! Everything else (`INVALID_INPUT`) is a malformed request: the adapter treats
//! it as "the Rust path is unavailable" and falls back to the TypeScript
//! serializer.

use thar_core::{CoreError, Todo, find_unsafe_control};

use crate::json::{self, push_json_number, push_json_string};
use crate::record::{RecordError, todo_records};

/// Class name of a malformed `serialize_file` request.
const INPUT_ERROR_NAME: &str = "TodoSerializeFileError";

/// Class name the write-time guard shares with `logic/limits.ts`.
const CONTROL_ERROR_NAME: &str = "TodoControlCharacterError";

/// Machine code for a rejected write-time control code point.
const CONTROL_ERROR_CODE: &str = "UNSAFE_CONTROL_CHARACTER";

/// Why a `serialize_file` request was not answered with text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WriteError {
    /// The document is not valid JSON.
    InvalidJson {
        /// Byte offset where the reader stopped.
        offset: usize,
        /// Fixed description of the syntax problem.
        reason: &'static str,
    },
    /// The document is valid JSON but a record field has the wrong type or
    /// shape.
    InvalidInput {
        /// Request field the problem belongs to.
        field: &'static str,
        /// Fixed description of the rule that was broken.
        reason: &'static str,
    },
    /// A serialized line contains a control code point the writer refuses.
    UnsafeControl {
        /// 1-based line number of the first offending line.
        line_number: usize,
        /// The first rejected code point on that line.
        code_point: u32,
    },
}

impl WriteError {
    /// Stable machine code, in the CP1 style.
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::InvalidJson { .. } | Self::InvalidInput { .. } => "INVALID_INPUT",
            Self::UnsafeControl { .. } => CONTROL_ERROR_CODE,
        }
    }

    /// The error class name the TypeScript adapter maps back to.
    pub(crate) fn name(&self) -> &'static str {
        match self {
            Self::InvalidJson { .. } | Self::InvalidInput { .. } => INPUT_ERROR_NAME,
            Self::UnsafeControl { .. } => CONTROL_ERROR_NAME,
        }
    }

    /// Content-free explanation; never quotes the request or a todo line.
    ///
    /// The guard reuses [`CoreError::ControlCharacter`]'s `Display`, so the
    /// text is byte-identical to the error `logic/limits.ts` builds for the same
    /// line and code point.
    pub(crate) fn message(&self) -> String {
        match *self {
            Self::InvalidJson { offset, reason } => {
                format!("serialize_file input is not valid JSON: {reason} at byte {offset}")
            }
            Self::InvalidInput { field, reason } => {
                format!("serialize_file input field `{field}` {reason}")
            }
            Self::UnsafeControl {
                line_number,
                code_point,
            } => CoreError::ControlCharacter {
                line_number,
                code_point,
            }
            .to_string(),
        }
    }
}

impl From<RecordError> for WriteError {
    fn from(error: RecordError) -> Self {
        Self::InvalidInput {
            field: error.field,
            reason: error.reason,
        }
    }
}

/// Serialize the decoded todos and apply the write-time guard.
///
/// The guard runs per line, before the line is joined, so an embedded newline in
/// a `text` field is reported against the line that holds it instead of being
/// mistaken for the `"\n"` separator (the TypeScript oracle scans
/// `todos.map(toString)` the same way).
///
/// [`find_unsafe_control`] decides the set. The TypeScript rule scans UTF-16
/// code units (`charCodeAt`); every rejected range is inside the BMP, so
/// scanning Unicode scalar values decides exactly the same set and reports the
/// same number for the first match: a surrogate half is never in a rejected
/// range, and no rejected code point is astral.
///
/// This is deliberately not a thin wrapper over `thar_core::serialize_file`:
/// that helper joins first, so the line number and code point of a rejected
/// character could no longer be recovered. The join below is three lines and the
/// guard is the reason this loop exists.
fn serialize_todos(todos: &[Todo]) -> Result<String, WriteError> {
    let mut out = String::with_capacity(
        todos
            .iter()
            .map(|todo| todo.text.len() + 32)
            .sum::<usize>()
            .saturating_add(1),
    );

    for (index, todo) in todos.iter().enumerate() {
        let line = todo.to_string();
        if let Some(code_point) = find_unsafe_control(&line) {
            return Err(WriteError::UnsafeControl {
                line_number: index + 1,
                code_point: u32::from(code_point),
            });
        }
        if index > 0 {
            out.push('\n');
        }
        out.push_str(&line);
    }
    out.push('\n');
    Ok(out)
}

/// Decode one request document.
fn decode(input: &str) -> Result<Vec<Todo>, WriteError> {
    let document = json::parse(input).map_err(|error| WriteError::InvalidJson {
        offset: error.offset,
        reason: error.reason,
    })?;
    Ok(todo_records(&document)?)
}

/// Build the response envelope for one request document.
///
/// This is the whole `serialize_file` implementation behind the wasm export: it
/// is a plain function so the native tests can exercise it without a JavaScript
/// runtime.
pub(crate) fn serialize_envelope(input: &str) -> String {
    let mut out = String::with_capacity(input.len().saturating_add(64));

    match decode(input).and_then(|todos| serialize_todos(&todos)) {
        Ok(text) => {
            out.push_str("{\"ok\":true,\"text\":");
            push_json_string(&mut out, &text);
            out.push('}');
        }
        Err(error) => push_error(&mut out, &error),
    }

    out
}

/// Append the `{"ok":false,…}` envelope.
///
/// Field order: `name`, `code`, `message`, then the numeric fields the variant
/// carries (`index`, `codePoint`). This is the contract the TypeScript adapter
/// reads; it is deliberately spelled out here instead of delegated.
fn push_error(out: &mut String, error: &WriteError) {
    out.push_str("{\"ok\":false,\"error\":{\"name\":");
    push_json_string(out, error.name());
    out.push_str(",\"code\":");
    push_json_string(out, error.code());
    out.push_str(",\"message\":");
    push_json_string(out, &error.message());

    if let WriteError::UnsafeControl {
        line_number,
        code_point,
    } = *error
    {
        out.push_str(",\"index\":");
        push_json_number(out, line_number as u64);
        out.push_str(",\"codePoint\":");
        push_json_number(out, u64::from(code_point));
    }

    out.push_str("}}");
}

#[cfg(test)]
mod tests {
    use super::{WriteError, serialize_envelope};

    /// One record; `extra` appends further JSON fields.
    fn record(text: &str, extra: &str) -> String {
        format!(
            "{{\"text\":{},\"state\":\"todo\",\"priority\":null,\
             \"completionDate\":null,\"creationDate\":null,\
             \"projects\":[],\"contexts\":[],\"tags\":[]{extra}}}",
            serde_json::to_string(text).expect("a JSON string")
        )
    }

    fn request(records: &[String]) -> String {
        format!("{{\"todos\":[{}]}}", records.join(","))
    }

    fn envelope(records: &[String]) -> serde_json::Value {
        let json = serialize_envelope(&request(records));
        serde_json::from_str(&json).expect("valid JSON")
    }

    #[test]
    fn joins_lines_with_one_trailing_newline() {
        let json = serialize_envelope(&request(&[record("one", ""), record("two", "")]));
        assert_eq!(json, "{\"ok\":true,\"text\":\"one\\ntwo\\n\"}");
    }

    #[test]
    fn an_empty_list_is_one_newline() {
        // `[].join("\n") + "\n"` in `logic/todo-file-helpers.ts`.
        assert_eq!(
            serialize_envelope("{\"todos\":[]}"),
            "{\"ok\":true,\"text\":\"\\n\"}"
        );
    }

    #[test]
    fn serializes_priority_dates_tags_and_the_round_trip_flags() {
        let line = "x (A) 2024-03-02 2024-03-01 ship it @work beta:one,two";
        let done = "{\"text\":\"ship it @work\",\"state\":\"done\",\"priority\":\"A\",\
                    \"completionDate\":\"2024-03-02\",\"creationDate\":\"2024-03-01\",\
                    \"projects\":[],\"contexts\":[\"work\"],\
                    \"tags\":[[\"beta\",[\"one\",\"two\"]]]}";
        let json = serialize_envelope(&request(&[done.to_owned()]));
        let value: serde_json::Value = serde_json::from_str(&json).expect("valid JSON");
        assert_eq!(value["text"], format!("{line}\n"));

        // The same record with both flags keeps the literal dates in `text`
        // and must not prepend them again.
        let literal = "{\"text\":\"2024-03-02 ship it\",\"state\":\"done\",\
                       \"priority\":null,\"completionDate\":\"2024-03-02\",\
                       \"creationDate\":null,\"projects\":[],\"contexts\":[],\
                       \"tags\":[],\"datesInText\":true,\
                       \"completionDateInText\":true}";
        let json = serialize_envelope(&request(&[literal.to_owned()]));
        let value: serde_json::Value = serde_json::from_str(&json).expect("valid JSON");
        assert_eq!(value["text"], "x 2024-03-02 ship it\n");
    }

    #[test]
    fn rejects_the_first_unsafe_code_point_of_the_first_line() {
        let value = envelope(&[
            record("safe", ""),
            record("bell\u{0007} and \u{001B}", ""),
            record("nul\u{0000}", ""),
        ]);

        assert_eq!(value["ok"], false);
        assert_eq!(value["error"]["name"], "TodoControlCharacterError");
        assert_eq!(value["error"]["code"], "UNSAFE_CONTROL_CHARACTER");
        assert_eq!(value["error"]["index"], 2);
        assert_eq!(value["error"]["codePoint"], 0x07);
        assert_eq!(
            value["error"]["message"],
            "Todo file line 2 contains the control character U+0007. \
             Remove control characters from the file. Nothing was changed."
        );
    }

    #[test]
    fn reports_a_newline_inside_a_line_at_that_line() {
        // A `text` field may contain a newline (programmatic state). The
        // TypeScript guard scans `todos.map(toString)`, so the separator is
        // never reported as line 1 when the newline belongs to line 2.
        let value = envelope(&[record("one", ""), record("two\nthree", "")]);
        assert_eq!(value["error"]["index"], 2);
        assert_eq!(value["error"]["codePoint"], 0x0A);
    }

    #[test]
    fn allows_tab_and_escapes_the_rest() {
        let value = envelope(&[record("tab\there", "")]);
        assert_eq!(value["ok"], true);
        assert_eq!(value["text"], "tab\there\n");
    }

    #[test]
    fn rejects_an_empty_control_set_on_a_later_line_only() {
        // U+2028/U+2029 are rejected; they must not be confused with LF.
        let value = envelope(&[record("sep\u{2028}", "")]);
        assert_eq!(value["error"]["codePoint"], 0x2028);
        assert_eq!(value["error"]["index"], 1);
    }

    #[test]
    fn rejects_malformed_requests_without_panicking() {
        for input in [
            "not json",
            "{}",
            "{\"todos\":{}}",
            "{\"todos\":[{\"text\":\"one\"}]}",
            "{\"todos\":[{\"text\":\"one\",\"state\":\"done\",\
              \"priority\":\"AA\",\"completionDate\":null,\
              \"creationDate\":null,\"projects\":[],\"contexts\":[],\
              \"tags\":[]}]}",
        ] {
            let json = serialize_envelope(input);
            let value: serde_json::Value = serde_json::from_str(&json).expect("valid JSON");
            assert_eq!(value["ok"], false, "input {input}");
            assert_eq!(
                value["error"]["name"], "TodoSerializeFileError",
                "input {input}"
            );
            assert_eq!(value["error"]["code"], "INVALID_INPUT", "input {input}");
            assert!(
                value["error"]["message"]
                    .as_str()
                    .is_some_and(|message| !message.is_empty()),
                "input {input}"
            );
            // Input errors carry no line/code-point fields.
            assert!(value["error"].get("index").is_none(), "input {input}");
        }
    }

    #[test]
    fn never_echoes_input_in_an_error_message() {
        let secret = "SECRET-todo-text-4f21";
        let json = serialize_envelope(&format!("{{\"todos\":[{secret}"));
        assert!(!json.contains(secret), "{json}");
    }

    #[test]
    fn never_panics_on_arbitrary_records() {
        for text in [
            "",
            "(A)",
            "2023-02-29",
            "http://example.com",
            "a:b c:d",
            "\u{FEFF}bom",
            "🚀 astral",
            "beta:one beta:two",
        ] {
            let json = serialize_envelope(&request(&[record(text, "")]));
            let value: serde_json::Value = serde_json::from_str(&json).expect("valid JSON");
            assert_eq!(value["ok"], true, "text {text:?}");
        }
    }

    #[test]
    fn maps_the_guard_error_fields_in_contract_order() {
        let json = serialize_envelope(&request(&[record("nul\u{0000}", "")]));
        assert_eq!(
            json,
            "{\"ok\":false,\"error\":{\"name\":\"TodoControlCharacterError\",\
             \"code\":\"UNSAFE_CONTROL_CHARACTER\",\
             \"message\":\"Todo file line 1 contains the control character U+0000. \
             Remove control characters from the file. Nothing was changed.\",\
             \"index\":1,\"codePoint\":0}}"
        );
        assert_eq!(
            WriteError::InvalidInput {
                field: "todos",
                reason: "must be an array of todo records",
            }
            .code(),
            "INVALID_INPUT"
        );
    }
}
