//! Make todo data safe to draw.
//!
//! The renderer must never let a todo's text start an ANSI/control sequence.
//! The read path already rejects rejected control code points in a file, but
//! this is defence in depth for strings that bypass the validator (a future
//! clipboard path, programmatic additions, tag values).
//!
//! This mirrors `logic/display-safety.ts`: tab is kept because it is useful in
//! todo text, and CR, LF, C0/C1 controls, DEL, `U+2028` and `U+2029` are
//! rendered as a visible `\uXXXX` escape. The escape keeps the TypeScript
//! formatting (at least four uppercase hexadecimal digits), so a future golden
//! comparison against the Ink app matches byte-for-byte.

use thar_core::is_rejected_control;

/// Escape control characters so terminal output can only show text.
///
/// Tab is preserved. Every rejected code point becomes `\uXXXX` with at least
/// four uppercase hexadecimal digits; all other characters are copied.
///
/// # Example
///
/// ```
/// use thar_tui::display::sanitize_for_display;
///
/// assert_eq!(sanitize_for_display("a\tb"), "a\tb");
/// assert_eq!(sanitize_for_display("a\u{1b}b"), r"a\u001Bb");
/// ```
#[must_use]
pub fn sanitize_for_display(text: &str) -> String {
    let mut safe = String::with_capacity(text.len());

    for ch in text.chars() {
        if ch == '\t' {
            safe.push(ch);
        } else if is_rejected_control(ch) {
            safe.push_str(&format!("\\u{:04X}", ch as u32));
        } else {
            safe.push(ch);
        }
    }

    safe
}

#[cfg(test)]
mod tests {
    use super::sanitize_for_display;

    #[test]
    fn keeps_tabs_and_ordinary_text() {
        assert_eq!(
            sanitize_for_display("write\tdocs @work"),
            "write\tdocs @work"
        );
        assert_eq!(sanitize_for_display("emoji 🎉 Ë"), "emoji 🎉 Ë");
    }

    #[test]
    fn escapes_c0_c1_del_and_line_separators() {
        assert_eq!(
            sanitize_for_display("\u{0}\u{1b}\u{7f}"),
            r"\u0000\u001B\u007F"
        );
        assert_eq!(sanitize_for_display("\u{85}"), r"\u0085");
        assert_eq!(sanitize_for_display("\u{2028}\u{2029}"), r"\u2028\u2029");
    }

    #[test]
    fn the_escape_never_contains_the_raw_character() {
        let safe = sanitize_for_display("a\nb\rc");
        assert!(!safe.contains('\n'));
        assert!(!safe.contains('\r'));
        assert_eq!(safe, r"a\u000Ab\u000Dc");
    }
}
