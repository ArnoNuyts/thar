//! Typed, bounded domain errors.
//!
//! Messages are user-facing and must match `logic/limits.ts` exactly: they
//! carry counts, line numbers, lengths, and `U+XXXX` code points only. Todo
//! content never appears in a message because these strings are shown in the
//! TUI and may be logged.

use core::fmt;

/// Format a code point as `U+XXXX`, at least four uppercase hex digits.
fn format_code_point(code_point: u32) -> String {
    format!("U+{code_point:04X}")
}

/// A rejected file, line, or limit.
///
/// The variants mirror the four `TodoFileValidationError` subclasses in
/// `logic/limits.ts`. `code` is the stable machine-readable code and `name`
/// matches the TypeScript class name so the corpus can assert both.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CoreError {
    /// The file is larger than `max_file_bytes` (`FILE_TOO_LARGE`).
    FileTooLarge {
        /// Byte length of the file or decoded text.
        actual_bytes: u64,
        /// Configured maximum in bytes.
        max_bytes: u64,
    },
    /// The file has more physical lines than `max_read_todos`
    /// (`TOO_MANY_LINES`).
    TooManyLines {
        /// Physical line count (a trailing newline does not add a line).
        line_count: usize,
        /// Configured maximum number of lines.
        max_read_todos: usize,
    },
    /// One line exceeds `max_line_chars` UTF-16 code units (`LINE_TOO_LONG`).
    LineTooLong {
        /// 1-based line number.
        line_number: usize,
        /// Line length in UTF-16 code units, matching `String.prototype.length`.
        length: usize,
        /// Configured maximum in UTF-16 code units.
        max_line_chars: usize,
    },
    /// A line contains a rejected control code point (`CONTROL_CHARACTER`).
    ControlCharacter {
        /// 1-based line number.
        line_number: usize,
        /// The rejected Unicode scalar value.
        code_point: u32,
    },
}

impl CoreError {
    /// Stable machine-readable error code, identical to the TS `code` field.
    pub const fn code(&self) -> &'static str {
        match self {
            Self::FileTooLarge { .. } => "FILE_TOO_LARGE",
            Self::TooManyLines { .. } => "TOO_MANY_LINES",
            Self::LineTooLong { .. } => "LINE_TOO_LONG",
            Self::ControlCharacter { .. } => "CONTROL_CHARACTER",
        }
    }

    /// TypeScript class name, used by the corpus expectations.
    pub const fn name(&self) -> &'static str {
        match self {
            Self::FileTooLarge { .. } => "TodoFileTooLargeError",
            Self::TooManyLines { .. } => "TodoLineCountLimitError",
            Self::LineTooLong { .. } => "TodoLineLengthLimitError",
            Self::ControlCharacter { .. } => "TodoControlCharacterError",
        }
    }
}

impl fmt::Display for CoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::FileTooLarge {
                actual_bytes,
                max_bytes,
            } => write!(
                f,
                "Todo file is {actual_bytes} bytes; the limit is {max_bytes} bytes. \
                 Trim the file or raise THAR_MAX_FILE_BYTES. Nothing was changed."
            ),
            Self::TooManyLines {
                line_count,
                max_read_todos,
            } => write!(
                f,
                "Todo file has {line_count} lines; the limit is {max_read_todos}. \
                 Trim the file or raise THAR_MAX_READ_TODOS. Nothing was changed."
            ),
            Self::LineTooLong {
                line_number,
                length,
                max_line_chars,
            } => write!(
                f,
                "Todo file line {line_number} is {length} characters; the limit is \
                 {max_line_chars}. Shorten the line or raise THAR_MAX_LINE_CHARS. \
                 Nothing was changed."
            ),
            Self::ControlCharacter {
                line_number,
                code_point,
            } => write!(
                f,
                "Todo file line {line_number} contains the control character {}. \
                 Remove control characters from the file. Nothing was changed.",
                format_code_point(*code_point)
            ),
        }
    }
}

impl std::error::Error for CoreError {}

#[cfg(test)]
mod tests {
    use super::CoreError;

    #[test]
    fn messages_match_the_typescript_oracle() {
        assert_eq!(
            CoreError::FileTooLarge {
                actual_bytes: 2_000_000,
                max_bytes: 1_048_576,
            }
            .to_string(),
            "Todo file is 2000000 bytes; the limit is 1048576 bytes. \
             Trim the file or raise THAR_MAX_FILE_BYTES. Nothing was changed."
        );
        assert_eq!(
            CoreError::TooManyLines {
                line_count: 10_001,
                max_read_todos: 10_000,
            }
            .to_string(),
            "Todo file has 10001 lines; the limit is 10000. \
             Trim the file or raise THAR_MAX_READ_TODOS. Nothing was changed."
        );
        assert_eq!(
            CoreError::LineTooLong {
                line_number: 7,
                length: 8_193,
                max_line_chars: 8_192,
            }
            .to_string(),
            "Todo file line 7 is 8193 characters; the limit is 8192. \
             Shorten the line or raise THAR_MAX_LINE_CHARS. Nothing was changed."
        );
        assert_eq!(
            CoreError::ControlCharacter {
                line_number: 2,
                code_point: 0x0d,
            }
            .to_string(),
            "Todo file line 2 contains the control character U+000D. \
             Remove control characters from the file. Nothing was changed."
        );
        assert_eq!(
            CoreError::ControlCharacter {
                line_number: 1,
                code_point: 0x1b,
            }
            .to_string(),
            "Todo file line 1 contains the control character U+001B. \
             Remove control characters from the file. Nothing was changed."
        );
    }

    #[test]
    fn codes_and_names_follow_the_ts_classes() {
        let cases = [
            (
                CoreError::FileTooLarge {
                    actual_bytes: 1,
                    max_bytes: 0,
                },
                "FILE_TOO_LARGE",
                "TodoFileTooLargeError",
            ),
            (
                CoreError::TooManyLines {
                    line_count: 1,
                    max_read_todos: 0,
                },
                "TOO_MANY_LINES",
                "TodoLineCountLimitError",
            ),
            (
                CoreError::LineTooLong {
                    line_number: 1,
                    length: 1,
                    max_line_chars: 0,
                },
                "LINE_TOO_LONG",
                "TodoLineLengthLimitError",
            ),
            (
                CoreError::ControlCharacter {
                    line_number: 1,
                    code_point: 0,
                },
                "CONTROL_CHARACTER",
                "TodoControlCharacterError",
            ),
        ];
        for (error, code, name) in cases {
            assert_eq!(error.code(), code);
            assert_eq!(error.name(), name);
        }
    }

    #[test]
    fn code_points_are_at_least_four_hex_digits() {
        let error = CoreError::ControlCharacter {
            line_number: 1,
            code_point: 0x85,
        };
        assert!(error.to_string().contains("U+0085"));
    }
}
