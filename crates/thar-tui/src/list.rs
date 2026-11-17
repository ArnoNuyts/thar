//! The owned row model the TUI renders and navigates.
//!
//! `thar_core::build_rows` returns rows that borrow the todos
//! ([`thar_core::Row`]). A long-lived `App` cannot store those, and rebuilding
//! them every frame would put the sort on the render path. [`ListModel`]
//! therefore owns a row list of indices into `App.todos`: it is rebuilt only
//! when the query, hidden-view toggle, today, or the todo list changes.
//!
//! The row semantics are CP3b1's, unchanged: context headers (including the
//! `"None"` group) are rows, todo numbers are 1-based across the whole list, and
//! consecutive todos with the same first context form one group.

use std::borrow::Borrow;

use thar_core::{Row, Todo, TodoDate, build_rows};

use crate::search::OwnedView;

/// One row in the owned list model.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ListRow {
    /// A context header covering the following `todo_count` todo rows.
    Context {
        /// First context of the group, or `"None"`.
        name: String,
        /// Number of todos in this contiguous group.
        todo_count: usize,
    },
    /// A todo row, pointing into the host's load-order todo list.
    Todo {
        /// Index into `App.todos`.
        todo_index: usize,
        /// 1-based number among todo rows, headers excluded.
        number: usize,
    },
}

impl ListRow {
    /// True for [`ListRow::Todo`].
    #[must_use]
    pub const fn is_todo(&self) -> bool {
        matches!(self, Self::Todo { .. })
    }

    /// The todo index for a todo row, or `None` for a header.
    #[must_use]
    pub const fn todo_index(&self) -> Option<usize> {
        match self {
            Self::Todo { todo_index, .. } => Some(*todo_index),
            Self::Context { .. } => None,
        }
    }

    /// The group size for a header, or `None` for a todo row.
    #[must_use]
    pub const fn context_count(&self) -> Option<usize> {
        match self {
            Self::Context { todo_count, .. } => Some(*todo_count),
            Self::Todo { .. } => None,
        }
    }
}

/// The rows plus the sorted/filtered order they were produced from.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ListModel {
    /// Sorted, filtered, searched todo indexes, in row order.
    pub order: Vec<usize>,
    /// The complete row list, headers included.
    pub rows: Vec<ListRow>,
}

impl ListModel {
    /// Build the row list from the load-order todos and their cached views.
    ///
    /// `query` is normalized inside the call (one allocation per keystroke);
    /// `views` must be aligned with `todos`, which [`crate::app::App`] keeps an
    /// invariant. A misalignment is an internal bug, not user data: debug
    /// builds assert, and release builds return an empty model so the TUI
    /// keeps running.
    ///
    /// `todos` may be any slice of values that borrow a [`Todo`], so the app can
    /// keep its per-todo `Rc<Todo>` sharing intact and still build rows.
    #[must_use]
    pub fn build<T: Borrow<Todo>>(
        todos: &[T],
        views: &[OwnedView],
        query: &str,
        show_hidden: bool,
        today: TodoDate,
    ) -> Self {
        let terms = crate::search::extract_search_terms(query);
        let term_refs: Vec<&str> = terms.iter().map(String::as_str).collect();
        let search_views: Vec<thar_core::SearchView<'_>> = views
            .iter()
            .map(|view| thar_core::SearchView {
                text: &view.text,
                contexts: &view.contexts,
                projects: &view.projects,
            })
            .collect();

        let Ok(rows) = build_rows(todos, &search_views, &term_refs, show_hidden, today) else {
            debug_assert!(false, "search views must be aligned with todos");
            return Self::default();
        };

        let mut todo_number = 0;
        let mut owned = Vec::with_capacity(rows.len());
        for row in rows.rows() {
            match row {
                Row::Context { name, todo_count } => owned.push(ListRow::Context {
                    name: (*name).to_owned(),
                    todo_count: *todo_count,
                }),
                Row::Todo { .. } => {
                    let todo_index = rows
                        .todo_indexes()
                        .get(todo_number)
                        .copied()
                        .unwrap_or_default();
                    todo_number += 1;
                    owned.push(ListRow::Todo {
                        todo_index,
                        number: todo_number,
                    });
                }
            }
        }

        Self {
            order: rows.todo_indexes().to_vec(),
            rows: owned,
        }
    }

    /// Number of rows, headers included.
    #[must_use]
    pub fn len(&self) -> usize {
        self.rows.len()
    }

    /// True when no row was produced.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }

    /// The row at `index`, if any.
    #[must_use]
    pub fn get(&self, index: usize) -> Option<&ListRow> {
        self.rows.get(index)
    }

    /// The visible slice for a viewport, clamped to the row list.
    #[must_use]
    pub fn visible(&self, offset: usize, height: usize) -> &[ListRow] {
        let start = offset.min(self.rows.len());
        let end = start.saturating_add(height).min(self.rows.len());
        &self.rows[start..end]
    }
}

#[cfg(test)]
mod tests {
    use super::{ListModel, ListRow};
    use crate::search::view_for;
    use thar_core::{Todo, TodoDate, TodoId};

    fn todos(lines: &[&str]) -> Vec<Todo> {
        lines
            .iter()
            .enumerate()
            .map(|(index, line)| Todo::parse_line(line, TodoId::new(index as u64)))
            .collect()
    }

    fn build(lines: &[&str], query: &str) -> ListModel {
        let list = todos(lines);
        let views: Vec<_> = list.iter().map(view_for).collect();
        ListModel::build(
            &list,
            &views,
            query,
            false,
            "2026-11-15".parse::<TodoDate>().expect("valid date"),
        )
    }

    #[test]
    fn uncategorised_todos_get_the_none_header() {
        let rows = build(&["one", "two"], "");
        assert_eq!(
            rows.rows,
            [
                ListRow::Context {
                    name: "None".to_owned(),
                    todo_count: 2
                },
                ListRow::Todo {
                    todo_index: 0,
                    number: 1
                },
                ListRow::Todo {
                    todo_index: 1,
                    number: 2
                },
            ]
        );
    }

    #[test]
    fn headers_are_rows_and_numbering_is_global() {
        let rows = build(&["one @home", "two", "three @home"], "");
        // The uncategorised group sorts first; the two `home` runs are
        // separate contiguous groups, and numbering is global.
        assert_eq!(
            rows.rows,
            [
                ListRow::Context {
                    name: "None".to_owned(),
                    todo_count: 1
                },
                ListRow::Todo {
                    todo_index: 1,
                    number: 1
                },
                ListRow::Context {
                    name: "home".to_owned(),
                    todo_count: 2
                },
                ListRow::Todo {
                    todo_index: 0,
                    number: 2
                },
                ListRow::Todo {
                    todo_index: 2,
                    number: 3
                },
            ]
        );
    }

    #[test]
    fn search_filters_rows_but_keeps_load_order_indexes() {
        let rows = build(&["write docs @work", "buy milk"], "docs");
        assert_eq!(rows.order, [0]);
        assert_eq!(
            rows.rows,
            [
                ListRow::Context {
                    name: "work".to_owned(),
                    todo_count: 1
                },
                ListRow::Todo {
                    todo_index: 0,
                    number: 1
                },
            ]
        );
    }

    #[test]
    fn empty_and_punctuation_queries_match_everything() {
        assert_eq!(build(&["one", "two"], "").order.len(), 2);
        assert_eq!(build(&["one", "two"], "!!!").order.len(), 2);
    }

    #[test]
    fn visible_clamps_to_the_row_list() {
        let rows = build(&["one", "two"], "");
        assert_eq!(rows.visible(1, 10).len(), 2);
        assert_eq!(rows.visible(99, 10).len(), 0);
        assert_eq!(rows.visible(0, 0).len(), 0);
    }

    /// The host owns view alignment. Debug builds make the internal bug loud;
    /// release builds take the `Self::default()` path instead of panicking.
    #[test]
    #[cfg(debug_assertions)]
    #[should_panic(expected = "search views must be aligned with todos")]
    fn misaligned_views_are_a_debug_assertion() {
        let list = todos(&["one"]);
        let views = Vec::new();
        let _ = ListModel::build(
            &list,
            &views,
            "",
            false,
            "2026-11-15".parse::<TodoDate>().expect("valid date"),
        );
    }
}
