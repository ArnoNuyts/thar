//! Whole-file saves with an external-edit guard.
//!
//! [`SaveGuard`] compares every save against the bytes the caller last
//! accepted. The file watcher owns that baseline: if the target no longer
//! matches it, the save is refused instead of silently replacing an edit made
//! by another program. This is the CP7 "byte-compare against the current file
//! shape" rule, implemented before the write rather than after it.

use std::fs;
use std::path::{Path, PathBuf};

use thar_core::{MAX_TODOS, ReadLimits, Todo, serialize_file, validate_file_content};

use crate::atomic;
use crate::backup::{self, BackupPolicy};
use crate::error::StoreError;

/// A session's write path to the todo file.
#[derive(Debug)]
pub struct SaveGuard {
    path: PathBuf,
    policy: BackupPolicy,
    backed_up: bool,
}

impl SaveGuard {
    /// Create a guard for `path`.
    ///
    /// This does no I/O. The baseline is supplied by the caller on every save,
    /// because the file watcher already reads the file and owns the accepted
    /// bytes. The caller decides whether creating a missing file is allowed
    /// (`--write` only).
    #[must_use]
    pub fn new(path: impl Into<PathBuf>, policy: BackupPolicy) -> Self {
        Self {
            path: path.into(),
            policy,
            backed_up: policy == BackupPolicy::None,
        }
    }

    /// Serialize and atomically replace the file.
    ///
    /// The argument is any `ExactSizeIterator` of `&Todo`, so a caller that
    /// shares todos through `Rc<Todo>` can save without cloning the values and
    /// the capacity check does not need a second collection.
    ///
    /// `expected` is the accepted baseline owned by the file watcher. A target
    /// that differs from it (including a file deleted after a non-empty
    /// baseline) refuses the save.
    ///
    /// Returns the bytes written, so the caller can adopt them as the new
    /// baseline without a second read.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::ChangedOnDisk`] when the target no longer matches
    /// `expected`, [`StoreError::Invalid`] when the text violates the file
    /// limits, and [`StoreError::Io`] for a filesystem failure. The target is
    /// untouched on every error.
    pub fn save<'a>(
        &mut self,
        todos: impl ExactSizeIterator<Item = &'a Todo>,
        expected: &[u8],
    ) -> Result<Vec<u8>, StoreError> {
        if todos.len() > MAX_TODOS {
            return Err(StoreError::TooManyTodos {
                count: todos.len(),
                limit: MAX_TODOS,
            });
        }

        let text = serialize_file(todos);
        validate_file_content(&text, &ReadLimits::DEFAULT)?;
        let bytes = text.into_bytes();

        let current = match fs::read(&self.path) {
            Ok(current) => current,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(StoreError::io(&self.path, error)),
        };
        if current != expected {
            return Err(StoreError::ChangedOnDisk {
                path: self.path.clone(),
            });
        }

        if !self.backed_up {
            backup::create(&self.path, &current, self.policy)?;
            self.backed_up = true;
        }

        atomic::write_atomic(&self.path, &bytes)
            .map_err(|error| StoreError::io(&self.path, error))?;

        Ok(bytes)
    }
}

/// Create an empty todo file if it does not exist.
///
/// The Ink app creates a missing file during normal startup; CP7 restores that
/// behaviour only when `--write` is passed.
///
/// # Errors
///
/// Returns a [`StoreError::Io`] when the file cannot be created.
pub fn ensure_file(path: &Path) -> Result<(), StoreError> {
    if path.exists() {
        return Ok(());
    }
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map(|_| ())
        .map_err(|error| StoreError::io(path, error))
}

#[cfg(test)]
mod tests {
    use super::{SaveGuard, ensure_file};
    use crate::backup::BackupPolicy;
    use crate::error::StoreError;
    use crate::test_support::temp_dir;
    use thar_core::{Todo, TodoId};

    fn todos(lines: &[&str]) -> Vec<Todo> {
        lines
            .iter()
            .enumerate()
            .map(|(index, line)| Todo::parse_line(line, TodoId::new(index as u64)))
            .collect()
    }

    #[test]
    fn saves_bytes_and_updates_the_baseline() {
        let directory = temp_dir("guard-save");
        let path = directory.join("todo.txt");
        std::fs::write(&path, b"old\n").expect("seed");
        let mut guard = SaveGuard::new(&path, BackupPolicy::Bak);

        let written = guard.save(todos(&["new"]).iter(), b"old\n").expect("save");
        assert_eq!(written, b"new\n");
        assert!(crate::backup::backup_path(&path).exists());
        assert_eq!(std::fs::read(&path).expect("read"), b"new\n");

        // A second save is allowed when it passes the bytes the caller adopted.
        guard
            .save(todos(&["newer"]).iter(), &written)
            .expect("save again");
        assert_eq!(std::fs::read(&path).expect("read"), b"newer\n");
    }

    #[test]
    fn refuses_an_external_edit_and_leaves_it_untouched() {
        let directory = temp_dir("guard-changed");
        let path = directory.join("todo.txt");
        std::fs::write(&path, b"old\n").expect("seed");
        let mut guard = SaveGuard::new(&path, BackupPolicy::None);

        std::fs::write(&path, b"external\n").expect("external edit");
        let error = guard
            .save(todos(&["mine"]).iter(), b"old\n")
            .expect_err("refused");
        assert!(matches!(error, StoreError::ChangedOnDisk { .. }));
        assert_eq!(std::fs::read(&path).expect("read"), b"external\n");
    }

    #[test]
    fn refuses_a_deleted_file_after_the_first_read() {
        let directory = temp_dir("guard-deleted");
        let path = directory.join("todo.txt");
        std::fs::write(&path, b"old\n").expect("seed");
        let mut guard = SaveGuard::new(&path, BackupPolicy::None);
        std::fs::remove_file(&path).expect("delete");

        let error = guard
            .save(todos(&["mine"]).iter(), b"old\n")
            .expect_err("refused");
        assert!(matches!(error, StoreError::ChangedOnDisk { .. }));
        assert!(!path.exists());
    }

    #[test]
    fn ensure_file_creates_once_and_keeps_content() {
        let directory = temp_dir("guard-ensure");
        let path = directory.join("todo.txt");
        ensure_file(&path).expect("create");
        std::fs::write(&path, b"keep\n").expect("write");
        ensure_file(&path).expect("existing");
        assert_eq!(std::fs::read(&path).expect("read"), b"keep\n");
    }
}
