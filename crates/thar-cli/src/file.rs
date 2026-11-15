//! Read-only file loading with the app's existing limits.
//!
//! CP6 must never create or modify the todo file, so this module only opens and
//! decodes it. A missing path is an empty in-memory list plus one bounded
//! message, not a created file (a deliberate divergence from the Ink app's
//! "create on first run", which would need a write).
//!
//! The byte limit is checked with [`thar_core::validate_file_bytes`] before the
//! text is parsed; line count, line length and control characters are enforced
//! by [`thar_core::parse_file`] with the same typed errors the Ink app maps to
//! `TodoFileValidationError`.

use std::fs;
use std::io;

use thar_core::{CoreError, ReadLimits, Todo, parse_file, validate_file_bytes};

/// Environment variable names, matching `logic/limits.ts`.
const MAX_FILE_BYTES: &str = "THAR_MAX_FILE_BYTES";
const MAX_READ_TODOS: &str = "THAR_MAX_READ_TODOS";
const MAX_LINE_CHARS: &str = "THAR_MAX_LINE_CHARS";

/// Why a file could not be loaded.
#[derive(Debug)]
pub enum LoadError {
    /// The file is too large, has too many lines, or contains a rejected
    /// character.
    Validation(CoreError),
    /// A positive-integer environment override was invalid.
    InvalidLimit(&'static str),
    /// The path could not be read.
    Io(io::Error),
}

impl core::fmt::Display for LoadError {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Validation(error) => write!(formatter, "{error}"),
            Self::InvalidLimit(name) => write!(
                formatter,
                "Invalid {name}: expected a positive integer. \
                 Fix the environment variable or unset it to use the default."
            ),
            Self::Io(error) => write!(formatter, "Cannot read the todo file: {error}"),
        }
    }
}

impl std::error::Error for LoadError {}

impl From<CoreError> for LoadError {
    fn from(error: CoreError) -> Self {
        Self::Validation(error)
    }
}

/// A loaded file plus an optional non-fatal note (a missing path).
#[derive(Debug)]
pub struct LoadedFile {
    /// Parsed todos in load order.
    pub todos: Vec<Todo>,
    /// A bounded message to show in the TUI, if the file was absent.
    pub error: Option<String>,
}

/// Read and parse `path` read-only.
///
/// # Errors
///
/// Returns [`LoadError`] for a real read failure or a file that violates the
/// read limits. A missing file is not an error: it returns an empty list and a
/// note.
pub fn load(path: &str) -> Result<LoadedFile, LoadError> {
    load_with_limits(path, &get_read_limits())
}

/// Read and parse `path` with explicit limits (tests and the CLI env override).
///
/// # Errors
///
/// See [`load`].
pub fn load_with_limits(path: &str, limits: &ReadLimits) -> Result<LoadedFile, LoadError> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(LoadedFile {
                todos: Vec::new(),
                error: Some(format!(
                    "{path} not found; the read-only build will not create it"
                )),
            });
        }
        Err(error) => return Err(LoadError::Io(error)),
    };

    validate_file_bytes(bytes.len() as u64, limits)?;
    let text = String::from_utf8_lossy(&bytes);
    let todos = parse_file(&text, limits)?;

    Ok(LoadedFile { todos, error: None })
}

/// Resolve the read limits from the environment, validating every override.
///
/// An invalid override falls back to the default rather than refusing to start:
/// a TUI that dies over an environment typo is worse than one that starts with
/// the documented limits. The names and defaults match `logic/limits.ts`.
#[must_use]
pub fn get_read_limits() -> ReadLimits {
    ReadLimits {
        max_file_bytes: positive_env(MAX_FILE_BYTES).unwrap_or(ReadLimits::DEFAULT.max_file_bytes),
        max_read_todos: usize::try_from(
            positive_env(MAX_READ_TODOS).unwrap_or(ReadLimits::DEFAULT.max_read_todos as u64),
        )
        .unwrap_or(ReadLimits::DEFAULT.max_read_todos),
        max_line_chars: usize::try_from(
            positive_env(MAX_LINE_CHARS).unwrap_or(ReadLimits::DEFAULT.max_line_chars as u64),
        )
        .unwrap_or(ReadLimits::DEFAULT.max_line_chars),
    }
}

fn positive_env(name: &str) -> Option<u64> {
    let raw = std::env::var(name).ok()?;
    if raw.is_empty() || !raw.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    raw.parse::<u64>().ok().filter(|value| *value > 0)
}

#[cfg(test)]
mod tests {
    use super::{LoadError, get_read_limits, load, load_with_limits};
    use std::io::Write;
    use thar_core::ReadLimits;

    fn temp_file(name: &str, content: &[u8]) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("thar-cp6-{name}-{}.txt", std::process::id()));
        let mut file = std::fs::File::create(&path).expect("create temp file");
        file.write_all(content).expect("write temp file");
        path
    }

    #[test]
    fn parses_a_file_and_keeps_load_order() {
        let path = temp_file("basic", b"one\n\nthree\n");
        let loaded = load(path.to_str().expect("utf-8 path")).expect("load");
        assert_eq!(loaded.todos.len(), 2);
        assert_eq!(loaded.todos[0].text, "one");
        assert_eq!(loaded.todos[1].text, "three");
        assert!(loaded.error.is_none());
        assert_eq!(loaded.todos[0].id.value(), 0);
        assert_eq!(loaded.todos[1].id.value(), 1);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn a_missing_file_is_not_created() {
        let path =
            std::env::temp_dir().join(format!("thar-cp6-missing-{}.txt", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let loaded = load(path.to_str().expect("utf-8 path")).expect("load");
        assert!(loaded.todos.is_empty());
        assert!(loaded.error.is_some());
        assert!(!path.exists());
    }

    #[test]
    fn invalid_utf8_is_lossily_decoded() {
        let path = temp_file("invalid", b"one \xFF two\n");
        let loaded = load(path.to_str().expect("utf-8 path")).expect("load");
        assert_eq!(loaded.todos.len(), 1);
        assert!(loaded.todos[0].text.contains('\u{FFFD}'));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn byte_limit_is_enforced_before_parsing() {
        let path = temp_file("limit", b"0123456789\n");
        let limits = ReadLimits {
            max_file_bytes: 4,
            ..ReadLimits::DEFAULT
        };
        match load_with_limits(path.to_str().expect("utf-8 path"), &limits) {
            Err(LoadError::Validation(error)) => {
                assert_eq!(error.code(), "FILE_TOO_LARGE");
            }
            other => panic!("expected a validation error, got {other:?}"),
        }
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn extra_lines_are_fatal_before_the_tui_starts() {
        let path = temp_file("lines", b"one\ntwo\nthree\n");
        let limits = ReadLimits {
            max_read_todos: 2,
            ..ReadLimits::DEFAULT
        };
        match load_with_limits(path.to_str().expect("utf-8 path"), &limits) {
            Err(LoadError::Validation(error)) => assert_eq!(error.code(), "TOO_MANY_LINES"),
            other => panic!("expected a validation error, got {other:?}"),
        }
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn limits_default_to_the_shared_values() {
        for name in [
            "THAR_MAX_FILE_BYTES",
            "THAR_MAX_READ_TODOS",
            "THAR_MAX_LINE_CHARS",
        ] {
            // The test runner's environment is not expected to set these; if it
            // does, the assertion only needs to stay within the same defaults
            // contract.
            if std::env::var(name).is_err() {
                let limits = get_read_limits();
                assert_eq!(limits.max_file_bytes, ReadLimits::DEFAULT.max_file_bytes);
                assert_eq!(limits.max_read_todos, ReadLimits::DEFAULT.max_read_todos);
                assert_eq!(limits.max_line_chars, ReadLimits::DEFAULT.max_line_chars);
            }
        }
    }
}
