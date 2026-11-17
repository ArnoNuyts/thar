//! Owned row-model parity with the TypeScript pipeline for the CP0 corpus.
//!
//! `fixtures/list-expectations.json` was generated **once** from the TypeScript
//! implementation by `generate-list-expectations.ts` with the corpus clock
//! pinned to local `2026-11-15T12:00:00`, and reviewed before committing.
//! These tests never regenerate it: a behaviour change means a deliberate
//! change to the JSON, reviewed as a change.
//!
//! For every parseable fixture in `testdata/port/`, both `showHidden` values,
//! and every query in the fixed list, the fixture records:
//!
//! - `order`: input-list indexes after
//!   `sortByImportance` → `filterHidden` (unless `showHidden`) →
//!   `filterBySearch`; and
//! - `rows`: the `createIndexes` encoding, `context:<name>:<count>` or
//!   `todo:<number>`, including the `None` header and global 1-based numbering.
//!
//! Lists above 500 entries are stored as `{count, sha256}` of the
//! newline-joined values, so `large-10000.txt` is pinned exactly without a
//! multi-megabyte fixture. The digest is SHA-256, the same construction the
//! CP3a domain expectations use.

use std::collections::BTreeSet;
use std::fmt::Debug;
use std::fs;
use std::path::PathBuf;

use serde_json::Value;
use sha2::{Digest, Sha256};
use thar_core::{ReadLimits, Todo, TodoDate};
use thar_tui::search::view_for;
use thar_tui::{ListModel, ListRow};

/// The fixed query list, repeated from the generators so a dropped query is a
/// test failure rather than silent coverage loss.
const QUERIES: [&str; 13] = [
    "",
    "   ",
    "work",
    "@work",
    "+project",
    "alpha beta",
    "!!!",
    "MILK",
    "due:",
    "h:1",
    "@",
    "a.b",
    "ΟΔΟΣ",
];

/// Both values of the oracle's `showHidden` toggle.
const HIDDEN_MODES: [bool; 2] = [false, true];

/// The corpus clock, matching `testdata/port/expected.json`.
const CLOCK: &str = "2026-11-15";

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/list-expectations.json")
}

fn corpus_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../testdata/port")
}

fn load_fixture() -> Value {
    let path = fixture_path();
    let json = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    serde_json::from_str(&json).unwrap_or_else(|error| panic!("parse {}: {error}", path.display()))
}

fn fixtures(document: &Value) -> &serde_json::Map<String, Value> {
    document
        .get("fixtures")
        .and_then(Value::as_object)
        .expect("fixture has a fixtures object")
}

fn cases(fixture: &Value) -> &[Value] {
    fixture
        .get("cases")
        .and_then(Value::as_array)
        .map_or_else(|| panic!("fixture entry is missing cases"), Vec::as_slice)
}

fn string<'a>(value: &'a Value, key: &str) -> &'a str {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("fixture is missing string field {key}"))
}

fn bool_field(value: &Value, key: &str) -> bool {
    value
        .get(key)
        .and_then(Value::as_bool)
        .unwrap_or_else(|| panic!("fixture is missing bool field {key}"))
}

fn number_field(value: &Value, key: &str) -> usize {
    value.get(key).and_then(Value::as_u64).map_or_else(
        || panic!("fixture is missing integer field {key}"),
        |value| usize::try_from(value).expect("fixture counts fit in usize"),
    )
}

fn sha256_hex(data: &str) -> String {
    use std::fmt::Write as _;

    let digest = Sha256::digest(data.as_bytes());
    let mut hex = String::with_capacity(64);
    for byte in &digest {
        write!(&mut hex, "{byte:02x}").expect("writing to a String cannot fail");
    }
    hex
}

/// A committed list: small lists in full, large ones as a digest.
enum Expected<T> {
    Full(Vec<T>),
    Digest { count: usize, sha256: String },
}

impl<T> Expected<T>
where
    T: PartialEq + Debug + ToString,
{
    fn verify(&self, label: &str, actual: &[T]) {
        match self {
            Self::Full(expected) => {
                assert_eq!(actual.len(), expected.len(), "{label}: length");
                for (index, (actual, expected)) in actual.iter().zip(expected).enumerate() {
                    assert_eq!(actual, expected, "{label}[{index}]");
                }
            }
            Self::Digest { count, sha256 } => {
                assert_eq!(actual.len(), *count, "{label}: count");
                let canonical = actual
                    .iter()
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
                    .join("\n");
                assert_eq!(
                    sha256_hex(&canonical),
                    *sha256,
                    "{label}: digest of {} values",
                    actual.len()
                );
            }
        }
    }
}

fn expected<T>(value: &Value, label: &str, parse: impl Fn(&Value) -> T) -> Expected<T> {
    if let Some(values) = value.as_array() {
        return Expected::Full(values.iter().map(parse).collect());
    }

    let object = value
        .as_object()
        .unwrap_or_else(|| panic!("{label} must be an array or a digest object"));
    let count = object
        .get("count")
        .and_then(Value::as_u64)
        .unwrap_or_else(|| panic!("{label} digest is missing count"));
    let sha256 = object
        .get("sha256")
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("{label} digest is missing sha256"));

    Expected::Digest {
        count: usize::try_from(count).expect("fixture counts fit in usize"),
        sha256: sha256.to_owned(),
    }
}

fn expected_order(value: &Value) -> Expected<usize> {
    expected(value, "order", |value| {
        usize::try_from(value.as_u64().expect("order entries must be input indexes"))
            .expect("input indexes fit in usize")
    })
}

fn expected_rows(value: &Value) -> Expected<String> {
    expected(value, "rows", |value| {
        value
            .as_str()
            .expect("row entries must be strings")
            .to_owned()
    })
}

/// Parse a fixture the way the corpus loader does: lossy decode, validate,
/// drop blank lines, assign ids in load order.
fn parse_fixture(name: &str) -> Vec<Todo> {
    let path = corpus_dir().join(name);
    let bytes = fs::read(&path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    let data = String::from_utf8_lossy(&bytes).into_owned();
    thar_core::parse_file(&data, &ReadLimits::DEFAULT)
        .unwrap_or_else(|error| panic!("{name}: committed fixture must parse: {error}"))
}

/// Encode the owned rows exactly like `createIndexes` in the generator.
fn encode_rows(rows: &[ListRow]) -> Vec<String> {
    rows.iter()
        .map(|row| match row {
            ListRow::Context { name, todo_count } => format!("context:{name}:{todo_count}"),
            ListRow::Todo { number, .. } => format!("todo:{number}"),
        })
        .collect()
}

#[test]
fn fixture_covers_every_parseable_corpus_fixture() {
    let document = load_fixture();

    let queries: Vec<&str> = document
        .get("queries")
        .and_then(Value::as_array)
        .expect("fixture has a queries array")
        .iter()
        .map(|query| query.as_str().expect("queries are strings"))
        .collect();
    assert_eq!(queries, QUERIES, "fixture query list drifted");

    let modes: Vec<bool> = document
        .get("hiddenModes")
        .and_then(Value::as_array)
        .expect("fixture has hiddenModes")
        .iter()
        .map(|mode| mode.as_bool().expect("hidden modes are booleans"))
        .collect();
    assert_eq!(modes, HIDDEN_MODES, "fixture hidden modes drifted");

    let committed = fixtures(&document);

    for entry in fs::read_dir(corpus_dir()).expect("read testdata/port") {
        let path = entry.expect("directory entry").path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("txt") {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .expect("fixture names are UTF-8")
            .to_owned();
        let parseable = thar_core::parse_file(
            &String::from_utf8_lossy(&fs::read(&path).expect("read fixture")),
            &ReadLimits::DEFAULT,
        )
        .is_ok();

        assert_eq!(
            committed.contains_key(&name),
            parseable,
            "{name}: expectations must cover exactly the parseable fixtures"
        );
    }

    for (name, fixture) in committed {
        let cases = cases(fixture);
        let expected_cases = QUERIES.len() * HIDDEN_MODES.len();
        assert_eq!(cases.len(), expected_cases, "{name}: case count");

        let mut seen = BTreeSet::new();
        for case in cases {
            let hidden = bool_field(case, "showHidden");
            let query = string(case, "query").to_owned();
            assert!(
                HIDDEN_MODES.contains(&hidden),
                "{name}: unknown showHidden value {hidden}"
            );
            assert!(
                seen.insert((hidden, query.clone())),
                "{name}: duplicate case for showHidden={hidden} query={query:?}"
            );
        }

        for hidden in HIDDEN_MODES {
            for query in QUERIES {
                assert!(
                    seen.contains(&(hidden, query.to_owned())),
                    "{name}: missing case for showHidden={hidden} query={query:?}"
                );
            }
        }
    }
}

#[test]
fn owned_row_model_matches_the_oracle() {
    let document = load_fixture();
    let today = CLOCK
        .parse::<TodoDate>()
        .expect("the pinned clock day is valid");

    for (name, fixture) in fixtures(&document) {
        let todos = parse_fixture(name);
        assert_eq!(
            todos.len(),
            number_field(fixture, "todoCount"),
            "{name}: todoCount"
        );

        let views: Vec<_> = todos.iter().map(view_for).collect();

        for case in cases(fixture) {
            let query = string(case, "query");
            let show_hidden = bool_field(case, "showHidden");
            let label = format!("{name}: showHidden={show_hidden} query={query:?}");

            let model = ListModel::build(&todos, &views, query, show_hidden, today);

            expected_order(
                case.get("order")
                    .unwrap_or_else(|| panic!("{label}: case is missing order")),
            )
            .verify(&format!("{label}: order"), &model.order);

            let row_indexes: Vec<usize> =
                model.rows.iter().filter_map(ListRow::todo_index).collect();
            assert_eq!(
                row_indexes, model.order,
                "{label}: todo rows must map to the ordered input indexes"
            );

            expected_rows(
                case.get("rows")
                    .unwrap_or_else(|| panic!("{label}: case is missing rows")),
            )
            .verify(&format!("{label}: rows"), &encode_rows(&model.rows));
        }
    }
}

#[test]
fn empty_lists_produce_an_empty_model() {
    let today = CLOCK
        .parse::<TodoDate>()
        .expect("the pinned clock day is valid");
    let todos: Vec<Todo> = Vec::new();
    let views: Vec<_> = todos.iter().map(view_for).collect();

    let model = ListModel::build(&todos, &views, "anything", false, today);
    assert!(model.is_empty());
    assert_eq!(model.len(), 0);
    assert!(model.order.is_empty());
    assert!(model.get(0).is_none());
    assert!(model.visible(0, 10).is_empty());
}
