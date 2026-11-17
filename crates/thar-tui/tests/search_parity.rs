//! Differential search normalization and term extraction against the oracle.
//!
//! `fixtures/search-expectations.json` was generated **once** from the
//! TypeScript implementation by `generate-search-expectations.ts`, and reviewed
//! before committing. These tests never regenerate it: a behaviour change means
//! a deliberate change to the JSON, reviewed as a change.
//!
//! The fixture pins:
//!
//! - `normalize`: `String.prototype.toLowerCase`, including `Final_Sigma` and
//!   `Case_Ignorable` skipping on both sides of every Greek capital sigma;
//! - `views`: the per-field lowercase applied to a parsed todo's text,
//!   contexts, and projects;
//! - `terms`: `extractSearchTerms`, i.e. JavaScript's `\s` set, `trim()`, and
//!   the two ASCII-only `\w` wrapper-stripping regexes.
//!
//! The oracle uses Node 26.12 / Unicode 17.0. `normalize` delegates the
//! `Final_Sigma` context and its `Cased`/`Case_Ignorable` tables to Rust's
//! `str::to_lowercase`, and these fixtures are the equality check against the
//! oracle's Unicode data.

use std::fs;
use std::path::PathBuf;

use serde_json::Value;
use thar_core::{Todo, TodoId};
use thar_tui::search::{extract_search_terms, normalize, view_for};

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/search-expectations.json")
}

fn load_fixture() -> Value {
    let path = fixture_path();
    let json = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    serde_json::from_str(&json).unwrap_or_else(|error| panic!("parse {}: {error}", path.display()))
}

fn cases<'a>(document: &'a Value, key: &str) -> &'a [Value] {
    document.get(key).and_then(Value::as_array).map_or_else(
        || panic!("fixture is missing the {key} array"),
        Vec::as_slice,
    )
}

fn string<'a>(case: &'a Value, key: &str) -> &'a str {
    case.get(key)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("fixture case is missing string field {key}"))
}

fn strings(case: &Value, key: &str) -> Vec<String> {
    case.get(key).and_then(Value::as_array).map_or_else(
        || panic!("fixture case is missing string array field {key}"),
        |values| {
            values
                .iter()
                .map(|value| {
                    value.as_str().map_or_else(
                        || panic!("fixture case {key} contains a non-string"),
                        str::to_owned,
                    )
                })
                .collect()
        },
    )
}

#[test]
fn oracle_metadata_is_present_and_the_fixture_is_not_empty() {
    let document = load_fixture();
    let oracle = document
        .get("oracle")
        .and_then(Value::as_object)
        .expect("fixture has an oracle description");

    for key in ["source", "node", "icu", "unicode"] {
        assert!(
            oracle
                .get(key)
                .and_then(Value::as_str)
                .is_some_and(|value| !value.is_empty()),
            "oracle.{key} must be recorded"
        );
    }

    // A silently truncated fixture would make the parity claim hollow.
    assert!(cases(&document, "normalize").len() >= 100);
    assert!(cases(&document, "views").len() >= 10);
    assert!(cases(&document, "terms").len() >= 300);
}

#[test]
fn normalize_matches_the_oracle() {
    let document = load_fixture();

    for case in cases(&document, "normalize") {
        let input = string(case, "input");
        let expected = string(case, "lower");
        assert_eq!(
            normalize(input),
            expected,
            "normalize({input:?}) must match String.prototype.toLowerCase"
        );
    }
}

#[test]
fn views_match_the_oracle() {
    let document = load_fixture();

    for case in cases(&document, "views") {
        let line = string(case, "line");
        let todo = Todo::parse_line(line, TodoId::new(0));
        let view = view_for(&todo);

        assert_eq!(view.text, string(case, "text"), "text view for {line:?}");
        assert_eq!(
            view.contexts,
            strings(case, "contexts"),
            "context views for {line:?}"
        );
        assert_eq!(
            view.projects,
            strings(case, "projects"),
            "project views for {line:?}"
        );
    }
}

#[test]
fn terms_match_the_oracle() {
    let document = load_fixture();

    for case in cases(&document, "terms") {
        let query = string(case, "query");
        assert_eq!(
            extract_search_terms(query),
            strings(case, "terms"),
            "extractSearchTerms({query:?})"
        );
    }
}

#[test]
fn sigma_and_case_ignorable_shapes_are_pinned() {
    let document = load_fixture();
    let inputs: Vec<&str> = cases(&document, "normalize")
        .iter()
        .map(|case| string(case, "input"))
        .collect();

    // These are the shapes that separate Final_Sigma with Case_Ignorable
    // skipping from a per-character mapping or an adjacent-neighbour rule.
    for required in [
        "a\u{03A3}.\u{0391}",
        "a\u{03B2}\u{0301}\u{03A3}.",
        "\u{0391}\u{03A3}",
        "\u{0391}\u{03A3}\u{0301}",
        "\u{0391}\u{03A3}\u{00AD}\u{0391}",
        "\u{0391}\u{03A3}'\u{0391}",
        "\u{0391}\u{03A3}\u{02B0}\u{0391}",
    ] {
        assert!(
            inputs.contains(&required),
            "sigma fixture lost the pinned shape {required:?}"
        );
    }
}
