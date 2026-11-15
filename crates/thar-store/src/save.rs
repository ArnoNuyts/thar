//! Whole-file saves with an external-edit guard.
//!
//! [`SaveGuard`] remembers the exact bytes this session last read or wrote.
//! Every save re-reads the target first: if it differs, the save is refused
//! instead of silently replacing an edit made by another program. This is the
//! CP7 "byte-compare against the current file shape" rule, implemented before
//! the write rather than after it.

use std::fs;
use std::path::{Path, PathBuf};

use thar_core::{MAX_TODOS, ReadLimits, Todo, serialize_file, validate_file_content};

use crate::atomic;
use crate::backup::{self, BackupPolicy};
use crate::error::StoreError;

/// What one save changed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Saved {
    /// Bytes written.
    pub bytes: usize,
    /// Backup path, when this save created the safety copy.
    pub backup: Option<PathBuf>,
}

/// A session's view of the todo file and its last known bytes.
#[derive(Debug)]
pub struct SaveGuard {
    path: PathBuf,
    last_bytes: Vec<u8>,
    policy: BackupPolicy,
    backed_up: bool,
}

impl SaveGuard {
    /// Open a guard for `path` with the current bytes as the baseline.
    ///
    /// A missing file starts with an empty baseline, so the first save creates
    /// it. The caller decides whether creating a missing file is allowed
    /// (`--write` only).
    ///
    /// # Errors
    ///
    /// Returns a [`StoreError::Io`] when the file exists but cannot be read.
    pub fn open(path: impl Into<PathBuf>, policy: BackupPolicy) -> Result<Self, StoreError> {
        let path = path.into();
        let last_bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(StoreError::io(&path, error)),
        };
        Ok(Self {
            path,
            last_bytes,
            policy,
            backed_up: policy == BackupPolicy::None,
        })
    }

    /// The file this guard writes.
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The bytes the guard last read or wrote.
    #[must_use]
    pub fn last_bytes(&self) -> &[u8] {
        &self.last_bytes
    }

    /// True when the safety copy has already been attempted this session.
    #[must_use]
    pub fn backed_up(&self) -> bool {
        self.backed_up
    }

    /// Serialize and atomically replace the file.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::ChangedOnDisk`] when the target no longer matches
    /// [`SaveGuard::last_bytes`], [`StoreError::Invalid`] when the text
    /// violates the file limits, and [`StoreError::Io`] for a filesystem
    /// failure. The target is untouched on every error.
    pub fn save(&mut self, todos: &[Todo]) -> Result<Saved, StoreError> {
        if todos.len() > MAX_TODOS {
            return Err(StoreError::TooManyTodos {
                count: todos.len(),
                limit: MAX_TODOS,
            });
        }

        let text = serialize_file(todos);
        validate_file_content(&text, &ReadLimits::DEFAULT)?;
        let bytes = text.into_bytes();

        match fs::read(&self.path) {
            Ok(current) if current != self.last_bytes => {
                return Err(StoreError::ChangedOnDisk {
                    path: self.path.clone(),
                });
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if !self.last_bytes.is_empty() {
                    return Err(StoreError::ChangedOnDisk {
                        path: self.path.clone(),
                    });
                }
            }
            Err(error) => return Err(StoreError::io(&self.path, error)),
        }

        let backup = if self.backed_up {
            None
        } else {
            let created = backup::create(&self.path, &self.last_bytes, self.policy)?;
            self.backed_up = true;
            created
        };

        atomic::write_atomic(&self.path, &bytes)
            .map_err(|error| StoreError::io(&self.path, error))?;

        let saved = Saved {
            bytes: bytes.len(),
            backup,
        };
        self.last_bytes = bytes;
        Ok(saved)
    }

    /// Forget the current baseline and reload it from disk.
    ///
    /// Returns the bytes now on disk and makes them the save baseline.
    ///
    /// # Errors
    ///
    /// Returns a [`StoreError::Io`] when the file cannot be read.
    pub fn reload(&mut self) -> Result<Vec<u8>, StoreError> {
        let bytes = fs::read(&self.path).map_err(|error| StoreError::io(&self.path, error))?;
        self.last_bytes = bytes.clone();
        Ok(bytes)
    }

    /// Adopt bytes the host has just read from disk as the save baseline.
    ///
    /// The file watcher reads a file once, decodes and parses those exact
    /// bytes, and then hands them here. Re-reading the path inside the guard
    /// would open a race in which the file changes again between the parse and
    /// the baseline, so the reload path passes the bytes it parsed instead.
    ///
    /// This does not write anything; a caller that passes bytes which are not
    /// the current file content would defeat the external-edit guard.
    pub fn set_baseline(&mut self, bytes: Vec<u8>) {
        self.last_bytes = bytes;
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
        let mut guard = SaveGuard::open(&path, BackupPolicy::Bak).expect("guard");

        let saved = guard.save(&todos(&["new"])).expect("save");
        assert_eq!(saved.bytes, 4);
        assert!(saved.backup.is_some());
        assert_eq!(std::fs::read(&path).expect("read"), b"new\n");
        assert_eq!(guard.last_bytes(), b"new\n");

        // A second save is allowed because the guard has the new baseline.
        guard.save(&todos(&["newer"])).expect("save again");
    }

    #[test]
    fn refuses_an_external_edit_and_leaves_it_untouched() {
        let directory = temp_dir("guard-changed");
        let path = directory.join("todo.txt");
        std::fs::write(&path, b"old\n").expect("seed");
        let mut guard = SaveGuard::open(&path, BackupPolicy::None).expect("guard");

        std::fs::write(&path, b"external\n").expect("external edit");
        let error = guard.save(&todos(&["mine"])).expect_err("refused");
        assert!(matches!(error, StoreError::ChangedOnDisk { .. }));
        assert_eq!(std::fs::read(&path).expect("read"), b"external\n");
    }

    #[test]
    fn refuses_a_deleted_file_after_the_first_read() {
        let directory = temp_dir("guard-deleted");
        let path = directory.join("todo.txt");
        std::fs::write(&path, b"old\n").expect("seed");
        let mut guard = SaveGuard::open(&path, BackupPolicy::None).expect("guard");
        std::fs::remove_file(&path).expect("delete");

        let error = guard.save(&todos(&["mine"])).expect_err("refused");
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
