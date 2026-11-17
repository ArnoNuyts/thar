//! Read-only file loading with the app's existing limits.
//!
//! CP6 must never create or modify the todo file, so this module only reads
//! metadata and bytes. A missing path is an empty in-memory list plus one
//! bounded note, not a created file (a deliberate divergence from the Ink
//! app's "create on first run", which would need a write).
//!
//! The byte limit is checked against the on-disk size before the file is read
//! and again against the decoded text, matching `readTodosFromFile` in
//! `logic/todo-file-helpers.ts`. Line count, line length and control
//! characters are enforced by [`thar_core::parse_file`] with the same typed
//! errors the Ink app maps to `TodoFileValidationError`. Decoding is lossy, so
//! invalid UTF-8 becomes `U+FFFD`, exactly like `String::from_utf8_lossy` on
//! the Node side.

use std::fs::File;
use std::io::{self, Read};
use std::path::Path;

use thar_core::{CoreError, ReadLimits, Todo, parse_file, validate_file_bytes};

/// Environment variable names, matching `logic/limits.ts`.
const MAX_FILE_BYTES: &str = "THAR_MAX_FILE_BYTES";
const MAX_READ_TODOS: &str = "THAR_MAX_READ_TODOS";
const MAX_LINE_CHARS: &str = "THAR_MAX_LINE_CHARS";

/// Largest integer the TypeScript parser accepts (`Number.MAX_SAFE_INTEGER`).
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// The note shown when the todo file does not exist.
const MISSING_FILE_NOTE: &str = "Todo file not found; the read-only build will not create it.";

/// Why a file could not be loaded.
#[derive(Debug)]
pub enum LoadError {
    /// The file is too large, has too many lines, or contains a rejected
    /// character.
    Validation(CoreError),
    /// An environment override was not a positive integer.
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

/// Read and parse `path` read-only with the environment's limits.
///
/// # Errors
///
/// Returns [`LoadError`] for a real read failure, an invalid limit override,
/// or a file that violates the read limits. A missing file is not an error: it
/// returns an empty list and a note.
pub fn load(path: &Path) -> Result<LoadedFile, LoadError> {
    let limits = get_read_limits()?;
    load_with_limits(path, &limits)
}

/// Read and parse `path` read-only with explicit limits (tests and hosts).
///
/// # Errors
///
/// See [`load`].
pub fn load_with_limits(path: &Path, limits: &ReadLimits) -> Result<LoadedFile, LoadError> {
    match read_bytes(path, limits) {
        Ok(bytes) => Ok(LoadedFile {
            todos: parse_bytes(&bytes, limits)?,
            error: None,
        }),
        Err(LoadError::Io(error)) if error.kind() == io::ErrorKind::NotFound => Ok(missing_file()),
        Err(error) => Err(error),
    }
}

/// Read the bytes of `path`, enforcing the byte limit, without decoding.
///
/// The reload path uses this so it can hold the exact bytes it parsed and make
/// them the [`thar_store::SaveGuard`] baseline; [`load_with_limits`] is this
/// plus [`parse_bytes`]. A missing file stays an error here: unlike the initial
/// load, a delete after startup must not silently become an empty list.
///
/// # Errors
///
/// Returns [`LoadError::Io`] for a read failure and [`LoadError::Validation`]
/// when the file is larger than `limits.max_file_bytes`.
pub fn read_bytes(path: &Path, limits: &ReadLimits) -> Result<Vec<u8>, LoadError> {
    let mut file = File::open(path).map_err(LoadError::Io)?;

    // Read one byte past the limit instead of trusting `metadata().len()`: a
    // FIFO or a growing file reports a small (or zero) length, and a stat ->
    // read race must not turn into an unbounded allocation. `take` caps the
    // buffer even when the file keeps growing underneath us.
    let limit = limits.max_file_bytes;
    let mut bytes = Vec::new();
    file.by_ref()
        .take(limit.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(LoadError::Io)?;

    if bytes.len() as u64 > limit {
        // Report the real size when the file's metadata can still tell it;
        // otherwise the capped length is the only bound available.
        let actual = file
            .metadata()
            .map(|metadata| metadata.len())
            .unwrap_or(bytes.len() as u64)
            .max(bytes.len() as u64);
        return Err(CoreError::FileTooLarge {
            actual_bytes: actual,
            max_bytes: limit,
        }
        .into());
    }

    validate_file_bytes(bytes.len() as u64, limits)?;
    Ok(bytes)
}

/// Decode and parse bytes read from a todo file.
///
/// Decoding is lossy, so invalid UTF-8 becomes `U+FFFD`, exactly like
/// `String::from_utf8_lossy` on the Node side. The byte limit is checked again
/// against the decoded text, because a lossy decode can grow past the on-disk
/// byte count and `Buffer.byteLength(data, "utf8")` in the TypeScript reader
/// measures the decoded text.
///
/// # Errors
///
/// Returns [`LoadError::Validation`] for a byte/line/character limit violation.
pub fn parse_bytes(bytes: &[u8], limits: &ReadLimits) -> Result<Vec<Todo>, LoadError> {
    validate_file_bytes(bytes.len() as u64, limits)?;

    let text = String::from_utf8_lossy(bytes);

    // `Buffer.byteLength(data, "utf8")` in the TypeScript reader measures the
    // decoded text, so a lossy decode can grow past the on-disk byte count.
    validate_file_bytes(text.len() as u64, limits)?;

    Ok(parse_file(&text, limits)?)
}

fn missing_file() -> LoadedFile {
    LoadedFile {
        todos: Vec::new(),
        error: Some(MISSING_FILE_NOTE.to_owned()),
    }
}

/// Resolve the read limits from the process environment.
///
/// The names and defaults match `logic/limits.ts`. An invalid override is
/// fatal, exactly like the TypeScript `InvalidLimitError`; the caller maps
/// [`LoadError::InvalidLimit`] to exit code 2 rather than silently falling
/// back to a default the user did not ask for.
///
/// # Errors
///
/// Returns [`LoadError::InvalidLimit`] for the first override that is not a
/// positive safe integer.
pub fn get_read_limits() -> Result<ReadLimits, LoadError> {
    read_limits_from(|name| {
        std::env::var_os(name).map(|value| value.to_string_lossy().into_owned())
    })
}

/// Resolve the read limits from an arbitrary variable lookup.
///
/// `lookup` returns the raw value for a name, or `None` when it is unset.
/// Tests use this to pin the parser without mutating the process environment.
///
/// # Errors
///
/// Returns [`LoadError::InvalidLimit`] for the first override that is not a
/// positive safe integer.
pub fn read_limits_from<F>(lookup: F) -> Result<ReadLimits, LoadError>
where
    F: Fn(&str) -> Option<String>,
{
    let max_file_bytes = parse_limit(&lookup, MAX_FILE_BYTES, ReadLimits::DEFAULT.max_file_bytes)?;
    let max_read_todos = parse_limit(
        &lookup,
        MAX_READ_TODOS,
        ReadLimits::DEFAULT.max_read_todos as u64,
    )?;
    let max_line_chars = parse_limit(
        &lookup,
        MAX_LINE_CHARS,
        ReadLimits::DEFAULT.max_line_chars as u64,
    )?;

    Ok(ReadLimits {
        max_file_bytes,
        max_read_todos: usize::try_from(max_read_todos)
            .map_err(|_| LoadError::InvalidLimit(MAX_READ_TODOS))?,
        max_line_chars: usize::try_from(max_line_chars)
            .map_err(|_| LoadError::InvalidLimit(MAX_LINE_CHARS))?,
    })
}

fn parse_limit<F>(lookup: &F, name: &'static str, fallback: u64) -> Result<u64, LoadError>
where
    F: Fn(&str) -> Option<String>,
{
    let Some(raw) = lookup(name) else {
        return Ok(fallback);
    };

    // Deliberately avoid echoing the raw value: it is environment input and
    // may itself contain control characters.
    if !raw.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(LoadError::InvalidLimit(name));
    }

    let value = raw
        .parse::<u64>()
        .map_err(|_| LoadError::InvalidLimit(name))?;

    if value == 0 || value > MAX_SAFE_INTEGER {
        return Err(LoadError::InvalidLimit(name));
    }

    Ok(value)
}
