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
//! # Example
//!
//! ```
//! use thar_core::{NONE_CONTEXT, Row, Todo, TodoId, create_rows};
//!
//! let todos = vec![
//!     Todo::parse_line("one @home", TodoId::new(0)),
//!     Todo::parse_line("two", TodoId::new(1)),
//! ];
//! let rows = create_rows(todos.iter());
//! assert_eq!(
//!     rows,
//!     vec![
//!         Row::Context { name: "home", todo_count: 1 },
//!         Row::Todo { todo: &todos[0], number: 1 },
//!         Row::Context { name: NONE_CONTEXT, todo_count: 1 },
//!         Row::Todo { todo: &todos[1], number: 2 },
//!     ]
//! );
//! ```

use crate::model::{Todo, TodoId};

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
#[must_use]
pub fn create_rows<'a>(todos: impl IntoIterator<Item = &'a Todo>) -> Vec<Row<'a>> {
    let mut rows: Vec<Row<'a>> = Vec::new();
    // `Some(Some(name))` is a named group, `Some(None)` the uncategorised one,
    // and the outer `None` means no group has started yet.
    let mut group: Option<Option<&'a str>> = None;
    let mut header = 0;

    for (number, todo) in todos.into_iter().enumerate() {
        let context = todo.contexts.first().map(String::as_str);

        if group != Some(context) {
            rows.push(Row::Context {
                name: context.unwrap_or(NONE_CONTEXT),
                todo_count: 0,
            });
            header = rows.len() - 1;
            group = Some(context);
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

#[cfg(test)]
mod tests {
    use super::{NONE_CONTEXT, Row, create_rows};
    use crate::model::{Todo, TodoId};

    fn todos(lines: &[&str]) -> Vec<Todo> {
        lines
            .iter()
            .enumerate()
            .map(|(index, line)| Todo::parse_line(line, TodoId::new(index as u64)))
            .collect()
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
}
