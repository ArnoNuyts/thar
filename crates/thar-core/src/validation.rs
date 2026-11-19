//! File-level read validation, matching `logic/todo-file-validation.ts`.
//!
//! The reader works on decoded text: the host has already enforced the byte
//! size (and can call [`validate_file_bytes`] again after decoding). Decoding is
//! lossy on the Node side — `String::from_utf8_lossy`, so invalid bytes are
//! `U+FFFD` — and this module therefore only ever sees valid UTF-8. It checks
//! the physical line count, each line's length in UTF-16 code units, and the
//! rejected control characters. It also applies the CRLF rule: exactly one `\r`
//! is stripped from an LF-terminated line, while a `\r` at end-of-file or inside
//! a line is rejected.
//!
//! Blank lines are returned as-is; the loader filters them. Keeping them makes
//! line numbers in errors match the file, exactly like the TS implementation.

use crate::error::CoreError;
use crate::js::{find_unsafe_control, js_trim};
use crate::limits::ReadLimits;

/// True when a line contains nothing but JavaScript whitespace.
///
/// This is the loader's `line.trim()` filter: a file with only blank lines
/// loads as zero todos, and those lines do not get ids.
#[must_use]
pub fn is_blank_line(line: &str) -> bool {
    js_trim(line).is_empty()
}

/// Reject a file whose decoded byte length exceeds `max_file_bytes`.
///
/// The host checks the on-disk size before reading and calls this again with
/// the decoded length, because a file can grow between `stat` and `read`.
///
/// # Errors
///
/// Returns [`CoreError::FileTooLarge`] when `actual_bytes` is over
/// `limits.max_file_bytes`.
#[must_use = "the size check must be handled"]
pub fn validate_file_bytes(actual_bytes: u64, limits: &ReadLimits) -> Result<(), CoreError> {
    if actual_bytes > limits.max_file_bytes {
        return Err(CoreError::FileTooLarge {
            actual_bytes,
            max_bytes: limits.max_file_bytes,
        });
    }
    Ok(())
}

/// Validate raw file text and return one entry per physical line.
///
/// A trailing newline terminates the last line rather than starting a new one,
/// so `"a\n"` is one line and `"a\nb"` is two. The returned vector includes the
/// phantom empty entry produced by a trailing newline, matching
/// `String.prototype.split("\n")` in the oracle.
///
/// `data` must already be decoded text: the Node reader uses
/// `String::from_utf8_lossy`, so invalid UTF-8 arrives as `U+FFFD`. That keeps
/// the byte-size limit and the UTF-16 length limit meaningful for a lossy
/// decode, and it is why this function never rejects invalid UTF-8 itself.
///
/// # Errors
///
/// Returns [`CoreError::TooManyLines`], [`CoreError::LineTooLong`], or
/// [`CoreError::ControlCharacter`] for the first line that violates the
/// mirrored TypeScript policy.
#[must_use = "the validated lines must be used"]
pub fn validate_file_content<'a>(
    data: &'a str,
    limits: &ReadLimits,
) -> Result<Vec<&'a str>, CoreError> {
    let newline_count = data.bytes().filter(|byte| *byte == b'\n').count();
    let line_count = newline_count + usize::from(!data.is_empty() && !data.ends_with('\n'));

    if line_count > limits.max_read_todos {
        return Err(CoreError::TooManyLines {
            line_count,
            max_read_todos: limits.max_read_todos,
        });
    }

    let mut lines = data.split('\n').peekable();
    let mut normalized = Vec::with_capacity(line_count + 1);
    let mut line_number = 1;

    while let Some(raw_line) = lines.next() {
        // Strip exactly one CR from an LF-terminated line. A CR at end of file
        // has no matching LF and is therefore a bare CR.
        let is_lf_terminated = lines.peek().is_some();
        let line = if is_lf_terminated {
            raw_line.strip_suffix('\r').unwrap_or(raw_line)
        } else {
            raw_line
        };

        // `String.prototype.length` is UTF-16 code units, not bytes or chars.
        let length = line.encode_utf16().count();
        if length > limits.max_line_chars {
            return Err(CoreError::LineTooLong {
                line_number,
                length,
                max_line_chars: limits.max_line_chars,
            });
        }

        if let Some(code_point) = find_unsafe_control(line) {
            return Err(CoreError::ControlCharacter {
                line_number,
                code_point: u32::from(code_point),
            });
        }

        normalized.push(line);
        line_number += 1;
    }

    Ok(normalized)
}

#[cfg(test)]
mod tests {
    use super::{is_blank_line, validate_file_bytes, validate_file_content};
    use crate::error::CoreError;
    use crate::limits::ReadLimits;

    fn validate(data: &str) -> Result<Vec<&str>, CoreError> {
        validate_file_content(data, &ReadLimits::DEFAULT)
    }

    #[test]
    fn empty_file_is_one_blank_line() {
        assert_eq!(validate(""), Ok(vec![""]));
    }

    #[test]
    fn trailing_newline_terminates_instead_of_starting_a_line() {
        assert_eq!(validate("a\n"), Ok(vec!["a", ""]));
        assert_eq!(validate("a\nb"), Ok(vec!["a", "b"]));
        assert_eq!(validate("a\n\nb"), Ok(vec!["a", "", "b"]));
    }

    #[test]
    fn strips_one_cr_from_lf_terminated_lines() {
        assert_eq!(validate("a\r\nb\r\n"), Ok(vec!["a", "b", ""]));
    }

    #[test]
    fn rejects_a_cr_at_end_of_file() {
        assert_eq!(
            validate("line\nbare\r"),
            Err(CoreError::ControlCharacter {
                line_number: 2,
                code_point: 0x0d,
            })
        );
    }

    #[test]
    fn rejects_a_cr_inside_a_line() {
        assert_eq!(
            validate("a\rb\n"),
            Err(CoreError::ControlCharacter {
                line_number: 1,
                code_point: 0x0d,
            })
        );
    }

    #[test]
    fn rejects_a_second_cr_before_lf() {
        assert_eq!(
            validate("a\r\r\n"),
            Err(CoreError::ControlCharacter {
                line_number: 1,
                code_point: 0x0d,
            })
        );
    }

    #[test]
    fn allows_tabs() {
        assert_eq!(validate("a\tb\n"), Ok(vec!["a\tb", ""]));
    }

    #[test]
    fn rejects_every_control_class_with_its_line_number() {
        for (data, code_point, line_number) in [
            ("one\n\0two\n", 0x00, 2),
            ("\u{0007}bell\n", 0x07, 1),
            ("\u{001B}[0m\n", 0x1b, 1),
            ("del\u{007F}\n", 0x7f, 1),
            ("c1\u{0085}\n", 0x85, 1),
            ("sep\u{2028}\n", 0x2028, 1),
            ("sep\u{2029}\n", 0x2029, 1),
        ] {
            assert_eq!(
                validate(data),
                Err(CoreError::ControlCharacter {
                    line_number,
                    code_point,
                }),
                "data {data:?}"
            );
        }
    }

    #[test]
    fn accepts_exactly_max_line_chars() {
        let line = "a".repeat(limits_max_line_chars());
        let data = format!("{line}\n");
        assert_eq!(validate(&data), Ok(vec![line.as_str(), ""]));
    }

    #[test]
    fn rejects_one_char_over_max_line_chars() {
        let line = "a".repeat(limits_max_line_chars() + 1);
        let data = format!("{line}\n");
        assert_eq!(
            validate(&data),
            Err(CoreError::LineTooLong {
                line_number: 1,
                length: limits_max_line_chars() + 1,
                max_line_chars: limits_max_line_chars(),
            })
        );
    }

    #[test]
    fn counts_utf16_code_units_not_chars_or_bytes() {
        // 4 096 astral characters are 8 192 UTF-16 units and 16 384 bytes.
        let astral = "🚀".repeat(4_096);
        assert!(validate(&format!("{astral}\n")).is_ok());

        let over = format!("{}a\n", "🚀".repeat(4_096));
        assert_eq!(
            validate(&over),
            Err(CoreError::LineTooLong {
                line_number: 1,
                length: limits_max_line_chars() + 1,
                max_line_chars: limits_max_line_chars(),
            })
        );
    }

    #[test]
    fn accepts_max_lines_and_rejects_one_more() {
        let at_limit = "a\n".repeat(limits_max_read_todos());
        let lines = validate(&at_limit).expect("10 000 lines are accepted");
        assert_eq!(lines.len(), limits_max_read_todos() + 1);

        let over_limit = "a\n".repeat(limits_max_read_todos() + 1);
        assert_eq!(
            validate(&over_limit),
            Err(CoreError::TooManyLines {
                line_count: limits_max_read_todos() + 1,
                max_read_todos: limits_max_read_todos(),
            })
        );
    }

    #[test]
    fn counts_a_final_line_without_a_newline() {
        let data = "a\n".repeat(limits_max_read_todos()) + "b";
        assert_eq!(
            validate(&data),
            Err(CoreError::TooManyLines {
                line_count: limits_max_read_todos() + 1,
                max_read_todos: limits_max_read_todos(),
            })
        );
    }

    #[test]
    fn rejects_oversized_files() {
        let limits = ReadLimits::DEFAULT;
        assert_eq!(validate_file_bytes(limits.max_file_bytes, &limits), Ok(()));
        assert_eq!(
            validate_file_bytes(limits.max_file_bytes + 1, &limits),
            Err(CoreError::FileTooLarge {
                actual_bytes: limits.max_file_bytes + 1,
                max_bytes: limits.max_file_bytes,
            })
        );
    }

    #[test]
    fn blank_detection_uses_js_trim() {
        assert!(is_blank_line(""));
        assert!(is_blank_line("   \t "));
        assert!(is_blank_line("\u{FEFF}"));
        assert!(is_blank_line("\u{00A0}"));
        assert!(!is_blank_line("x"));
    }

    fn limits_max_line_chars() -> usize {
        ReadLimits::DEFAULT.max_line_chars
    }

    fn limits_max_read_todos() -> usize {
        ReadLimits::DEFAULT.max_read_todos
    }
}
