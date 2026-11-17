//! Errors from the write path.
//!
//! Every error is bounded and content-free: a save failure is shown in the
//! action bar, so it must not include todo text. Paths and operating-system
//! messages are allowed because they are what a user needs to fix the problem.

use std::io;
use std::path::PathBuf;

/// Why a save, backup or archive operation failed.
#[derive(Debug)]
pub enum StoreError {
    /// A filesystem operation failed.
    Io {
        /// The path the operation touched.
        path: PathBuf,
        /// The underlying operating-system error.
        source: io::Error,
    },
    /// The file on disk no longer matches the bytes this session last read or
    /// wrote, so saving would overwrite an external edit.
    ChangedOnDisk {
        /// The file that changed.
        path: PathBuf,
    },
    /// The serialized file violates the read limits (line count, line length,
    /// or a rejected control character).
    Invalid(thar_core::CoreError),
    /// Writing the whole list would exceed the in-memory todo limit.
    TooManyTodos {
        /// The number of todos that would have been written.
        count: usize,
        /// The limit.
        limit: usize,
    },
}

impl StoreError {
    /// Wrap an I/O error with the path it touched.
    pub(crate) fn io(path: impl Into<PathBuf>, source: io::Error) -> Self {
        Self::Io {
            path: path.into(),
            source,
        }
    }
}

impl core::fmt::Display for StoreError {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Io { path, source } => {
                write!(formatter, "{}: {source}", path.display())
            }
            Self::ChangedOnDisk { path } => write!(
                formatter,
                "{} changed on disk; refusing to overwrite it",
                path.display()
            ),
            Self::Invalid(error) => write!(formatter, "{error}"),
            Self::TooManyTodos { count, limit } => write!(
                formatter,
                "Too many todos to write ({count}); the limit is {limit}"
            ),
        }
    }
}

impl std::error::Error for StoreError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            _ => None,
        }
    }
}

impl From<thar_core::CoreError> for StoreError {
    fn from(error: thar_core::CoreError) -> Self {
        Self::Invalid(error)
    }
}
