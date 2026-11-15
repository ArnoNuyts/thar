//! Parse → serialize → parse stability.
//!
//! Serialization is a canonical form: it trims the text, consumes a valid and
//! unambiguous prefix, normalizes `x`/priority separators to a space, and moves
//! every tag to the end (comma-joining duplicate keys). Normalizing a raw line
//! can expose a marker that leading whitespace had hidden, so the interesting
//! contract is a bounded fixed point: after at most a couple of passes,
//! serializing is byte-idempotent. The TypeScript oracle behaves the same way.
//!
//! These tests pin that contract over every committed fixture line (which must
//! stabilize immediately) and over 1 000 deterministic pseudo-random lines
//! built from the interesting `todo.txt` fragments. No `rand` crate: a tiny LCG
//! keeps the corpus reproducible.

use std::fs;
use std::path::PathBuf;

use thar_core::{ReadLimits, Todo, TodoDate, TodoId, parse_file};

/// Maximum normalization passes accepted before declaring a line unstable.
const MAX_PASSES: usize = 4;

fn corpus_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../testdata/port")
}

fn today() -> TodoDate {
    TodoDate::parse("2026-11-15").expect("the corpus clock day is valid")
}

/// A line after normalization.
struct Canonical {
    /// The parsed form of [`Canonical::line`].
    todo: Todo,
    /// The serialized, stable line.
    line: String,
    /// How many parse/serialize passes were needed, always at least one.
    passes: usize,
}

/// Parse and serialize until the output stops changing.
fn canonicalize(raw: &str) -> Canonical {
    let mut line = Todo::parse_line(raw, TodoId(0)).serialize();

    for passes in 1..=MAX_PASSES {
        let next = Todo::parse_line(&line, TodoId(0));
        let next_line = next.serialize();
        if next_line == line {
            return Canonical {
                todo: next,
                line,
                passes,
            };
        }
        line = next_line;
    }

    panic!("{raw:?} did not reach a serialization fixed point in {MAX_PASSES} passes");
}

/// Assert the fixed-point contract and return the canonical form.
fn assert_stable(raw: &str) -> Canonical {
    let canonical = canonicalize(raw);

    // The canonical line must parse to the canonical todo and serialize back
    // to the same bytes.
    let reparsed = Todo::parse_line(&canonical.line, TodoId(0));
    assert_eq!(
        reparsed, canonical.todo,
        "canonical form of {raw:?} parses differently"
    );
    assert_eq!(
        reparsed.serialize(),
        canonical.line,
        "canonical form of {raw:?} is not byte-idempotent"
    );

    // Derived predicates must be stable too; they are cheap to check here and
    // catch tag-shape regressions that a byte comparison alone would miss.
    assert_eq!(
        canonical.todo.is_hidden(),
        reparsed.is_hidden(),
        "{raw:?}: is_hidden"
    );
    assert_eq!(
        canonical.todo.is_overdue(today()),
        reparsed.is_overdue(today()),
        "{raw:?}: is_overdue"
    );
    assert_eq!(
        canonical.todo.is_visible_in_overview(today()),
        reparsed.is_visible_in_overview(today()),
        "{raw:?}: is_visible_in_overview"
    );

    canonical
}

#[test]
fn every_fixture_line_is_already_canonical() {
    let mut checked = 0;

    for entry in fs::read_dir(corpus_dir()).expect("read testdata/port") {
        let path = entry.expect("directory entry").path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("txt") {
            continue;
        }
        let data = fs::read_to_string(&path).expect("fixture is valid UTF-8");

        for line in data.split('\n') {
            let canonical = assert_stable(line);
            assert_eq!(
                canonical.passes,
                1,
                "fixture {} line {line:?} needed extra normalization: {:?}",
                path.display(),
                canonical.line
            );
            checked += 1;
        }
    }

    assert!(
        checked > 100,
        "expected the whole corpus, checked {checked}"
    );
}

/// Fragments that exercise every branch of the prefix and tag scanners.
const TOKENS: &[&str] = &[
    "x",
    "x ",
    "X",
    " ",
    "  ",
    "\t",
    "x\t",
    "x\u{00A0}",
    "(A) ",
    "(Z)",
    "(a) ",
    "(AB) ",
    "(A)",
    "2024-02-29",
    "2023-02-29",
    "0000-01-01",
    "9999-12-31",
    "2023-1-1",
    "10000-01-01",
    "+proj",
    "+a/b",
    "+a_b.c-d1",
    "+",
    "@ctx",
    "@",
    "x@y",
    "a@b.c",
    "alpha:one",
    "beta:one",
    "beta:two",
    "due:2020-01-01",
    "t:2026-11-15",
    "h:0",
    "h:1",
    "rec:1d",
    "http://example.com",
    "note:hello,world!",
    "a_b:1",
    "Due:X",
    "empty:",
    "word",
    "über",
    "日本語",
    "🚀",
    "\u{FEFF}",
    "\u{00A0}",
    "\u{2003}",
    "(",
    ")",
    ":",
    "+",
    "@",
    "123",
    "-",
    ".",
    "=",
    "/",
];

/// Small linear congruential generator, so the test data is deterministic.
struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        self.0
    }

    fn below(&mut self, bound: usize) -> usize {
        ((self.next() >> 33) as usize) % bound
    }
}

fn generated_lines(count: usize) -> Vec<String> {
    let mut rng = Lcg(0x5EED_1234_ABCD_EF01);
    let mut lines = Vec::with_capacity(count);

    for _ in 0..count {
        let tokens = 1 + rng.below(10);
        let mut line = String::new();
        for _ in 0..tokens {
            line.push_str(TOKENS[rng.below(TOKENS.len())]);
        }
        lines.push(line);
    }

    lines
}

#[test]
fn generated_lines_reach_a_fixed_point() {
    for line in &generated_lines(1_000) {
        assert_stable(line);
    }
}

#[test]
fn generated_lines_are_accepted_by_the_file_parser() {
    let mut data = generated_lines(1_000).join("\n");
    data.push('\n');

    let todos = parse_file(&data, &ReadLimits::DEFAULT).expect("no rejected control characters");
    assert!(!todos.is_empty(), "expected at least one non-blank line");
    assert!(todos.len() <= 1_000);
    for (index, todo) in todos.iter().enumerate() {
        assert_eq!(todo.id, TodoId(index as u64));
    }
}
