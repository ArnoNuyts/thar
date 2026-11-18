//! Regression guard for the id lookups used by selection reconciliation.
//!
//! A shift-selection can cover ten thousand todos, and `nav::rebuild` validates
//! every range id on each query keystroke. The row model keeps an id-to-row map
//! so that validation is O(range) instead of O(range x todos); this test fails
//! by construction on the old positional-vector implementation, where each
//! lookup scanned the whole list once more.

use std::time::Instant;

use thar_core::{Todo, TodoDate, TodoId};
use thar_tui::App;

/// Generous wall-clock budget for one search keystroke over 10k selected todos.
///
/// The map-based path takes a few milliseconds in a debug build. The budget is
/// deliberately far above that so a loaded CI machine does not flake, while the
/// quadratic path (about 10^8 id comparisons) still exceeds it by design.
const BUDGET: std::time::Duration = std::time::Duration::from_millis(250);

#[test]
fn ten_thousand_selected_todos_search_once_under_budget() {
    let todos: Vec<Todo> = (0..10_000)
        .map(|index| Todo::parse_line(&format!("todo {index}"), TodoId::new(index)))
        .collect();
    let mut app = App::new(
        "todo.txt",
        todos,
        "2026-11-15".parse::<TodoDate>().expect("valid date"),
    );
    app.resize(80, 24);
    app.set_range((0..10_000).map(TodoId::new).collect());

    let start = Instant::now();
    app.set_query("zzz-no-match");
    let elapsed = start.elapsed();

    assert!(app.rows().is_empty(), "the query filters every todo");
    assert!(
        elapsed < BUDGET,
        "reconciling 10k selected ids took {elapsed:?}, over the {BUDGET:?} budget"
    );
}
