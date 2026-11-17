//! The contiguous-context row model.
//!
//! Ports `createIndexes` from `logic/indexes.ts` exactly:
//!
//! - consecutive todos with the same **first** context form one group;
//! - every group starts with a context header, including the uncategorised one,
//!   whose name is [`NONE_CONTEXT`] (`"None"`);
//! - the header carries the final `todo_count` of its group;
//! - todo rows are numbered 1..=n across the whole list, ignoring headers;
//! - a context that appears again after another group gets a fresh header.
//!
//! The TypeScript entries carry a `type` discriminator; here the [`Row`] enum
//! variant is that type. Row order and [`Row::Todo`] numbers are part of the
//! navigation model, not a rendering detail: mouse coordinates and scroll
//! padding count the header rows too.
//!
//! # Row building
//!
//! [`build_rows`] composes the pieces the host runs on every search keystroke:
//! [`sort_by_importance`] → [`Todo::is_visible_in_overview`] (unless hidden
//! todos are shown) →
//! [`filter_by_search`] → [`create_rows`]. It returns a [`Rows`] that owns the
//! row list plus the ordered input indexes behind the todo rows, so the host
//! maps rows back to its own objects without a second lookup pass.
//!
//! Search input is host-normalized: [`build_rows`] takes one [`SearchView`] per
//! todo, already lowercased by the host, plus the already-extracted terms.
//! Empty `terms` match everything. Contexts collate with the en-US ICU order of
//! [`sort_by_importance`] (see `docs/rust-port/PLAN.md` §13).
//!
//! Names the programme supplies (project/context/tag names that never come out
//! of a `todo.txt` line) are **opaque** here: the row builder does not
//! normalize, validate, or collate anything it did not parse itself. They
//! become part of the contract in CP3b2/CP4.
//!
//! # Example
//!
//! ```
//! use thar_core::{
//!     NONE_CONTEXT, Row, SearchView, Todo, TodoDate, TodoId, build_rows,
//! };
//!
//! let todos = vec![
//!     Todo::parse_line("one @home", TodoId::new(0)),
//!     Todo::parse_line("two", TodoId::new(1)),
//! ];
//! let home = ["home".to_owned()];
//! let views = [
//!     SearchView { text: "one @home", contexts: &home, projects: &[] },
//!     SearchView { text: "two", contexts: &[], projects: &[] },
//! ];
//! let today = "2026-11-15".parse::<TodoDate>().expect("a valid date");
//! let rows = build_rows(&todos, &views, &[], false, today)
//!     .expect("views and todos are aligned");
//! // No first context sorts first, so `two` leads with the `None` header.
//! assert_eq!(
//!     rows.rows(),
//!     [
//!         Row::Context { name: NONE_CONTEXT, todo_count: 1 },
//!         Row::Todo { todo: &todos[1], number: 1 },
//!         Row::Context { name: "home", todo_count: 1 },
//!         Row::Todo { todo: &todos[0], number: 2 },
//!     ]
//! );
//! assert_eq!(rows.todo_indexes(), [1, 0]);
//! ```

use crate::date::TodoDate;
use crate::model::{Todo, TodoId};
use crate::query::{SearchView, sort_by_importance, view_matches};

/// Header name for the group of todos without a context.
pub const NONE_CONTEXT: &str = "None";

/// One row of the list: a context header or a todo.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Row<'a> {
    /// A context header covering the following `todo_count` todo rows.
    Context {
        /// First context of the group, or [`NONE_CONTEXT`].
        name: &'a str,
        /// Number of todos in this contiguous group.
        todo_count: usize,
    },
    /// A todo row.
    Todo {
        /// The todo this row shows.
        todo: &'a Todo,
        /// 1-based position among todo rows, ignoring headers.
        number: usize,
    },
}

impl Row<'_> {
    /// True for [`Row::Todo`].
    #[must_use]
    pub const fn is_todo(&self) -> bool {
        matches!(self, Self::Todo { .. })
    }

    /// The todo id, or `None` for a context header.
    #[must_use]
    pub const fn todo_id(&self) -> Option<TodoId> {
        match self {
            Self::Todo { todo, .. } => Some(todo.id),
            Self::Context { .. } => None,
        }
    }
}

/// Build the row model for `todos`, which must already be sorted and filtered.
///
/// # Example
///
/// ```
/// use thar_core::{NONE_CONTEXT, Row, Todo, TodoId, create_rows};
///
/// let todos = vec![
///     Todo::parse_line("one @home", TodoId::new(0)),
///     Todo::parse_line("two", TodoId::new(1)),
/// ];
/// let rows = create_rows(todos.iter());
/// assert_eq!(
///     rows,
///     vec![
///         Row::Context { name: "home", todo_count: 1 },
///         Row::Todo { todo: &todos[0], number: 1 },
///         Row::Context { name: NONE_CONTEXT, todo_count: 1 },
///         Row::Todo { todo: &todos[1], number: 2 },
///     ]
/// );
/// ```
#[must_use]
pub fn create_rows<'a>(todos: impl IntoIterator<Item = &'a Todo>) -> Vec<Row<'a>> {
    let mut rows: Vec<Row<'a>> = Vec::new();
    let mut group = Group::Unstarted;
    let mut header = 0;

    for (number, todo) in todos.into_iter().enumerate() {
        let context = todo.contexts.first().map(String::as_str);
        let next = Group::of(context);

        if group != next {
            rows.push(Row::Context {
                name: context.unwrap_or(NONE_CONTEXT),
                todo_count: 0,
            });
            header = rows.len() - 1;
            group = next;
        }

        rows.push(Row::Todo {
            todo,
            number: number + 1,
        });

        // Updating the header in place keeps the final count without a second
        // pass over the todos.
        if let Some(Row::Context { todo_count, .. }) = rows.get_mut(header) {
            *todo_count += 1;
        }
    }

    rows
}

/// The context group the previous row belonged to.
///
/// `Unstarted` and `Uncategorised` both mean "no first context" but must not
/// compare equal: the first uncategorised todo needs its `None` header, while a
/// later uncategorised todo continues the same group.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Group<'a> {
    /// No row has been emitted yet.
    Unstarted,
    /// The group of todos without a first context.
    Uncategorised,
    /// A group whose header shows this first context.
    Named(&'a str),
}

impl<'a> Group<'a> {
    /// The group a todo's first context belongs to.
    fn of(context: Option<&'a str>) -> Self {
        match context {
            Some(name) => Self::Named(name),
            None => Self::Uncategorised,
        }
    }
}

/// A built row model.
///
/// The row list is exactly what [`create_rows`] produces for the visible,
/// sorted, searched todos. [`Rows::todo_indexes`] is the same list spelled out
/// as input indexes, which is what the host needs to map a row back to its own
/// todo objects.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rows<'a> {
    rows: Vec<Row<'a>>,
    todo_indexes: Vec<usize>,
}

impl<'a> Rows<'a> {
    /// The rows, headers included.
    #[must_use]
    pub fn rows(&self) -> &[Row<'a>] {
        &self.rows
    }

    /// Input indexes of the todo rows, in row order.
    ///
    /// There is exactly one entry per [`Row::Todo`], so the n-th todo row
    /// carries `todo_indexes()[n - 1]` (todo numbers are 1-based). The slice is
    /// the sorted, filtered, searched order, which is also the order the
    /// TypeScript `createIndexes` input has.
    #[must_use]
    pub fn todo_indexes(&self) -> &[usize] {
        &self.todo_indexes
    }

    /// True when no row was produced (an empty visible list).
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }

    /// Number of rows, headers included.
    #[must_use]
    pub fn len(&self) -> usize {
        self.rows.len()
    }
}

/// Why a row build was rejected before producing any rows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RowError {
    /// `views` is not aligned with `todos`.
    ///
    /// The host owns the search views; a mismatch means it built them for a
    /// different list, so no row could be trusted.
    ViewCountMismatch {
        /// Number of todos supplied.
        todos: usize,
        /// Number of search views supplied.
        views: usize,
    },
}

impl core::fmt::Display for RowError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::ViewCountMismatch { todos, views } => write!(
                f,
                "search views ({views}) must be aligned with todos ({todos})"
            ),
        }
    }
}

impl std::error::Error for RowError {}

/// Sort, filter, search, and group a todo list into rows.
///
/// This is the host's per-keystroke composition (`sortByImportance` →
/// `filterHidden` unless hidden todos are shown → `filterBySearch` →
/// `createIndexes`), kept in one place so the order of the stages cannot drift
/// between callers.
///
/// The returned rows borrow `todos` only; the views and terms are read during
/// the call, so a caller can free them afterwards.
///
/// # Errors
///
/// Returns [`RowError::ViewCountMismatch`] when `views` is not aligned with
/// `todos`.
pub fn build_rows<'todos, 'views>(
    todos: &'todos [Todo],
    views: &'views [SearchView<'views>],
    terms: &[&str],
    show_hidden: bool,
    today: TodoDate,
) -> Result<Rows<'todos>, RowError> {
    if todos.len() != views.len() {
        return Err(RowError::ViewCountMismatch {
            todos: todos.len(),
            views: views.len(),
        });
    }

    let mut order = sort_by_importance(todos, today);

    if !show_hidden {
        // Same predicate as `Todo::is_visible_in_overview`; applying it to the sorted indexes
        // keeps the sort's order instead of scanning the list twice.
        order.retain(|&index| {
            // `sort_by_importance` returns a permutation of the input indexes.
            debug_assert!(index < todos.len(), "sort index {index} out of range");
            todos
                .get(index)
                .is_some_and(|todo| todo.is_visible_in_overview(today))
        });
    }

    if !terms.is_empty() {
        // Same predicate as `filter_by_search`, applied to the sorted list so
        // the views do not need to be copied into a second slice.
        order.retain(|&index| {
            debug_assert!(index < views.len(), "sort index {index} out of range");
            views
                .get(index)
                .is_some_and(|view| view_matches(view, terms))
        });
    }

    // `create_rows` emits exactly one todo row per index, which is what lets
    // `Rows::todo_indexes` be zipped with the todo rows. The sort returns a
    // permutation of the input indexes; assert that in debug builds so a
    // desync cannot be introduced silently, and keep `get` total in release.
    let rows = create_rows(order.iter().filter_map(|&index| {
        debug_assert!(index < todos.len(), "sort index {index} out of range");
        todos.get(index)
    }));

    Ok(Rows {
        rows,
        todo_indexes: order,
    })
}

#[cfg(test)]
mod tests {
    use super::{NONE_CONTEXT, Row, RowError, SearchView, build_rows, create_rows};
    use crate::date::TodoDate;
    use crate::model::{Todo, TodoId};

    fn todos(lines: &[&str]) -> Vec<Todo> {
        lines
            .iter()
            .enumerate()
            .map(|(index, line)| Todo::parse_line(line, TodoId::new(index as u64)))
            .collect()
    }

    /// The host lowercases; ASCII inputs make `str::to_lowercase` equivalent.
    /// These tests pass the views explicitly so the boundary stays visible.
    fn view<'a>(text: &'a str, contexts: &'a [String]) -> SearchView<'a> {
        SearchView {
            text,
            contexts,
            projects: &[],
        }
    }

    fn headers<'a>(rows: &[Row<'a>]) -> Vec<(&'a str, usize)> {
        rows.iter()
            .filter_map(|row| match row {
                Row::Context { name, todo_count } => Some((*name, *todo_count)),
                Row::Todo { .. } => None,
            })
            .collect()
    }

    fn numbers(rows: &[Row<'_>]) -> Vec<usize> {
        rows.iter()
            .filter_map(|row| match row {
                Row::Todo { number, .. } => Some(*number),
                Row::Context { .. } => None,
            })
            .collect()
    }

    #[test]
    fn empty_list_has_no_rows() {
        let list: Vec<Todo> = Vec::new();
        assert!(create_rows(list.iter()).is_empty());
    }

    #[test]
    fn all_uncategorised_todos_share_one_none_header() {
        let list = todos(&["plain one", "plain two", "x done"]);
        let rows = create_rows(list.iter());

        assert_eq!(headers(&rows), vec![(NONE_CONTEXT, 3)]);
        assert_eq!(numbers(&rows), vec![1, 2, 3]);
        assert_eq!(rows.len(), 4);
    }

    #[test]
    fn one_header_per_contiguous_context_group() {
        let list = todos(&["one @home", "two @work", "three @work", "four @errand"]);
        let rows = create_rows(list.iter());

        assert_eq!(
            headers(&rows),
            vec![("home", 1), ("work", 2), ("errand", 1)]
        );
        assert_eq!(numbers(&rows), vec![1, 2, 3, 4]);
    }

    #[test]
    fn a_repeated_context_gets_a_new_header() {
        let list = todos(&["one @home", "two @work", "three @home"]);
        let rows = create_rows(list.iter());

        assert_eq!(headers(&rows), vec![("home", 1), ("work", 1), ("home", 1)]);
        assert_eq!(numbers(&rows), vec![1, 2, 3]);
    }

    #[test]
    fn headers_report_the_final_count_for_every_group() {
        let list = todos(&["one @home", "two @home", "three @work", "four", "five"]);
        let rows = create_rows(list.iter());

        assert_eq!(
            headers(&rows),
            vec![("home", 2), ("work", 1), (NONE_CONTEXT, 2)]
        );
        assert_eq!(numbers(&rows), vec![1, 2, 3, 4, 5]);
    }

    #[test]
    fn only_the_first_context_groups_the_row() {
        let list = todos(&["one @a @b", "two @a @b", "three @b @a"]);
        let rows = create_rows(list.iter());

        assert_eq!(headers(&rows), vec![("a", 2), ("b", 1)]);
    }

    #[test]
    fn rows_expose_the_todo_and_its_id() {
        let list = todos(&["one @home"]);
        let rows = create_rows(list.iter());

        assert!(!rows[0].is_todo());
        assert_eq!(rows[0].todo_id(), None);
        assert!(rows[1].is_todo());
        assert_eq!(rows[1].todo_id(), Some(TodoId::new(0)));
        assert_eq!(
            rows[1],
            Row::Todo {
                todo: &list[0],
                number: 1
            }
        );
    }

    fn today() -> TodoDate {
        "2026-11-15".parse::<TodoDate>().expect("valid today")
    }

    #[test]
    fn build_rows_composes_sort_hidden_search_and_grouping() {
        let list = todos(&[
            "x done @work",
            "zebra @work",
            "hidden @work h:1",
            "future @work t:2026-11-16",
            "alpha @home",
            "beta",
        ]);
        let work = ["work".to_owned()];
        let home = ["home".to_owned()];
        let views = [
            view("x done @work", &work),
            view("zebra @work", &work),
            view("hidden @work", &work),
            view("future @work", &work),
            view("alpha @home", &home),
            view("beta", &[]),
        ];

        // Both hidden todos are dropped by the default overview; done todos
        // stay visible, so the search narrows to the open and done work todos.
        let rows = build_rows(&list, &views, &["@work"], false, today()).expect("aligned");
        assert_eq!(
            rows.rows(),
            [
                Row::Context {
                    name: "work",
                    todo_count: 2
                },
                Row::Todo {
                    todo: &list[1],
                    number: 1
                },
                Row::Todo {
                    todo: &list[0],
                    number: 2
                },
            ]
        );
        assert_eq!(rows.todo_indexes(), [1, 0]);

        // With hidden todos shown, `filterHidden` is skipped entirely: the
        // hidden and future-threshold work todos come back too, and the done
        // one sorts last inside the same group.
        let shown = build_rows(&list, &views, &["@work"], true, today()).expect("aligned");
        assert_eq!(
            shown.rows(),
            [
                Row::Context {
                    name: "work",
                    todo_count: 4
                },
                Row::Todo {
                    todo: &list[1],
                    number: 1
                },
                Row::Todo {
                    todo: &list[2],
                    number: 2
                },
                Row::Todo {
                    todo: &list[3],
                    number: 3
                },
                Row::Todo {
                    todo: &list[0],
                    number: 4
                },
            ]
        );
        assert_eq!(shown.todo_indexes(), [1, 2, 3, 0]);
    }

    #[test]
    fn build_rows_matches_every_term_and_empty_terms_match_all() {
        let list = todos(&["buy milk @home", "walk dog", "buy bread"]);
        let home = ["home".to_owned()];
        let views = [
            view("buy milk @home", &home),
            view("walk dog", &[]),
            view("buy bread", &[]),
        ];

        let all = build_rows(&list, &views, &[], false, today()).expect("aligned");
        // No first context sorts first, in input order, then `@home`.
        assert_eq!(all.todo_indexes(), [1, 2, 0]);

        let narrowed =
            build_rows(&list, &views, &["buy", "milk"], false, today()).expect("aligned");
        assert_eq!(narrowed.todo_indexes(), [0]);
        assert_eq!(
            narrowed.rows(),
            [
                Row::Context {
                    name: "home",
                    todo_count: 1
                },
                Row::Todo {
                    todo: &list[0],
                    number: 1
                },
            ]
        );
    }

    #[test]
    fn build_rows_reports_a_view_misalignment_instead_of_panicking() {
        let list = todos(&["one", "two"]);
        let views = [view("one", &[])];

        assert_eq!(
            build_rows(&list, &views, &[], false, today()).expect_err("misaligned"),
            RowError::ViewCountMismatch { todos: 2, views: 1 }
        );
    }

    #[test]
    fn build_rows_keeps_the_none_header_and_numbers_across_groups() {
        let list = todos(&["one", "two @home", "three"]);
        let home = ["home".to_owned()];
        let views = [
            view("one", &[]),
            view("two @home", &home),
            view("three", &[]),
        ];

        let rows = build_rows(&list, &views, &[], false, today()).expect("aligned");
        assert_eq!(
            rows.rows(),
            [
                Row::Context {
                    name: NONE_CONTEXT,
                    todo_count: 2
                },
                Row::Todo {
                    todo: &list[0],
                    number: 1
                },
                Row::Todo {
                    todo: &list[2],
                    number: 2
                },
                Row::Context {
                    name: "home",
                    todo_count: 1
                },
                Row::Todo {
                    todo: &list[1],
                    number: 3
                },
            ]
        );
        assert_eq!(rows.todo_indexes(), [0, 2, 1]);
        assert_eq!(rows.len(), 5);
        assert!(!rows.is_empty());
    }

    #[test]
    fn build_rows_of_an_empty_list_has_no_rows() {
        let list: Vec<Todo> = Vec::new();
        let views: Vec<SearchView<'_>> = Vec::new();
        let rows = build_rows(&list, &views, &[], false, today()).expect("aligned");

        assert!(rows.is_empty());
        assert_eq!(rows.len(), 0);
        assert!(rows.todo_indexes().is_empty());
    }
}
