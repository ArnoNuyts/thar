//! The structured todo DTO shared by `build_rows` and `serialize_file`.
//!
//! Both requests carry the same record shape: the parsed fields of one todo,
//! never its serialized line. Re-serializing a line would be lossy (a duplicate
//! tag key collapses into a comma list, and the two round-trip flags are not in
//! the text), so the host hands the fields back and this module rebuilds a
//! [`Todo`] through [`Todo::from_parts`].
//!
//! ```json
//! {
//!   "text": "ship it @work",
//!   "state": "todo",
//!   "priority": null,
//!   "completionDate": null,
//!   "creationDate": null,
//!   "projects": [],
//!   "contexts": ["work"],
//!   "tags": [["due", "2024-01-01"]],
//!   "datesInText": false,
//!   "completionDateInText": false
//! }
//! ```
//!
//! - `datesInText`/`completionDateInText` are optional and default to `false`.
//!   They do not affect row building, only serialization: a caller that parsed
//!   the line itself passes its real flags so `serialize_file` can rebuild an
//!   exact todo.
//! - Unknown fields are ignored, so a host can pass a CP1 parse record with its
//!   extra `isDone`/`toString`/`hash` fields without a second projection.
//! - Missing required fields are rejected with [`RecordError`]; nothing here can
//!   panic on a bad field. A tag value must be a string or a **non-empty**
//!   string array: the parser never produces `[]`, and `k:` with an empty value
//!   is not representable through this DTO.
//!
//! Each envelope owns its own error class and message prefix, so this module
//! reports only the field that failed and the fixed reason.

use thar_core::{Priority, State, TagValue, Todo, TodoDate, TodoId, TodoParts};

use crate::json::Value;

/// Why one todo record could not be decoded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct RecordError {
    /// Request field the problem belongs to (for example `todos.tags`).
    pub(crate) field: &'static str,
    /// Fixed description of the rule that was broken.
    pub(crate) reason: &'static str,
}

impl RecordError {
    /// A field-shaped rejection.
    const fn new(field: &'static str, reason: &'static str) -> Self {
        Self { field, reason }
    }
}

/// One todo in a structured request.
///
/// The JSON form is documented at the top of this module. `TodoRecord` exists
/// so untrusted wire data is validated exactly once, before it becomes a typed
/// [`TodoParts`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct TodoRecord {
    parts: TodoParts,
}

impl TodoRecord {
    /// Decode one record from a request array element.
    fn from_json(value: &Value) -> Result<Self, RecordError> {
        let state = match value
            .get("state")
            .and_then(Value::as_str)
            .ok_or_else(|| RecordError::new("state", "must be \"todo\" or \"done\""))?
        {
            "todo" => State::Todo,
            "done" => State::Done,
            _ => {
                return Err(RecordError::new("state", "must be \"todo\" or \"done\""));
            }
        };

        let priority = match value.get("priority") {
            None | Some(Value::Null) => None,
            Some(Value::String(letter)) => {
                let mut characters = letter.chars();
                let priority = match (characters.next(), characters.next()) {
                    (Some(letter), None) => Priority::new(letter),
                    _ => None,
                };
                Some(
                    priority
                        .ok_or_else(|| RecordError::new("priority", "must be an A..Z letter"))?,
                )
            }
            Some(_) => {
                return Err(RecordError::new("priority", "must be a string or null"));
            }
        };

        Ok(Self {
            parts: TodoParts {
                text: required_string(value, "text", "todos.text")?,
                state,
                priority,
                completion_date: optional_date(value, "completionDate", "todos.completionDate")?,
                creation_date: optional_date(value, "creationDate", "todos.creationDate")?,
                projects: string_array(value, "projects", "todos.projects")?,
                contexts: string_array(value, "contexts", "todos.contexts")?,
                tags: tag_pairs(value)?,
                dates_in_text: optional_bool(value, "datesInText", "todos.datesInText")?,
                completion_date_in_text: optional_bool(
                    value,
                    "completionDateInText",
                    "todos.completionDateInText",
                )?,
            },
        })
    }

    /// The core todo, with the id the caller assigns.
    fn into_todo(self, id: TodoId) -> Todo {
        Todo::from_parts(id, self.parts)
    }
}

/// Decode the `todos` array of a structured request, in document order.
///
/// Ids are the array positions, matching parse order; the responses carry the
/// index of every row/todo so the host maps back to its own objects.
pub(crate) fn todo_records(document: &Value) -> Result<Vec<Todo>, RecordError> {
    let records = document
        .get("todos")
        .and_then(Value::as_array)
        .ok_or_else(|| RecordError::new("todos", "must be an array of todo records"))?;

    let mut todos = Vec::with_capacity(records.len());
    for (index, record) in records.iter().enumerate() {
        // `TodoId` is the load-order index; `usize as u64` is exact on wasm32
        // and within JavaScript's safe-integer range for the read limit.
        todos.push(TodoRecord::from_json(record)?.into_todo(TodoId::new(index as u64)));
    }
    Ok(todos)
}

/// A required string field.
///
/// `key` is the JSON key, `label` the path shown in the error (the same string
/// at the top level, `searchViews.text` inside a view, and so on).
pub(crate) fn required_string(
    value: &Value,
    key: &str,
    label: &'static str,
) -> Result<String, RecordError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or(RecordError::new(label, "must be a string"))
}

/// An optional boolean field, defaulting to `false`.
fn optional_bool(value: &Value, key: &str, label: &'static str) -> Result<bool, RecordError> {
    match value.get(key) {
        None => Ok(false),
        Some(Value::Bool(flag)) => Ok(*flag),
        Some(_) => Err(RecordError::new(label, "must be a boolean")),
    }
}

/// An optional date field.
fn optional_date(
    value: &Value,
    key: &str,
    label: &'static str,
) -> Result<Option<TodoDate>, RecordError> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => text
            .parse::<TodoDate>()
            .map(Some)
            .map_err(|_| RecordError::new(label, "must be a YYYY-MM-DD calendar day")),
        Some(_) => Err(RecordError::new(
            label,
            "must be a YYYY-MM-DD string or null",
        )),
    }
}

/// A required string-array field.
pub(crate) fn string_array(
    value: &Value,
    key: &str,
    label: &'static str,
) -> Result<Vec<String>, RecordError> {
    let values = value
        .get(key)
        .and_then(Value::as_array)
        .ok_or(RecordError::new(label, "must be an array of strings"))?;

    values
        .iter()
        .map(|item| {
            item.as_str()
                .map(str::to_owned)
                .ok_or(RecordError::new(label, "must be an array of strings"))
        })
        .collect()
}

/// The `tags` field: an ordered `[key, value]` pair list.
fn tag_pairs(value: &Value) -> Result<Vec<(String, TagValue)>, RecordError> {
    let pairs = value
        .get("tags")
        .and_then(Value::as_array)
        .ok_or(RecordError::new(
            "tags",
            "must be an array of [key, value] pairs",
        ))?;

    pairs
        .iter()
        .map(|pair| {
            let fields =
                pair.as_array()
                    .filter(|fields| fields.len() == 2)
                    .ok_or(RecordError::new(
                        "tags",
                        "must be an array of [key, value] pairs",
                    ))?;
            let key = fields[0]
                .as_str()
                .ok_or(RecordError::new("tags", "tag keys must be strings"))?
                .to_owned();

            let tag_value = match &fields[1] {
                Value::String(single) => TagValue::One(single.clone()),
                Value::Array(values) if values.len() == 1 => {
                    let single = values[0]
                        .as_str()
                        .ok_or(RecordError::new("tags", "tag values must be strings"))?;
                    TagValue::One(single.to_owned())
                }
                Value::Array(values) if values.len() > 1 => {
                    let mut collected = Vec::with_capacity(values.len());
                    for item in values {
                        collected.push(
                            item.as_str()
                                .ok_or(RecordError::new("tags", "tag values must be strings"))?
                                .to_owned(),
                        );
                    }
                    TagValue::Many(collected)
                }
                _ => {
                    return Err(RecordError::new(
                        "tags",
                        "tag values must be a string or a non-empty string array",
                    ));
                }
            };

            Ok((key, tag_value))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{RecordError, todo_records};
    use crate::json;

    const TAG_ERROR: RecordError = RecordError::new("tags", "tag keys must be strings");

    fn decode(todos: &str) -> Result<Vec<thar_core::Todo>, RecordError> {
        let document = json::parse(&format!("{{\"todos\":{todos}}}")).expect("valid JSON");
        todo_records(&document)
    }

    #[test]
    fn rebuilds_tags_flags_and_dates_without_reparsing() {
        let todos = decode(
            "[{\"text\":\"ship it\",\"state\":\"done\",\"priority\":\"A\",\
              \"completionDate\":\"2024-03-02\",\"creationDate\":null,\
              \"projects\":[],\"contexts\":[\"work\"],\
              \"tags\":[[\"beta\",[\"one\",\"two\"]]],\"datesInText\":true,\
              \"completionDateInText\":true}]",
        )
        .expect("a valid record");

        assert_eq!(todos.len(), 1);
        assert_eq!(todos[0].to_string(), "x (A) ship it beta:one,two");
        assert!(todos[0].dates_in_text);
        assert!(todos[0].completion_date_in_text);
    }

    #[test]
    fn rejects_bad_fields_with_the_record_error() {
        assert_eq!(
            decode("[{\"text\":1,\"state\":\"todo\"}]"),
            Err(RecordError::new("todos.text", "must be a string"))
        );
        assert_eq!(
            decode(
                "[{\"text\":\"one\",\"state\":\"todo\",\"priority\":null,\
                      \"completionDate\":null,\"creationDate\":null,\
                      \"projects\":[],\"contexts\":[],\"tags\":[[1,\"x\"]]}]"
            ),
            Err(TAG_ERROR)
        );
    }
}
