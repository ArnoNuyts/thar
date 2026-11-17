//! JavaScript whitespace semantics.
//!
//! The TypeScript oracle scans prefixes and trims text with `\s` and
//! `String.prototype.trim()`. Rust's `char::is_whitespace` and `str::trim`
//! are *not* the same set: JS includes `U+FEFF` and excludes `U+0085`, and it
//! includes `\v`/`\f`, which are rejected by the line validator but can still
//! reach `Todo::parse_line` directly.
//!
//! This module is the single source of truth for the JS set. Every scanner in
//! `thar-core` uses it so a future change to the oracle's whitespace rules has
//! exactly one place to change.

/// True for the characters matched by JavaScript's `\s` and trimmed by
/// `String.prototype.trim()`.
pub const fn is_js_whitespace(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'        // tab
            | '\u{000A}'  // line feed
            | '\u{000B}'  // vertical tab
            | '\u{000C}'  // form feed
            | '\u{000D}'  // carriage return
            | '\u{0020}'  // space
            | '\u{00A0}'  // no-break space
            | '\u{1680}'  // ogham space mark
            | '\u{2000}'
            ..='\u{200A}' // en quad .. hair space
            | '\u{2028}'  // line separator
            | '\u{2029}'  // paragraph separator
            | '\u{202F}'  // narrow no-break space
            | '\u{205F}'  // medium mathematical space
            | '\u{3000}'  // ideographic space
            | '\u{FEFF}' // zero width no-break space (BOM)
    )
}

/// True for the rejected C0/C1 controls, DEL, and `U+2028`/`U+2029`.
///
/// This is the shared character predicate for the read path, the write path,
/// and the host renderers. Tab is in the C0 range but is allowed inside a line,
/// so each caller excludes it explicitly (`character != '\t'` or an equivalent
/// rule).
#[must_use]
pub const fn is_rejected_control(character: char) -> bool {
    matches!(
        character,
        '\u{0000}'..='\u{001F}' | '\u{007F}'..='\u{009F}' | '\u{2028}' | '\u{2029}'
    )
}

/// Byte length of the leading run of JS whitespace.
pub(crate) fn whitespace_prefix_len(text: &str) -> usize {
    text.char_indices()
        .find(|(_, character)| !is_js_whitespace(*character))
        .map_or(text.len(), |(index, _)| index)
}

/// `String.prototype.trim()`: strip JS whitespace from both ends.
pub fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

#[cfg(test)]
mod tests {
    use super::{is_rejected_control, js_trim, whitespace_prefix_len};

    #[test]
    fn rejected_controls_cover_c0_c1_del_and_line_separators() {
        for character in [
            '\u{0000}', '\u{0007}', '\u{001B}', '\u{007F}', '\u{0085}', '\u{009F}',
        ] {
            assert!(is_rejected_control(character), "{character:?}");
        }
        for character in ['\u{2028}', '\u{2029}'] {
            assert!(is_rejected_control(character), "{character:?}");
        }
        for character in ['a', ' ', '\u{00A0}', '\u{10FFFF}'] {
            assert!(!is_rejected_control(character), "{character:?}");
        }
        // Tab is inside C0 but the predicate reports it; callers allow it.
        assert!(is_rejected_control('\t'));
    }

    #[test]
    fn trims_js_whitespace_only() {
        assert_eq!(js_trim(" \t\u{00A0}\u{FEFF}text\u{3000}\t "), "text");
        // U+0085 (NEL) is not in the ECMAScript whitespace set; keep it.
        assert_eq!(js_trim("\u{0085}text\u{0085}"), "\u{0085}text\u{0085}");
    }

    #[test]
    fn measures_prefix_in_bytes() {
        assert_eq!(whitespace_prefix_len(" \tfoo"), 2);
        assert_eq!(whitespace_prefix_len("\u{00A0}foo"), 2);
        assert_eq!(whitespace_prefix_len("\u{3000}"), 3);
        assert_eq!(whitespace_prefix_len("foo"), 0);
        assert_eq!(whitespace_prefix_len(""), 0);
    }

    #[test]
    fn vertical_and_form_feed_count_as_whitespace() {
        assert_eq!(js_trim("\u{000B}x\u{000C}"), "x");
    }

    #[test]
    fn unicode_line_separators_count_as_whitespace() {
        assert_eq!(js_trim("\u{2028}x\u{2029}"), "x");
        assert_eq!(whitespace_prefix_len("\u{2028}\u{2029}x"), 6);
    }
}
