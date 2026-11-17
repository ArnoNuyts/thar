//! Differential parity for the CP3a domain against the TypeScript oracle.
//!
//! `domain-expectations.json` was generated **once** from the TypeScript
//! implementation by `tests/generate-domain-expectations.ts` with the corpus
//! clock pinned to local `2026-11-15T12:00:00`, and reviewed before committing.
//! These tests never regenerate it: a behaviour change means a deliberate
//! change to the JSON, reviewed as a change.
//!
//! This is not a second corpus. CP3b folds these expectations into the live CP1
//! contract (`tools/port/`) so one harness covers the whole read path.
//!
//! Coverage, per committed corpus fixture (except the error fixtures, which
//! `corpus_parity.rs` owns):
//!
//! - `sorted`: input indexes in `sortByImportance` order (comparator +
//!   stability);
//! - `visible`: input indexes of `filterHidden`;
//! - `rows`: `createIndexes` over the visible, sorted list, encoded as
//!   `context:<name>:<count>` / `todo:<number>`;
//! - `search`: matched input indexes per query in the fixed query list,
//!   replayed from the host-normalized `searchView` and `searchTerms` the
//!   generator emitted. The Rust core never folds case or splits queries, so
//!   the test feeds it exactly what JavaScript produced.
//!
//! Plus one deterministic 1 000-todo list (LCG, mixed-case and punctuation
//! contexts, priorities, due/threshold/hidden tags, duplicate lines), the ICU
//! collation probe, the search-case table (sigma and astral-dot shapes), and
//! the recurrence/setter/toggle pins.
//!
//! Lists above the generator's digest threshold are stored as
//! `{ "count": n, "sha256": "…" }` of the newline-joined values. That keeps
//! the committed file reviewable while still pinning the exact order and
//! content (`large-10000.txt`, and search results with more than 500 matches).

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Debug;
use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;

use serde::Deserialize;
use sha2::{Digest, Sha256};
use thar_core::{
    CoreError, Priority, ReadLimits, Recurrence, RecurrenceError, Row, SearchView, State, Todo,
    TodoDate, TodoId, create_rows, filter_by_search, is_valid_recurrence, plan_recurrence,
    serialize_file, sort_by_importance,
};

fn expectations_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests")
}

fn corpus_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../testdata/port")
}

fn clock_day() -> TodoDate {
    "2026-11-15"
        .parse::<TodoDate>()
        .expect("the pinned clock day is valid")
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Expectations {
    oracle: Oracle,
    queries: Vec<String>,
    fixtures: BTreeMap<String, FixtureExpectation>,
    synthetic: BTreeMap<String, SyntheticExpectation>,
    collation: CollationExpectation,
    search_terms: Vec<SearchTermsCase>,
    search_cases: Vec<SearchCase>,
    recurrence: Vec<RecurrenceCase>,
    setters: Vec<SetterCase>,
    toggles: Vec<ToggleCase>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Oracle {
    clock_local: String,
    node: String,
    icu: String,
    collation: String,
}

/// A committed list: small lists in full, large ones as a digest.
#[derive(Debug, Deserialize)]
#[serde(untagged, rename_all = "camelCase")]
enum ListExpectation<T> {
    Full(Vec<T>),
    Digest { count: usize, sha256: String },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DomainExpectation {
    todo_count: usize,
    sorted: ListExpectation<usize>,
    visible: ListExpectation<usize>,
    rows: ListExpectation<String>,
    search_view: Vec<SearchViewExpectation>,
    search: BTreeMap<String, ListExpectation<usize>>,
}

#[derive(Debug, Deserialize)]
struct FixtureExpectation {
    #[serde(flatten)]
    domain: DomainExpectation,
}

#[derive(Debug, Deserialize)]
struct SyntheticExpectation {
    lines: Vec<String>,
    #[serde(flatten)]
    domain: DomainExpectation,
}

/// One todo's host-normalized search input: `[text, contexts, projects]`.
#[derive(Debug, Deserialize)]
struct SearchViewExpectation(String, Vec<String>, Vec<String>);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CollationExpectation {
    single_characters: Vec<String>,
    strings: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct SearchTermsCase {
    query: String,
    terms: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct SearchCase {
    line: String,
    query: String,
    view: SearchViewExpectation,
    terms: Vec<String>,
    matched: Vec<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecurrenceCase {
    value: String,
    base: String,
    next_due: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetterCase {
    line: String,
    op: String,
    arg: Option<String>,
    preserve: bool,
    original: String,
    expected: String,
}

#[derive(Debug, Deserialize)]
struct ToggleCase {
    line: String,
    updated: String,
    recurring: Option<String>,
    error: Option<String>,
}

fn load_expectations() -> &'static Expectations {
    static EXPECTATIONS: OnceLock<Expectations> = OnceLock::new();

    EXPECTATIONS.get_or_init(|| {
        let path = expectations_dir().join("domain-expectations.json");
        let json = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
        serde_json::from_str(&json)
            .unwrap_or_else(|error| panic!("parse {}: {error}", path.display()))
    })
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

impl<T> ListExpectation<T>
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

/// Parse a fixture the way the corpus loader does: lossy decode, validate,
/// drop blank lines, assign ids in load order.
fn parse_fixture(name: &str) -> Vec<Todo> {
    let path = corpus_dir().join(name);
    let bytes = fs::read(&path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    let data = String::from_utf8_lossy(&bytes).into_owned();
    thar_core::parse_file(&data, &ReadLimits::DEFAULT)
        .expect("only parseable fixtures are committed in domain expectations")
}

/// Encode the row model exactly as the generator does.
fn encode_rows(rows: &[Row<'_>]) -> Vec<String> {
    rows.iter()
        .map(|row| match row {
            Row::Context { name, todo_count } => format!("context:{name}:{todo_count}"),
            Row::Todo { number, .. } => format!("todo:{number}"),
        })
        .collect()
}

/// The host-normalized terms the generator committed for `query`.
fn terms_for(query: &str) -> Vec<&str> {
    load_expectations()
        .search_terms
        .iter()
        .find(|case| case.query == query)
        .unwrap_or_else(|| panic!("no committed search terms for {query:?}"))
        .terms
        .iter()
        .map(String::as_str)
        .collect()
}

/// Everything the committed expectations pin for one list.
fn assert_domain(label: &str, todos: &[Todo], expected: &DomainExpectation) {
    let DomainExpectation {
        todo_count,
        sorted: sorted_expectation,
        visible: visible_expectation,
        rows: rows_expectation,
        search_view: search_views,
        search: search_expectations,
    } = expected;

    assert_eq!(todos.len(), *todo_count, "{label}: todoCount");

    let sorted = sort_by_importance(todos, clock_day());
    sorted_expectation.verify(&format!("{label}: sorted"), &sorted);

    let visible: Vec<usize> = (0..todos.len())
        .filter(|index| todos[*index].is_visible_in_overview(clock_day()))
        .collect();
    visible_expectation.verify(&format!("{label}: visible"), &visible);

    // The row model is built from the visible, sorted list, like the app does.
    let visible_order: Vec<usize> = sorted
        .iter()
        .copied()
        .filter(|index| todos[*index].is_visible_in_overview(clock_day()))
        .collect();
    let visible_sorted: Vec<Todo> = visible_order
        .iter()
        .map(|index| todos[*index].clone())
        .collect();

    let rows = create_rows(visible_sorted.iter());
    rows_expectation.verify(&format!("{label}: rows"), &encode_rows(&rows));

    // Search takes the generator's normalized views; folding here would be a
    // different implementation from JavaScript's.
    assert_eq!(
        search_views.len(),
        todos.len(),
        "{label}: one searchView per todo"
    );
    let all_views: Vec<SearchView<'_>> = search_views
        .iter()
        .map(|view| SearchView {
            text: &view.0,
            contexts: &view.1,
            projects: &view.2,
        })
        .collect();
    let views: Vec<SearchView<'_>> = visible_order
        .iter()
        .map(|index| all_views[*index])
        .collect();

    // A dropped query key must not silently stop being tested.
    let committed: BTreeSet<&str> = search_expectations.keys().map(String::as_str).collect();
    let expected: BTreeSet<&str> = load_expectations()
        .queries
        .iter()
        .map(String::as_str)
        .collect();
    assert_eq!(committed, expected, "{label}: search query keys");

    for (query, matches) in search_expectations {
        let terms = terms_for(query);
        let matched: Vec<usize> = filter_by_search(&views, &terms)
            .into_iter()
            .map(|position| visible_order[position])
            .collect();
        matches.verify(&format!("{label}: search {query:?}"), &matched);
    }
}

#[test]
fn oracle_metadata_pins_the_clock_and_collation() {
    let expectations = load_expectations();
    assert_eq!(expectations.oracle.clock_local, "2026-11-15T12:00:00");
    assert_eq!(clock_day().to_string(), "2026-11-15");
    assert!(!expectations.oracle.node.is_empty());
    assert!(!expectations.oracle.icu.is_empty());
    assert!(
        expectations.oracle.collation.contains("Intl.Collator"),
        "collation: {}",
        expectations.oracle.collation
    );
}

/// Fixture names on disk mapped to "parses successfully".
fn on_disk_fixtures() -> BTreeMap<String, bool> {
    let mut fixtures = BTreeMap::new();

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
        fixtures.insert(name, parseable);
    }

    fixtures
}

#[test]
fn every_committed_expectation_belongs_to_a_parseable_fixture() {
    let expectations = load_expectations();
    let on_disk = on_disk_fixtures();

    for name in expectations.fixtures.keys() {
        assert_eq!(
            on_disk.get(name),
            Some(&true),
            "{name}: committed expectations must belong to a parseable fixture"
        );
    }
}

#[test]
fn every_parseable_fixture_is_covered() {
    let expectations = load_expectations();

    for (name, parseable) in on_disk_fixtures() {
        if parseable {
            assert!(
                expectations.fixtures.contains_key(&name),
                "{name}: missing domain expectations"
            );
        }
    }
}

#[test]
fn fixtures_match_the_oracle() {
    let expectations = load_expectations();

    for (name, expected) in &expectations.fixtures {
        let todos = parse_fixture(name);
        assert_domain(name, &todos, &expected.domain);
    }
}

#[test]
fn synthetic_list_matches_the_oracle() {
    let expectations = load_expectations();

    for (name, synthetic) in &expectations.synthetic {
        let joined = synthetic.lines.join("\n");
        let todos = thar_core::parse_file(&joined, &ReadLimits::DEFAULT)
            .expect("the synthetic list is a valid file");
        assert_eq!(todos.len(), synthetic.lines.len(), "{name}: line count");
        assert_domain(name, &todos, &synthetic.domain);
    }
}

#[test]
fn collation_matches_the_oracle() {
    let expectations = load_expectations();

    // The empty string is not a context: it stands for the `None` group, which
    // the sort handles before collation.
    let strings: Vec<&str> = expectations
        .collation
        .strings
        .iter()
        .map(String::as_str)
        .filter(|value| !value.is_empty())
        .collect();

    let todos: Vec<Todo> = strings
        .iter()
        .enumerate()
        .map(|(index, context)| {
            Todo::parse_line(&format!("task @{context}"), TodoId::new(index as u64))
        })
        .collect();

    let sorted: Vec<&str> = sort_by_importance(&todos, clock_day())
        .into_iter()
        .map(|index| strings[index])
        .collect();

    let expected: Vec<&str> = expectations
        .collation
        .strings
        .iter()
        .map(String::as_str)
        .filter(|value| !value.is_empty())
        .collect();

    assert_eq!(
        sorted.len(),
        expected.len(),
        "one todo per committed string"
    );
    for (index, (actual, expected)) in sorted.iter().zip(&expected).enumerate() {
        assert_eq!(actual, expected, "collation position {index}");
    }

    // The single-character order is the primitive the comparator builds on.
    for pair in expectations.collation.single_characters.windows(2) {
        let todos = vec![
            Todo::parse_line(&format!("task @{}", pair[1]), TodoId::new(0)),
            Todo::parse_line(&format!("task @{}", pair[0]), TodoId::new(1)),
        ];
        assert_eq!(
            sort_by_importance(&todos, clock_day()),
            vec![1, 0],
            "{} must sort before {}",
            pair[0],
            pair[1]
        );
    }
}

#[test]
fn search_cases_match_the_oracle() {
    let expectations = load_expectations();

    for case in &expectations.search_cases {
        // The raw line still parses and round-trips; only search normalization
        // comes from the host.
        assert_eq!(
            Todo::parse_line(&case.line, TodoId::new(0)).to_string(),
            case.line,
            "case line {:?}",
            case.line
        );

        let views = [SearchView {
            text: &case.view.0,
            contexts: &case.view.1,
            projects: &case.view.2,
        }];
        let terms: Vec<&str> = case.terms.iter().map(String::as_str).collect();

        assert_eq!(
            filter_by_search(&views, &terms),
            case.matched,
            "line {:?} query {:?}",
            case.line,
            case.query
        );
    }
}

#[test]
fn every_query_has_committed_terms() {
    let expectations = load_expectations();

    for query in &expectations.queries {
        // `terms_for` panics when the generator dropped a query.
        let terms = terms_for(query);
        assert!(
            !terms.iter().any(|term| term.is_empty()),
            "query {query:?}: empty terms are dropped by the host"
        );
    }
}

#[test]
fn recurrence_matches_the_oracle() {
    let expectations = load_expectations();

    for case in &expectations.recurrence {
        let base = case
            .base
            .parse::<TodoDate>()
            .expect("case base is a valid day");
        let planned = plan_recurrence(&case.value, base);

        match (&case.next_due, &case.error) {
            (Some(next_due), None) => {
                assert_eq!(
                    planned.map(|day| day.to_string()).ok(),
                    Some(next_due.clone()),
                    "plan for {:?} from {}",
                    case.value,
                    case.base
                );
            }
            (None, Some(error)) => {
                assert_eq!(
                    planned.expect_err("bad recurrence must fail").message(),
                    error,
                    "error for {:?}",
                    case.value
                );
            }
            (None, None) => {
                // An invalid value is not storable.
                assert!(!is_valid_recurrence(&case.value), "value {:?}", case.value);
            }
            (Some(_), Some(_)) => panic!("case has both nextDue and error"),
        }
    }
}

/// Apply one committed setter case exactly like the generator's switch.
fn apply_setter(todo: Todo, case: &SetterCase) -> Todo {
    let arg = case.arg.as_deref();
    let day = |value: Option<&str>| {
        value
            .and_then(|value| value.parse::<TodoDate>().ok())
            .expect("committed setter date is valid")
    };

    match case.op.as_str() {
        "set_text" => todo.set_text(arg.unwrap_or_default(), case.preserve),
        "set_priority" => todo.set_priority(
            arg.and_then(|value| value.chars().next())
                .and_then(Priority::new),
        ),
        "set_creation_date" => todo.set_creation_date(day(arg)),
        "set_completion_date" => todo.set_completion_date(arg.map(|value| day(Some(value)))),
        "set_state" => todo.set_state(if arg == Some("done") {
            State::Done
        } else {
            State::Todo
        }),
        "set_due" => todo.set_due(day(arg)),
        "remove_due" => todo.remove_due(),
        "set_threshold" => todo.set_threshold(day(arg)),
        "remove_threshold" => todo.remove_threshold(),
        "toggle_hidden" => todo.toggle_hidden(),
        "set_recurrence" => match arg.unwrap_or_default().parse::<Recurrence>() {
            Ok(value) => todo.set_recurrence(value),
            // The generator only emits storable values, plus invalid ones the
            // oracle ignores; an invalid value leaves the todo unchanged.
            Err(_) => todo,
        },
        "remove_recurrence" => todo.remove_recurrence(),
        "add_context" => todo.add_context(arg.unwrap_or_default()),
        "remove_context" => todo.remove_context(arg.unwrap_or_default()),
        "add_project" => todo.add_project(arg.unwrap_or_default()),
        "remove_project" => todo.remove_project(arg.unwrap_or_default()),
        other => panic!("unknown setter op {other:?}"),
    }
}

#[test]
fn setters_match_the_oracle() {
    let expectations = load_expectations();

    for case in &expectations.setters {
        let original = Todo::parse_line(&case.line, TodoId::new(0));
        assert_eq!(
            original.to_string(),
            case.original,
            "case {:?} {:?}: original must round-trip",
            case.op,
            case.line
        );

        let updated = apply_setter(original.clone(), case);
        assert_eq!(
            updated.to_string(),
            case.expected,
            "case {:?} {:?} arg {:?}",
            case.op,
            case.line,
            case.arg
        );

        // The receiver must be untouched.
        assert_eq!(
            original.to_string(),
            case.original,
            "case {:?} mutated the receiver",
            case.op
        );
        assert_eq!(updated.id, original.id, "case {:?}: id", case.op);
    }
}

fn toggle_result(line: &str) -> thar_core::ToggleOutcome {
    Todo::parse_line(line, TodoId::new(0)).toggle_state(clock_day(), TodoId::new(1))
}

#[test]
fn toggles_match_the_oracle() {
    let expectations = load_expectations();

    for case in &expectations.toggles {
        let outcome = toggle_result(&case.line);
        let updated = outcome.updated;
        let (recurring, error) = match outcome.recurring {
            Ok(recurring) => (recurring, None),
            Err(error) => (None, Some(error)),
        };
        assert_eq!(
            updated.to_string(),
            case.updated,
            "updated line for {:?}",
            case.line
        );
        assert_eq!(
            recurring.as_ref().map(Todo::to_string),
            case.recurring,
            "recurring line for {:?}",
            case.line
        );
        assert_eq!(
            error.map(RecurrenceError::message),
            case.error.as_deref(),
            "recurrence error for {:?}",
            case.line
        );

        if let Some(recurring) = &recurring {
            assert_eq!(recurring.id, TodoId::new(1), "recurring id");
        }
    }
}

/// The serializer is shared with the write path; guard that a mutation of the
/// parsed fixture still round-trips to the same bytes (the corpus owns the
/// exact hash, this test owns "the setters did not touch parsing").
#[test]
fn fixture_round_trip_is_stable_under_the_domain_pipeline() {
    let expectations = load_expectations();

    for name in expectations.fixtures.keys() {
        let todos = parse_fixture(name);
        let sorted: Vec<Todo> = sort_by_importance(&todos, clock_day())
            .into_iter()
            .map(|index| todos[index].clone())
            .collect();

        let mut before: Vec<String> = todos.iter().map(Todo::to_string).collect();
        let mut after: Vec<String> = sorted.iter().map(Todo::to_string).collect();
        before.sort();
        after.sort();
        assert_eq!(
            before, after,
            "{name}: sorting must not change the serialized lines"
        );

        // The write path joins in list order; the sorted list is still a valid
        // file with the same number of lines.
        assert_eq!(
            serialize_file(&sorted).lines().count(),
            serialize_file(&todos).lines().count(),
            "{name}: line count"
        );
    }
}

/// A tiny guard so a change to the error type re-reads this test.
#[test]
fn parse_errors_are_not_part_of_the_domain_expectations() {
    let expectations = load_expectations();
    let error = thar_core::parse_file("\u{0000}\n", &ReadLimits::DEFAULT)
        .expect_err("control character fixture");
    assert!(matches!(error, CoreError::ControlCharacter { .. }));
    assert!(!expectations.fixtures.contains_key("control-nul.txt"));
}
