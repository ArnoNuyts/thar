//! Exact-parity tests against the CP0 corpus in `testdata/port/`.
//!
//! The TypeScript implementation produced `expected.json`; these tests never
//! regenerate it. Every fixture asserts the raw byte length, the parse outcome,
//! every parsed field, the serialized SHA-256 and byte length, and the
//! re-serialized bytes. Clock-dependent accessors use the corpus `clockLocal`
//! day (`2026-11-15`) as an explicit `today` argument.
//!
//! Fixture bytes are decoded with [`String::from_utf8_lossy`], matching the
//! Node reader: `invalid-utf8.txt` must reach the core as `U+FFFD`, not as a
//! hard error. Reading it with `fs::read_to_string` would fail before parity is
//! even exercised.

use std::collections::BTreeSet;
use std::fmt::Write as _;
use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;

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
#[allow(
    clippy::struct_field_names,
    reason = "the fields mirror the camelCase JSON keys"
)]
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
#[allow(
    clippy::struct_excessive_bools,
    reason = "the booleans mirror the TypeScript accessors one-for-one"
)]
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

fn load_expected() -> &'static ExpectedCorpus {
    static EXPECTED: OnceLock<ExpectedCorpus> = OnceLock::new();

    EXPECTED.get_or_init(|| {
        let path = corpus_dir().join("expected.json");
        let json = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
        serde_json::from_str(&json)
            .unwrap_or_else(|error| panic!("parse {}: {error}", path.display()))
    })
}

/// Read a fixture the way the Node reader does: bytes decoded lossily.
fn read_fixture(file: &str) -> (Vec<u8>, String) {
    let path = corpus_dir().join(file);
    let bytes = fs::read(&path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    let data = String::from_utf8_lossy(&bytes).into_owned();
    (bytes, data)
}

fn sha256_hex(data: &str) -> String {
    let digest = Sha256::digest(data.as_bytes());
    let mut hex = String::with_capacity(64);
    for byte in &digest {
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

    let (bytes, data) = read_fixture(file);
    assert_eq!(bytes.len() as u64, expected.raw_bytes, "{file}: rawBytes");

    match parse_file(&data, &corpus.limits()) {
        Ok(todos) => {
            assert_eq!(expected.kind, "todos", "{file}: kind");

            let todo_count = expected
                .todo_count
                .unwrap_or_else(|| panic!("{file}: todoCount is missing"));
            assert_eq!(todos.len(), todo_count, "{file}: todoCount");

            for (index, todo) in todos.iter().enumerate() {
                assert_eq!(todo.id, TodoId::new(index as u64), "{file}: id at {index}");
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
                    assert_eq!(
                        todo.id,
                        TodoId::new(sample.index as u64),
                        "{file}: sample id"
                    );
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
    bom => "bom.txt",
    control_bel => "control-bel.txt",
    control_c1 => "control-c1.txt",
    control_del => "control-del.txt",
    control_esc => "control-esc.txt",
    control_nul => "control-nul.txt",
    control_u2028 => "control-u2028.txt",
    crlf => "crlf.txt",
    due_threshold_hidden => "due-threshold-hidden.txt",
    empty => "empty.txt",
    invalid_utf8 => "invalid-utf8.txt",
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
    sort_order => "sort-order.txt",
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

/// Every `*.txt` fixture on disk must be pinned in `expected.json`.
///
/// `corpus_file_tests!` covers the other direction (every expectation has a
/// test); this scan mirrors `round_trip.rs` so a newly added fixture cannot be
/// skipped by forgetting to regenerate the expectations.
#[test]
fn every_txt_fixture_is_in_expected_json() {
    let corpus = load_expected();
    let mut on_disk = BTreeSet::new();

    for entry in fs::read_dir(corpus_dir()).expect("read testdata/port") {
        let path = entry.expect("directory entry").path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("txt") {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_else(|| panic!("{} is not a UTF-8 file name", path.display()));
        on_disk.insert(name.to_owned());
    }

    let expected: BTreeSet<String> = corpus.files.keys().cloned().collect();
    assert_eq!(
        on_disk, expected,
        "every *.txt fixture needs an entry in expected.json"
    );
}

/// Todos with a `t:` threshold tag, pinned at the corpus clock day.
///
/// `expected.json` does not carry `isPassedThreshold` (the corpus generator only
/// records `isOverdue`/`isHidden`/`isVisibleInOverview`); CP1/CP2b should add it
/// to `unit-tests/port-corpus.test.ts` so the corpus owns the field. Until then
/// this table derives the expectation from the committed tag records and pins
/// the value for every threshold todo the corpus exposes.
///
/// Each entry is `(fixture, todo index, the raw t: value, isPassedThreshold)`.
const THRESHOLD_CASES: &[(&str, usize, &str, bool)] = &[
    ("due-threshold-hidden.txt", 11, "2026-11-20", false),
    ("due-threshold-hidden.txt", 12, "2026-11-15", true),
    ("due-threshold-hidden.txt", 13, "2020-01-01", true),
    ("due-threshold-hidden.txt", 14, "2027-02-29", true),
    ("due-threshold-hidden.txt", 16, "2026-11-20", false),
    ("large-10000.txt", 6, "2024-06-01", true),
    ("large-10000.txt", 8, "2024-01-01", true),
    ("real-world-lf.txt", 0, "2024-01-05", true),
    ("real-world-lf.txt", 7, "2024-01-08", true),
    ("real-world-lf.txt", 16, "2024-01-20", true),
    ("real-world-lf.txt", 33, "2024-01-15", true),
    ("real-world-lf.txt", 34, "2024-03-01", true),
    ("real-world-lf.txt", 43, "2024-01-22", true),
];

/// The todo records a fixture commits: full `todos`, or `samples` for the
/// 10 000-todo file.
fn committed_todos(fixture: &FileExpectation) -> Vec<(usize, &TodoRecord)> {
    let mut records = Vec::new();
    if let Some(todos) = &fixture.todos {
        records.extend(todos.iter().enumerate());
    }
    if let Some(samples) = &fixture.samples {
        records.extend(samples.iter().map(|sample| (sample.index, &sample.todo)));
    }
    records
}

#[test]
fn threshold_visibility_is_pinned_for_every_threshold_todo() {
    let corpus = load_expected();

    for &(file, index, threshold, expected_passed) in THRESHOLD_CASES {
        let (_, data) = read_fixture(file);
        let todos = parse_file(&data, &corpus.limits()).expect("fixture parses");
        let todo = todos
            .get(index)
            .unwrap_or_else(|| panic!("{file}: threshold case {index} is out of range"));

        assert_eq!(
            todo.tag("t").and_then(TagValue::as_single),
            Some(threshold),
            "{file}[{index}]: pinned t: value"
        );
        assert_eq!(
            todo.is_passed_threshold(today()),
            expected_passed,
            "{file}[{index}]: isPassedThreshold"
        );
    }

    // The pinned table must cover every committed todo that carries a `t:` tag,
    // so adding one to a fixture fails here until its visibility is pinned.
    let pinned: BTreeSet<(&str, usize)> = THRESHOLD_CASES
        .iter()
        .map(|&(file, index, _, _)| (file, index))
        .collect();
    let mut discovered = BTreeSet::new();

    for (file, fixture) in &corpus.files {
        for (index, record) in committed_todos(fixture) {
            if record.tags.iter().any(|(key, _)| key == "t") {
                discovered.insert((file.as_str(), index));
            }
        }
    }

    assert_eq!(
        discovered, pinned,
        "every committed t: todo needs a pinned isPassedThreshold case"
    );
}

#[test]
fn clock_and_limits_match_the_typescript_corpus() {
    let corpus = load_expected();
    assert_eq!(corpus.clock_local, "2026-11-15T12:00:00");
    assert_eq!(TodoDate::parse(&corpus.clock_local[..10]), Some(today()));
    assert_eq!(corpus.limits(), ReadLimits::DEFAULT);
}
