//! The structured `build_rows` request and its JSON envelope.
//!
//! `parse_file` returns CP1 records, so the host already holds the parsed
//! fields when it builds rows on the next keystroke. Re-serializing those
//! records would be lossy (a duplicate tag key collapses into a comma list, and
//! the two round-trip flags are not in the CP1 record set), so this module
//! accepts the fields back as a DTO and rebuilds a [`Todo`] through
//! [`Todo::from_parts`]. The record shape itself is shared with
//! [`crate::write`] and lives in the `record` module.
//!
//! # Request
//!
//! ```json
//! {
//!   "today": "2026-11-15",
//!   "showHidden": false,
//!   "terms": ["work"],
//!   "todos": [
//!     {
//!       "text": "ship it @work",
//!       "state": "todo",
//!       "priority": null,
//!       "completionDate": null,
//!       "creationDate": null,
//!       "projects": [],
//!       "contexts": ["work"],
//!       "tags": [["due", "2024-01-01"]],
//!       "datesInText": false,
//!       "completionDateInText": false
//!     }
//!   ],
//!   "searchViews": [
//!     { "text": "ship it @work", "contexts": ["work"], "projects": [] }
//!   ]
//! }
//! ```
//!
//! - `searchViews` is aligned with `todos`; `views[i]` belongs to `todos[i]`.
//! - `searchViews` and `terms` are **already lowercased/extracted by the host**
//!   (JavaScript's `toLowerCase` applies the Unicode `Final_Sigma` rule, and
//!   `extractSearchTerms` is a JavaScript regex pipeline). Empty `terms` match
//!   every todo.
//! - Todo ids are the array positions, matching parse order. The response
//!   carries the index of every todo row so the host maps back to its objects.
//! - `datesInText`/`completionDateInText` are optional and default to `false`;
//!   they do not affect row building, only serialization. The CP1 parse records
//!   do not carry them, so the rows contract's candidate leaves them `false`; a
//!   host that parsed the line itself (the app's adapter) passes its real flags
//!   so CP4 can rebuild an exact `Todo`.
//!
//! Unknown fields are ignored so a host can pass a CP1 record with its extra
//! `isDone`/`toString` fields without a second projection; missing required
//! fields are rejected.
//!
//! # Response
//!
//! ```json
//! {
//!   "ok": true,
//!   "rows": [
//!     { "type": "context", "contextName": "work", "todoCount": 1 },
//!     { "type": "todo", "number": 1, "index": 0 }
//!   ],
//!   "order": [0]
//! }
//! ```
//!
//! `order` is the sorted, filtered, searched todo order, i.e. the input index
//! of every todo row in row order. Rejected input returns
//! `{"ok":false,"error":{"name":"TodoBuildRowsError","code":…,"message":…}}`
//! and never panics.
//!
//! # Collation and names
//!
//! Sorting collates context names with the en-US ICU order implemented by
//! `thar_core` (see `docs/rust-port/PLAN.md` §13); the host must not pre-sort.
//! Names the programme supplies stay opaque: this module never normalizes or
//! validates a name it did not parse itself.

use thar_core::{Row, RowError, RowInput, Todo, TodoDate};

use crate::json::{self, Value, push_json_number, push_json_string};
use crate::record::{RecordError, required_string, string_array, todo_records};

/// Name of the one error class this boundary reports.
const ERROR_NAME: &str = "TodoBuildRowsError";

/// Why a `build_rows` request was rejected.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RowsError {
    /// The document is not valid JSON.
    InvalidJson {
        /// Byte offset where the reader stopped.
        offset: usize,
        /// Fixed description of the syntax problem.
        reason: &'static str,
    },
    /// The document is valid JSON but a field has the wrong type or shape.
    InvalidInput {
        /// Request field the problem belongs to.
        field: &'static str,
        /// Fixed description of the rule that was broken.
        reason: &'static str,
    },
    /// `today` is not a strict `YYYY-MM-DD` calendar day.
    InvalidToday,
    /// `searchViews` is not aligned with `todos`.
    ViewCountMismatch {
        /// Number of todos supplied.
        todos: usize,
        /// Number of search views supplied.
        views: usize,
    },
}

impl RowsError {
    /// Stable machine code, in the CP1 style.
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidJson { .. } | Self::InvalidInput { .. } => "INVALID_INPUT",
            Self::InvalidToday => "INVALID_TODAY",
            Self::ViewCountMismatch { .. } => "VIEW_COUNT_MISMATCH",
        }
    }

    /// The error class name (one class, several codes).
    #[must_use]
    pub fn name(&self) -> &'static str {
        ERROR_NAME
    }

    /// Content-free explanation; never quotes the request.
    #[must_use]
    pub fn message(&self) -> String {
        match self {
            Self::InvalidJson { offset, reason } => {
                format!("build_rows input is not valid JSON: {reason} at byte {offset}")
            }
            Self::InvalidInput { field, reason } => {
                format!("build_rows input field `{field}` {reason}")
            }
            Self::InvalidToday => {
                "build_rows today must be a valid YYYY-MM-DD calendar day in years 1..=9999"
                    .to_owned()
            }
            Self::ViewCountMismatch { todos, views } => {
                format!("build_rows searchViews ({views}) must be aligned with todos ({todos})")
            }
        }
    }

    /// A field-shaped rejection.
    fn invalid(field: &'static str, reason: &'static str) -> Self {
        Self::InvalidInput { field, reason }
    }
}

impl From<RecordError> for RowsError {
    fn from(error: RecordError) -> Self {
        Self::InvalidInput {
            field: error.field,
            reason: error.reason,
        }
    }
}

impl From<RowError> for RowsError {
    fn from(error: RowError) -> Self {
        match error {
            RowError::ViewCountMismatch { todos, views } => {
                Self::ViewCountMismatch { todos, views }
            }
        }
    }
}

/// One host-normalized search view in a `build_rows` request.
#[derive(Clone, Debug, PartialEq, Eq)]
struct SearchViewRecord {
    text: String,
    contexts: Vec<String>,
    projects: Vec<String>,
}

impl SearchViewRecord {
    /// Decode one view from a request array element.
    fn from_json(value: &Value) -> Result<Self, RowsError> {
        Ok(Self {
            text: required_string(value, "text", "searchViews.text")?,
            contexts: string_array(value, "contexts", "searchViews.contexts")?,
            projects: string_array(value, "projects", "searchViews.projects")?,
        })
    }
}

/// A decoded request, borrowing nothing from the input document.
#[derive(Clone, Debug)]
struct BuildRequest {
    today: TodoDate,
    show_hidden: bool,
    terms: Vec<String>,
    todos: Vec<Todo>,
    views: Vec<SearchViewRecord>,
}

/// Decode one request document.
fn decode(input: &str) -> Result<BuildRequest, RowsError> {
    let document = json::parse(input).map_err(|error| RowsError::InvalidJson {
        offset: error.offset,
        reason: error.reason,
    })?;

    let today = document
        .get("today")
        .and_then(Value::as_str)
        .ok_or_else(|| RowsError::invalid("today", "must be a YYYY-MM-DD string"))
        .and_then(|text| TodoDate::parse(text).ok_or(RowsError::InvalidToday))?;

    let show_hidden = document
        .get("showHidden")
        .and_then(Value::as_bool)
        .ok_or_else(|| RowsError::invalid("showHidden", "must be a boolean"))?;

    let terms = string_array(&document, "terms", "terms")?;

    let todos = todo_records(&document)?;

    let views = document
        .get("searchViews")
        .and_then(Value::as_array)
        .ok_or_else(|| RowsError::invalid("searchViews", "must be an array of search views"))?
        .iter()
        .map(SearchViewRecord::from_json)
        .collect::<Result<Vec<_>, _>>()?;

    Ok(BuildRequest {
        today,
        show_hidden,
        terms,
        todos,
        views,
    })
}

/// Build the rows for a decoded request.
///
/// Goes through [`RowInput`] so this boundary and any other caller of the core
/// share one entry point (`RowInput::build`); the borrows live for the call.
fn rows_for(request: &BuildRequest) -> Result<thar_core::Rows<'_>, RowsError> {
    let terms: Vec<&str> = request.terms.iter().map(String::as_str).collect();
    let context_refs: Vec<Vec<&str>> = request
        .views
        .iter()
        .map(|view| view.contexts.iter().map(String::as_str).collect())
        .collect();
    let project_refs: Vec<Vec<&str>> = request
        .views
        .iter()
        .map(|view| view.projects.iter().map(String::as_str).collect())
        .collect();

    let views: Vec<thar_core::SearchView<'_>> = request
        .views
        .iter()
        .enumerate()
        .map(|(index, view)| thar_core::SearchView {
            text: &view.text,
            contexts: &context_refs[index],
            projects: &project_refs[index],
        })
        .collect();

    RowInput {
        todos: &request.todos,
        views: &views,
        terms: &terms,
        show_hidden: request.show_hidden,
        today: request.today,
    }
    .build()
    .map_err(RowsError::from)
}

/// Build the response envelope for one request document.
///
/// This is the whole `build_rows` implementation behind the wasm export: it is
/// a plain function so the native tests can exercise it without a JavaScript
/// runtime.
pub(crate) fn build_rows_envelope(input: &str) -> String {
    let mut out = String::with_capacity(input.len().saturating_add(256));

    match decode(input) {
        Ok(request) => match rows_for(&request) {
            Ok(rows) => push_rows(&mut out, &rows),
            Err(error) => push_error(&mut out, &error),
        },
        Err(error) => push_error(&mut out, &error),
    }

    out
}

/// Append the `{"ok":true,…}` envelope.
fn push_rows(out: &mut String, rows: &thar_core::Rows<'_>) {
    // `create_rows` emits exactly one todo row per input index, and
    // `Rows::todo_indexes` is that same order spelled out. Zipping the two is
    // therefore sound; the debug assertion makes a future desync a test
    // failure instead of a silently wrong `index` on the wire.
    debug_assert_eq!(
        rows.todo_indexes().len(),
        rows.rows().iter().filter(|row| row.is_todo()).count(),
        "one todo index per todo row"
    );

    out.push_str("{\"ok\":true,\"rows\":[");
    let mut indexes = rows.todo_indexes().iter();
    let mut first = true;

    for row in rows.rows() {
        if !first {
            out.push(',');
        }
        first = false;

        match row {
            Row::Context { name, todo_count } => {
                out.push_str("{\"type\":\"context\",\"contextName\":");
                push_json_string(out, name);
                out.push_str(",\"todoCount\":");
                push_json_number(out, *todo_count as u64);
                out.push('}');
            }
            Row::Todo { number, .. } => {
                // The invariant asserted above: without an index the host could
                // not map this row back to its todo, so a missing one is a core
                // bug, not wire data. `expect` keeps the failure honest.
                let index = indexes
                    .next()
                    .copied()
                    .expect("one todo index per todo row");
                out.push_str("{\"type\":\"todo\",\"number\":");
                push_json_number(out, *number as u64);
                out.push_str(",\"index\":");
                push_json_number(out, index as u64);
                out.push('}');
            }
        }
    }

    out.push_str("],\"order\":[");
    for (position, index) in rows.todo_indexes().iter().enumerate() {
        if position > 0 {
            out.push(',');
        }
        push_json_number(out, *index as u64);
    }
    out.push_str("]}");
}

/// Append the `{"ok":false,…}` envelope.
fn push_error(out: &mut String, error: &RowsError) {
    out.push_str("{\"ok\":false,\"error\":{\"name\":");
    push_json_string(out, error.name());
    out.push_str(",\"code\":");
    push_json_string(out, error.code());
    out.push_str(",\"message\":");
    push_json_string(out, &error.message());
    out.push_str("}}");
}

#[cfg(test)]
mod tests {
    use super::{RowsError, build_rows_envelope};

    const TODAY: &str = "2026-11-15";

    /// One request with two todos: an open `@home` todo and a plain one.
    fn request(todos: &str, views: &str, terms: &str, show_hidden: bool) -> String {
        format!(
            "{{\"today\":\"{TODAY}\",\"showHidden\":{show_hidden},\"terms\":{terms},\
             \"todos\":{todos},\"searchViews\":{views}}}"
        )
    }

    fn record(text: &str, contexts: &str, extra: &str) -> String {
        format!(
            "{{\"text\":\"{text}\",\"state\":\"todo\",\"priority\":null,\
             \"completionDate\":null,\"creationDate\":null,\
             \"projects\":[],\"contexts\":{contexts},\"tags\":[]\
             {extra}}}"
        )
    }

    #[test]
    fn emits_the_documented_row_shape() {
        let todos = format!(
            "[{},{}]",
            record("one @home", "[\"home\"]", ""),
            record("two", "[]", "")
        );
        let views = "[{\"text\":\"one @home\",\"contexts\":[\"home\"],\"projects\":[]},\
                     {\"text\":\"two\",\"contexts\":[],\"projects\":[]}]";
        let json = build_rows_envelope(&request(&todos, views, "[]", false));

        assert_eq!(
            json,
            "{\"ok\":true,\"rows\":[\
             {\"type\":\"context\",\"contextName\":\"None\",\"todoCount\":1},\
             {\"type\":\"todo\",\"number\":1,\"index\":1},\
             {\"type\":\"context\",\"contextName\":\"home\",\"todoCount\":1},\
             {\"type\":\"todo\",\"number\":2,\"index\":0}],\
             \"order\":[1,0]}"
        );
    }

    #[test]
    fn applies_hidden_and_search_rules() {
        let todos = format!(
            "[{},{}]",
            record("drop me", "[]", ",\"datesInText\":false"),
            record("keep me", "[]", "")
        );
        let views = "[{\"text\":\"drop me\",\"contexts\":[],\"projects\":[]},\
                     {\"text\":\"keep me\",\"contexts\":[],\"projects\":[]}]";

        let filtered = build_rows_envelope(&request(&todos, views, "[\"keep\"]", false));
        let value: serde_json::Value = serde_json::from_str(&filtered).expect("valid JSON");
        assert_eq!(value["order"], serde_json::json!([1]));

        let all = build_rows_envelope(&request(&todos, views, "[]", false));
        let value: serde_json::Value = serde_json::from_str(&all).expect("valid JSON");
        assert_eq!(value["order"], serde_json::json!([0, 1]));
    }

    #[test]
    fn rebuilds_tags_and_flags_without_reparsing() {
        // `text` must stay exactly as sent (no tag stripping), and a duplicate
        // key must stay one array-valued tag: re-parsing the serialized line
        // would collapse these.
        let todos = "[{\"text\":\"ship it\",\"state\":\"done\",\"priority\":\"A\",\
                      \"completionDate\":\"2024-03-02\",\"creationDate\":\"2024-03-01\",\
                      \"projects\":[\"thar\"],\"contexts\":[\"work\"],\
                      \"tags\":[[\"beta\",[\"one\",\"two\"]],[\"h\",\"1\"]],\
                      \"datesInText\":false,\"completionDateInText\":false}]";
        let views = "[{\"text\":\"ship it\",\"contexts\":[\"work\"],\"projects\":[\"thar\"]}]";
        // `h:1` hides the todo, so hiding it proves the tag array was rebuilt.
        let hidden = build_rows_envelope(&request(todos, views, "[]", false));
        let value: serde_json::Value = serde_json::from_str(&hidden).expect("valid JSON");
        assert_eq!(value["rows"], serde_json::json!([]));

        let shown = build_rows_envelope(&request(todos, views, "[]", true));
        let value: serde_json::Value = serde_json::from_str(&shown).expect("valid JSON");
        assert_eq!(
            value["rows"],
            serde_json::json!([
                {"type": "context", "contextName": "work", "todoCount": 1},
                {"type": "todo", "number": 1, "index": 0},
            ])
        );
    }

    #[test]
    fn ignores_unknown_record_fields() {
        let todos = format!(
            "[{}]",
            record(
                "one",
                "[]",
                ",\"isDone\":false,\"hash\":\"one\",\"isOverdue\":true"
            )
        );
        let views = "[{\"text\":\"one\",\"contexts\":[],\"projects\":[]}]";
        let json = build_rows_envelope(&request(&todos, views, "[]", false));
        assert!(json.starts_with("{\"ok\":true"), "{json}");
    }

    #[test]
    fn rejects_every_bad_field_without_panicking() {
        let views = "[{\"text\":\"one\",\"contexts\":[],\"projects\":[]}]";
        let good = format!("[{}]", record("one", "[]", ""));

        let cases = [
            ("not json", "not json".to_owned()),
            (
                "missing showHidden",
                format!(
                    "{{\"today\":\"{TODAY}\",\"terms\":[],\"todos\":{good},\"searchViews\":{views}}}"
                ),
            ),
            (
                "bad today",
                format!(
                    "{{\"today\":\"2026-02-30\",\"showHidden\":false,\"terms\":[],\
                     \"todos\":{good},\"searchViews\":{views}}}"
                ),
            ),
            ("bad terms", request(&good, views, "[\"a\",1]", false)),
            (
                "missing todos",
                format!(
                    "{{\"today\":\"{TODAY}\",\"showHidden\":false,\"terms\":[],\"searchViews\":{views}}}"
                ),
            ),
            ("misaligned views", request(&good, "[]", "[]", false)),
            (
                "bad state",
                request(
                    "[{\"text\":\"one\",\"state\":\"done!\",\"priority\":null,\
                      \"completionDate\":null,\"creationDate\":null,\
                      \"projects\":[],\"contexts\":[],\"tags\":[]}]",
                    views,
                    "[]",
                    false,
                ),
            ),
            (
                "bad priority",
                request(
                    "[{\"text\":\"one\",\"state\":\"todo\",\"priority\":\"AA\",\
                      \"completionDate\":null,\"creationDate\":null,\
                      \"projects\":[],\"contexts\":[],\"tags\":[]}]",
                    views,
                    "[]",
                    false,
                ),
            ),
            (
                "bad date",
                request(
                    "[{\"text\":\"one\",\"state\":\"todo\",\"priority\":null,\
                      \"completionDate\":\"2024-02-30\",\"creationDate\":null,\
                      \"projects\":[],\"contexts\":[],\"tags\":[]}]",
                    views,
                    "[]",
                    false,
                ),
            ),
            (
                "bad contexts",
                request(
                    "[{\"text\":\"one\",\"state\":\"todo\",\"priority\":null,\
                      \"completionDate\":null,\"creationDate\":null,\
                      \"projects\":[],\"contexts\":\"home\",\"tags\":[]}]",
                    views,
                    "[]",
                    false,
                ),
            ),
            (
                "bad tags",
                request(
                    "[{\"text\":\"one\",\"state\":\"todo\",\"priority\":null,\
                      \"completionDate\":null,\"creationDate\":null,\
                      \"projects\":[],\"contexts\":[],\"tags\":[[\"k\"]]}]",
                    views,
                    "[]",
                    false,
                ),
            ),
            (
                "empty tag array",
                request(
                    "[{\"text\":\"one\",\"state\":\"todo\",\"priority\":null,\
                      \"completionDate\":null,\"creationDate\":null,\
                      \"projects\":[],\"contexts\":[],\"tags\":[[\"k\",[]]]}]",
                    views,
                    "[]",
                    false,
                ),
            ),
            (
                "bad flags",
                request(
                    "[{\"text\":\"one\",\"state\":\"todo\",\"priority\":null,\
                      \"completionDate\":null,\"creationDate\":null,\
                      \"projects\":[],\"contexts\":[],\"tags\":[],\"datesInText\":1}]",
                    views,
                    "[]",
                    false,
                ),
            ),
        ];

        for (label, input) in cases {
            let json = build_rows_envelope(&input);
            let value: serde_json::Value = serde_json::from_str(&json).expect("valid JSON");
            assert_eq!(value["ok"], false, "{label}: {json}");
            assert_eq!(
                value["error"]["name"], "TodoBuildRowsError",
                "{label}: {json}"
            );
            assert!(
                value["error"]["message"]
                    .as_str()
                    .is_some_and(|m| !m.is_empty()),
                "{label}: {json}"
            );
        }
    }

    #[test]
    fn maps_the_error_codes() {
        let todos = format!("[{}]", record("one", "[]", ""));
        let views = "[{\"text\":\"one\",\"contexts\":[],\"projects\":[]}]";

        let misaligned = build_rows_envelope(&request(&todos, "[]", "[]", false));
        let value: serde_json::Value = serde_json::from_str(&misaligned).expect("valid JSON");
        assert_eq!(value["error"]["code"], "VIEW_COUNT_MISMATCH");

        let bad_today = build_rows_envelope(&format!(
            "{{\"today\":\"0000-01-01\",\"showHidden\":false,\"terms\":[],\
             \"todos\":{todos},\"searchViews\":{views}}}"
        ));
        let value: serde_json::Value = serde_json::from_str(&bad_today).expect("valid JSON");
        assert_eq!(value["error"]["code"], "INVALID_TODAY");

        let invalid = build_rows_envelope("\"not an object\"");
        let value: serde_json::Value = serde_json::from_str(&invalid).expect("valid JSON");
        assert_eq!(value["error"]["code"], "INVALID_INPUT");
        assert_eq!(
            RowsError::ViewCountMismatch { todos: 1, views: 0 }.code(),
            "VIEW_COUNT_MISMATCH"
        );
    }

    #[test]
    fn an_empty_list_still_returns_the_order_and_no_rows() {
        let json = build_rows_envelope(&request("[]", "[]", "[]", false));
        assert_eq!(json, "{\"ok\":true,\"rows\":[],\"order\":[]}");
    }
}
