//! Regression guard for the id lookups used by selection reconciliation.
//!
//! A shift-selection can cover ten thousand todos, and `nav::rebuild` validates
//! every range id on each query keystroke. The row model keeps an id-to-row map
//! so that validation is O(range) instead of O(range x todos); this test fails
//! by construction on the old positional-vector implementation, where each
//! lookup scanned the whole list once more.
//!
//! The query keeps every row on purpose: a query that filters the whole list
//! would let the range check short-circuit after the first missing id and the
//! quadratic path would stay hidden.

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
    app.set_query("todo");
    let elapsed = start.elapsed();

    let todo_rows = app.rows().iter().filter(|row| row.is_todo()).count();
    assert_eq!(
        todo_rows, 10_000,
        "the query must keep every row so the whole selection range is validated"
    );
    assert!(
        elapsed < BUDGET,
        "reconciling 10k selected ids took {elapsed:?}, over the {BUDGET:?} budget"
    );
}
