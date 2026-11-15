//! Append completed todos to `done.txt`.
//!
//! The archive path is an append, not an atomic replace: `done.txt` is an
//! append-only log in the todo.txt convention. A failure leaves the in-memory
//! list unchanged because the caller removes the todos only after the append
//! succeeds.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;

use thar_core::{Todo, serialize_file};

use crate::error::StoreError;

/// Append `todos` to `path` as canonical `todo.txt` lines.
///
/// # Errors
///
/// Returns [`StoreError::Io`] when the file cannot be opened, written, or
/// synced.
pub fn append_done(path: &Path, todos: &[Todo]) -> Result<(), StoreError> {
    if todos.is_empty() {
        return Ok(());
    }

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| StoreError::io(path, error))?;

    let text = serialize_file(todos);
    file.write_all(text.as_bytes())
        .and_then(|()| file.sync_all())
        .map_err(|error| StoreError::io(path, error))
}

#[cfg(test)]
mod tests {
    use super::append_done;
    use crate::test_support::temp_dir;
    use thar_core::{Todo, TodoId};

    #[test]
    fn appends_canonical_lines_with_one_trailing_newline() {
        let directory = temp_dir("done-append");
        let path = directory.join("done.txt");
        let todos = vec![
            Todo::parse_line("x 2026-01-01 first", TodoId::new(0)),
            Todo::parse_line("x 2026-01-02 second", TodoId::new(1)),
        ];

        append_done(&path, &todos).expect("append");
        append_done(&path, &todos[..1]).expect("append again");
        assert_eq!(
            std::fs::read_to_string(&path).expect("read"),
            "x 2026-01-01 first\nx 2026-01-02 second\nx 2026-01-01 first\n"
        );
    }

    #[test]
    fn an_empty_batch_touches_nothing() {
        let directory = temp_dir("done-empty");
        let path = directory.join("done.txt");
        append_done(&path, &[]).expect("append");
        assert!(!path.exists());
    }
}
