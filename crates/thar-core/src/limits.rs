//! Read-path limits.
//!
//! These values mirror `logic/limits.ts` exactly. They are policy, not I/O:
//! the host reads `THAR_MAX_FILE_BYTES`, `THAR_MAX_READ_TODOS`, and
//! `THAR_MAX_LINE_CHARS` and passes a [`ReadLimits`] in. Environment parsing
//! belongs to the caller so the core stays deterministic.

/// Maximum file size accepted by the reader, in bytes (1 MiB).
pub const DEFAULT_MAX_FILE_BYTES: u64 = 1024 * 1024;

/// Maximum number of todos accepted from one file.
pub const DEFAULT_MAX_READ_TODOS: usize = 10_000;

/// Maximum length of one read line, in UTF-16 code units.
///
/// UTF-16 code units are what `String.prototype.length` reports, so an emoji
/// counts as two. The Rust implementation must use `encode_utf16().count()`,
/// not bytes or `chars().count()`.
pub const DEFAULT_MAX_LINE_CHARS: usize = 8_192;

/// Maximum length of a single todo created or edited in the TUI, in UTF-16
/// code units. Smaller than the read limit on purpose: legacy overlong lines
/// stay loadable while new writes stay comfortable.
pub const MAX_TODO_CHARS: usize = 2_000;

/// Maximum number of todos accepted from one paste.
pub const MAX_PASTE_TODOS: usize = 100;

/// Maximum number of todos kept in memory, derived from the read limit.
pub const MAX_TODOS: usize = DEFAULT_MAX_READ_TODOS;

/// Configurable read-path limits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReadLimits {
    /// Maximum accepted file size in bytes.
    pub max_file_bytes: u64,
    /// Maximum accepted physical line count.
    pub max_read_todos: usize,
    /// Maximum accepted line length in UTF-16 code units.
    pub max_line_chars: usize,
}

impl ReadLimits {
    /// The defaults used when no environment override is set.
    pub const DEFAULT: Self = Self {
        max_file_bytes: DEFAULT_MAX_FILE_BYTES,
        max_read_todos: DEFAULT_MAX_READ_TODOS,
        max_line_chars: DEFAULT_MAX_LINE_CHARS,
    };
}

impl Default for ReadLimits {
    fn default() -> Self {
        Self::DEFAULT
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_the_typescript_limits() {
        let limits = ReadLimits::default();
        assert_eq!(limits.max_file_bytes, 1_048_576);
        assert_eq!(limits.max_read_todos, 10_000);
        assert_eq!(limits.max_line_chars, 8_192);
        assert_eq!(MAX_TODOS, 10_000);
        assert_eq!(MAX_TODO_CHARS, 2_000);
        assert_eq!(MAX_PASTE_TODOS, 100);
    }
}
