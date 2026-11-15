//! Exact-parity tests against the CP0 corpus in `testdata/port/`.
//!
//! The TypeScript implementation produced `expected.json`; these tests never
//! regenerate it. Every fixture asserts the raw byte length, the parse outcome,
//! every parsed field, the serialized SHA-256 and byte length, and the
//! re-serialized bytes. Clock-dependent accessors use the corpus `clockLocal`
//! day (`2026-11-15`) as an explicit `today` argument.

use std::collections::BTreeSet;
use std::fmt::Write as _;
use std::fs;
use std::path::PathBuf;

use serde::Deserialize;
use sha2::{Digest, Sha256};
use thar_core::{
    CoreError, ReadLimits, State, TagValue, Todo, TodoDate, TodoId, parse_file, serialize_file,
};

/// `CARGO_MANIFEST_DIR/../../testdata/port`.
fn corpus_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../testdata/port")
}

/// The corpus clock day: local `2026-11-15T12:00:00` in `expected.json`.
fn today() -> TodoDate {
    TodoDate::parse("2026-11-15").expect("the corpus clock day is valid")
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExpectedCorpus {
    clock_local: String,
    read_limits: LimitsRecord,
    files: std::collections::BTreeMap<String, FileExpectation>,
}

impl ExpectedCorpus {
    fn limits(&self) -> ReadLimits {
        ReadLimits {
            max_file_bytes: self.read_limits.max_file_bytes,
            max_read_todos: self.read_limits.max_read_todos,
            max_line_chars: self.read_limits.max_line_chars,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LimitsRecord {
    max_file_bytes: u64,
    max_read_todos: usize,
    max_line_chars: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileExpectation {
    raw_bytes: u64,
    kind: String,
    todo_count: Option<usize>,
    serialized: Option<SerializedRecord>,
    todos: Option<Vec<TodoRecord>>,
    samples: Option<Vec<SampleRecord>>,
    error: Option<ErrorRecord>,
}

#[derive(Debug, Deserialize)]
struct SerializedRecord {
    sha256: String,
    bytes: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TodoRecord {
    text: String,
    state: String,
    priority: Option<String>,
    completion_date: Option<String>,
    creation_date: Option<String>,
    projects: Vec<String>,
    contexts: Vec<String>,
    tags: Vec<(String, TagValueRecord)>,
    is_done: bool,
    is_hidden: bool,
    is_visible_in_overview: bool,
    is_overdue: bool,
    #[serde(rename = "toString")]
    to_string: String,
    hash: String,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum TagValueRecord {
    One(String),
    Many(Vec<String>),
}

#[derive(Debug, Deserialize)]
struct SampleRecord {
    index: usize,
    todo: TodoRecord,
}

/// Numeric fields are flattened so every TS error class fits one record.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ErrorRecord {
    name: String,
    message: String,
    code: String,
    line_number: Option<usize>,
    code_point: Option<u32>,
    actual_bytes: Option<u64>,
    max_bytes: Option<u64>,
    line_count: Option<usize>,
    max_read_todos: Option<usize>,
    length: Option<usize>,
    max_line_chars: Option<usize>,
}

fn load_expected() -> ExpectedCorpus {
    let path = corpus_dir().join("expected.json");
    let json = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    serde_json::from_str(&json).unwrap_or_else(|error| panic!("parse {}: {error}", path.display()))
}

fn sha256_hex(data: &str) -> String {
    let digest = Sha256::digest(data.as_bytes());
    let mut hex = String::with_capacity(64);
    for byte in digest.iter() {
        write!(&mut hex, "{byte:02x}").expect("writing to a String cannot fail");
    }
    hex
}

fn check_fixture(file: &str) {
    let corpus = load_expected();
    let expected = corpus
        .files
        .get(file)
        .unwrap_or_else(|| panic!("{file} is missing from expected.json"));

    let path = corpus_dir().join(file);
    let bytes = fs::read(&path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    assert_eq!(bytes.len() as u64, expected.raw_bytes, "{file}: rawBytes");
    let data = std::str::from_utf8(&bytes)
        .unwrap_or_else(|error| panic!("{file} is not valid UTF-8: {error}"));

    match parse_file(data, &corpus.limits()) {
        Ok(todos) => {
            assert_eq!(expected.kind, "todos", "{file}: kind");

            let todo_count = expected
                .todo_count
                .unwrap_or_else(|| panic!("{file}: todoCount is missing"));
            assert_eq!(todos.len(), todo_count, "{file}: todoCount");

            for (index, todo) in todos.iter().enumerate() {
                assert_eq!(todo.id, TodoId(index as u64), "{file}: id at {index}");
            }

            if let Some(records) = &expected.todos {
                assert_eq!(records.len(), todos.len(), "{file}: todos length");
                for (index, (todo, record)) in todos.iter().zip(records).enumerate() {
                    assert_todo(todo, record, today(), &format!("{file}[{index}]"));
                }
            }

            if let Some(samples) = &expected.samples {
                assert!(!samples.is_empty(), "{file}: samples are empty");
                for sample in samples {
                    let todo = todos.get(sample.index).unwrap_or_else(|| {
                        panic!("{file}: sample {} is out of range", sample.index)
                    });
                    assert_eq!(todo.id, TodoId(sample.index as u64), "{file}: sample id");
                    assert_todo(
                        todo,
                        &sample.todo,
                        today(),
                        &format!("{file}[{}]", sample.index),
                    );
                }
            }

            let serialized = expected
                .serialized
                .as_ref()
                .unwrap_or_else(|| panic!("{file}: serialized is missing"));
            let output = serialize_file(&todos);
            assert_eq!(
                output.len() as u64,
                serialized.bytes,
                "{file}: serialized byte length"
            );
            assert_eq!(
                sha256_hex(&output),
                serialized.sha256,
                "{file}: serialized sha256"
            );
        }
        Err(error) => {
            assert_eq!(expected.kind, "error", "{file}: kind");
            let record = expected
                .error
                .as_ref()
                .unwrap_or_else(|| panic!("{file}: error record is missing"));
            assert_error(&error, record, file);
        }
    }
}

fn assert_todo(actual: &Todo, expected: &TodoRecord, today: TodoDate, context: &str) {
    assert_eq!(actual.text, expected.text, "{context}: text");
    assert_eq!(
        match actual.state {
            State::Todo => "todo",
            State::Done => "done",
        },
        expected.state,
        "{context}: state"
    );
    assert_eq!(
        actual
            .priority
            .map(|priority| priority.as_char().to_string()),
        expected.priority,
        "{context}: priority"
    );
    assert_eq!(
        actual.completion_date.map(|date| date.to_string()),
        expected.completion_date,
        "{context}: completionDate"
    );
    assert_eq!(
        actual.creation_date.map(|date| date.to_string()),
        expected.creation_date,
        "{context}: creationDate"
    );
    assert_eq!(actual.projects, expected.projects, "{context}: projects");
    assert_eq!(actual.contexts, expected.contexts, "{context}: contexts");

    assert_eq!(
        actual.tags.len(),
        expected.tags.len(),
        "{context}: tag count"
    );
    for (index, ((key, value), (expected_key, expected_value))) in
        actual.tags.iter().zip(&expected.tags).enumerate()
    {
        assert_eq!(key, expected_key, "{context}: tag {index} key");
        match (value, expected_value) {
            (TagValue::One(value), TagValueRecord::One(expected_value)) => {
                assert_eq!(value, expected_value, "{context}: tag {index} value");
            }
            (TagValue::Many(values), TagValueRecord::Many(expected_values)) => {
                assert_eq!(values, expected_values, "{context}: tag {index} values");
            }
            (value, expected_value) => {
                panic!("{context}: tag {index} shape mismatch: {value:?} vs {expected_value:?}")
            }
        }
    }

    assert_eq!(actual.is_done(), expected.is_done, "{context}: isDone");
    assert_eq!(
        actual.is_hidden(),
        expected.is_hidden,
        "{context}: isHidden"
    );
    assert_eq!(
        actual.is_overdue(today),
        expected.is_overdue,
        "{context}: isOverdue"
    );
    assert_eq!(
        actual.is_visible_in_overview(today),
        expected.is_visible_in_overview,
        "{context}: isVisibleInOverview"
    );
    assert_eq!(
        actual.serialize(),
        expected.to_string,
        "{context}: toString"
    );
    assert_eq!(actual.hash(), expected.hash, "{context}: hash");
}

fn assert_error(actual: &CoreError, expected: &ErrorRecord, file: &str) {
    assert_eq!(actual.name(), expected.name, "{file}: error name");
    assert_eq!(actual.code(), expected.code, "{file}: error code");
    assert_eq!(
        actual.to_string(),
        expected.message,
        "{file}: error message"
    );

    match actual {
        CoreError::FileTooLarge {
            actual_bytes,
            max_bytes,
        } => {
            assert_eq!(
                expected.actual_bytes,
                Some(*actual_bytes),
                "{file}: actualBytes"
            );
            assert_eq!(expected.max_bytes, Some(*max_bytes), "{file}: maxBytes");
            assert_eq!(expected.line_number, None, "{file}: lineNumber");
            assert_eq!(expected.code_point, None, "{file}: codePoint");
            assert_eq!(expected.line_count, None, "{file}: lineCount");
            assert_eq!(expected.max_read_todos, None, "{file}: maxReadTodos");
            assert_eq!(expected.length, None, "{file}: length");
            assert_eq!(expected.max_line_chars, None, "{file}: maxLineChars");
        }
        CoreError::TooManyLines {
            line_count,
            max_read_todos,
        } => {
            assert_eq!(expected.line_count, Some(*line_count), "{file}: lineCount");
            assert_eq!(
                expected.max_read_todos,
                Some(*max_read_todos),
                "{file}: maxReadTodos"
            );
            assert_eq!(expected.actual_bytes, None, "{file}: actualBytes");
            assert_eq!(expected.max_bytes, None, "{file}: maxBytes");
            assert_eq!(expected.line_number, None, "{file}: lineNumber");
            assert_eq!(expected.code_point, None, "{file}: codePoint");
            assert_eq!(expected.length, None, "{file}: length");
            assert_eq!(expected.max_line_chars, None, "{file}: maxLineChars");
        }
        CoreError::LineTooLong {
            line_number,
            length,
            max_line_chars,
        } => {
            assert_eq!(
                expected.line_number,
                Some(*line_number),
                "{file}: lineNumber"
            );
            assert_eq!(expected.length, Some(*length), "{file}: length");
            assert_eq!(
                expected.max_line_chars,
                Some(*max_line_chars),
                "{file}: maxLineChars"
            );
            assert_eq!(expected.actual_bytes, None, "{file}: actualBytes");
            assert_eq!(expected.max_bytes, None, "{file}: maxBytes");
            assert_eq!(expected.line_count, None, "{file}: lineCount");
            assert_eq!(expected.max_read_todos, None, "{file}: maxReadTodos");
            assert_eq!(expected.code_point, None, "{file}: codePoint");
        }
        CoreError::ControlCharacter {
            line_number,
            code_point,
        } => {
            assert_eq!(
                expected.line_number,
                Some(*line_number),
                "{file}: lineNumber"
            );
            assert_eq!(expected.code_point, Some(*code_point), "{file}: codePoint");
            assert_eq!(expected.actual_bytes, None, "{file}: actualBytes");
            assert_eq!(expected.max_bytes, None, "{file}: maxBytes");
            assert_eq!(expected.line_count, None, "{file}: lineCount");
            assert_eq!(expected.max_read_todos, None, "{file}: maxReadTodos");
            assert_eq!(expected.length, None, "{file}: length");
            assert_eq!(expected.max_line_chars, None, "{file}: maxLineChars");
        }
    }
}

/// Generate one test per fixture and record the covered names once.
macro_rules! corpus_file_tests {
    ($($test_name:ident => $file:literal),+ $(,)?) => {
        /// Fixture names covered by the generated parity tests.
        const FIXTURES: &[&str] = &[$($file),+];

        $(
            #[test]
            fn $test_name() {
                check_fixture($file);
            }
        )+
    };
}

corpus_file_tests! {
    bare_cr_eof => "bare-cr-eof.txt",
    bare_cr_inside => "bare-cr-inside.txt",
    blank_lines => "blank-lines.txt",
    control_bel => "control-bel.txt",
    control_c1 => "control-c1.txt",
    control_del => "control-del.txt",
    control_esc => "control-esc.txt",
    control_nul => "control-nul.txt",
    control_u2028 => "control-u2028.txt",
    crlf => "crlf.txt",
    due_threshold_hidden => "due-threshold-hidden.txt",
    empty => "empty.txt",
    large_10000 => "large-10000.txt",
    leading_dates_done_invalid => "leading-dates-done-invalid.txt",
    leading_dates_done => "leading-dates-done.txt",
    leading_dates_open => "leading-dates-open.txt",
    long_line_8192 => "long-line-8192.txt",
    no_trailing_newline => "no-trailing-newline.txt",
    priorities => "priorities.txt",
    projects_contexts => "projects-contexts.txt",
    real_world_lf => "real-world-lf.txt",
    recurrence => "recurrence.txt",
    tabs => "tabs.txt",
    tags => "tags.txt",
    unicode => "unicode.txt",
}

#[test]
fn every_corpus_fixture_has_a_test() {
    let corpus = load_expected();
    let expected: BTreeSet<&str> = corpus.files.keys().map(String::as_str).collect();
    let covered: BTreeSet<&str> = FIXTURES.iter().copied().collect();

    assert_eq!(
        covered.len(),
        FIXTURES.len(),
        "a fixture is listed twice in corpus_file_tests!"
    );
    assert_eq!(
        covered, expected,
        "corpus_file_tests! must cover every fixture in expected.json"
    );
}

#[test]
fn clock_and_limits_match_the_typescript_corpus() {
    let corpus = load_expected();
    assert_eq!(corpus.clock_local, "2026-11-15T12:00:00");
    assert_eq!(TodoDate::parse(&corpus.clock_local[..10]), Some(today()));
    assert_eq!(corpus.limits(), ReadLimits::DEFAULT);
}
