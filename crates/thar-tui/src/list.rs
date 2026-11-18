//! The owned row model the TUI renders and navigates.
//!
//! `thar_core::build_rows` returns rows that borrow the todos
//! ([`thar_core::Row`]). A long-lived `App` cannot store those, and rebuilding
//! them every frame would put the sort on the render path. [`ListModel`]
//! therefore owns a row list of indices into `App`'s load-order todo list: it is
//! rebuilt only when the query, hidden-view toggle, today, or the todo list
//! changes.
//!
//! The row semantics are CP3b1's, unchanged: context headers (including the
//! `"None"` group) are rows, todo numbers are 1-based across the whole list, and
//! consecutive todos with the same first context form one group.

use std::borrow::Borrow;

use thar_core::{OwnedSearchView, Row, RowError, Rows, Todo, TodoDate, build_rows};

use crate::entry::TodoEntry;

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
        /// Index into the app's load-order todo list.
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

/// The owned row list.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ListModel {
    /// The complete row list, headers included.
    pub rows: Vec<ListRow>,
}

impl ListModel {
    /// Build the row list from a separate todo slice and its cached views.
    ///
    /// [`crate::app::App`] builds rows through [`ListModel::from_entries`],
    /// where one entry supplies both halves. This entry point exists for the
    /// row-parity tests, which compare that path against two slices.
    ///
    /// `query` is normalized inside the call (one allocation per keystroke).
    ///
    /// `todos` may be any slice of values that borrow a [`Todo`].
    ///
    /// # Errors
    ///
    /// Returns [`RowError::ViewCountMismatch`] when `views` is not aligned with
    /// `todos`. A misalignment means at least one row would point at a foreign
    /// view, so no row is produced instead of a silently truncated list.
    #[doc(hidden)]
    pub fn build<T: Borrow<Todo>>(
        todos: &[T],
        views: &[OwnedSearchView],
        query: &str,
        show_hidden: bool,
        today: TodoDate,
    ) -> Result<Self, RowError> {
        let terms = crate::search::extract_search_terms(query);
        let rows = build_rows(todos, views, &terms, show_hidden, today)?;
        Ok(Self::from_rows(rows))
    }

    /// Build the row list from the app's one-entry-per-todo list.
    ///
    /// One [`TodoEntry`] supplies both the todo (`Borrow<Todo>`) and its cached
    /// search view (`SearchViewLike`), and the *same* slice is handed to
    /// [`build_rows`] for both roles. The view count therefore cannot disagree
    /// with the todo count: alignment is structural, not an invariant the caller
    /// has to maintain, which is why this constructor needs no error case.
    #[must_use]
    pub(crate) fn from_entries(
        entries: &[TodoEntry],
        query: &str,
        show_hidden: bool,
        today: TodoDate,
    ) -> Self {
        let terms = crate::search::extract_search_terms(query);
        let rows = build_rows(entries, entries, &terms, show_hidden, today)
            .expect("one entry supplies both the todo and its search view");
        Self::from_rows(rows)
    }

    /// Map the borrowed core rows onto the owned row list.
    fn from_rows(rows: Rows<'_>) -> Self {
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

        Self { rows: owned }
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
    use crate::entry::TodoEntry;
    use crate::search::view_for;
    use thar_core::{RowError, Todo, TodoDate, TodoId};

    fn todos(lines: &[&str]) -> Vec<Todo> {
        lines
            .iter()
            .enumerate()
            .map(|(index, line)| Todo::parse_line(line, TodoId::new(index as u64)))
            .collect()
    }

    fn today() -> TodoDate {
        "2026-11-15".parse::<TodoDate>().expect("valid date")
    }

    fn build(lines: &[&str], query: &str) -> ListModel {
        let list = todos(lines);
        let views: Vec<_> = list.iter().map(view_for).collect();
        ListModel::build(&list, &views, query, false, today()).expect("aligned")
    }

    /// The todo indexes in row order, headers skipped.
    fn indexes(model: &ListModel) -> Vec<usize> {
        model.rows.iter().filter_map(ListRow::todo_index).collect()
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
        assert_eq!(indexes(&rows), [0]);
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
        assert_eq!(indexes(&build(&["one", "two"], "")).len(), 2);
        assert_eq!(indexes(&build(&["one", "two"], "!!!")).len(), 2);
    }

    #[test]
    fn visible_clamps_to_the_row_list() {
        let rows = build(&["one", "two"], "");
        assert_eq!(rows.visible(1, 10).len(), 2);
        assert_eq!(rows.visible(99, 10).len(), 0);
        assert_eq!(rows.visible(0, 0).len(), 0);
    }

    /// The one-entry-per-todo path must produce exactly the same rows as the
    /// separate-slices path for the same list and query.
    #[test]
    fn entries_build_the_same_rows_as_a_plain_pair() {
        let list = todos(&["one @home", "two", "three @home"]);
        let views: Vec<_> = list.iter().map(view_for).collect();
        let paired = ListModel::build(&list, &views, "  ", false, today()).expect("aligned");

        let entries: Vec<TodoEntry> = list.into_iter().map(TodoEntry::new).collect();
        let owned = ListModel::from_entries(&entries, "  ", false, today());
        assert_eq!(owned, paired);
    }

    /// A misaligned pair is rejected instead of quietly producing no rows: the
    /// old fallback could hide the whole list in release builds.
    #[test]
    fn misaligned_views_are_reported() {
        let list = todos(&["one"]);
        let views = Vec::new();
        let error = ListModel::build(&list, &views, "", false, today())
            .expect_err("one todo but no views must be rejected");
        assert_eq!(error, RowError::ViewCountMismatch { todos: 1, views: 0 });
    }
}
