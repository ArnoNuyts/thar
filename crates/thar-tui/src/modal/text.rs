//! Word wrapping shared by the confirmation and update screens.
//!
//! The Ink modals measure their body with `countWrappedLines` (see
//! `utils/modal-layout.ts`) and then use that count for the button row and the
//! mouse map. Drawing the message with a different wrapper would put the
//! buttons on a row the hit test does not expect, so the renderer and the
//! geometry read the same lines from [`wrap`].
//!
//! The algorithm is the TypeScript one: a paragraph is split at `\n`, an empty
//! paragraph is one blank line, and a long paragraph breaks after the last
//! space in the first `width + 1` cells (a hard break when there is none).

/// Wrap `text` into lines of at most `width` characters.
///
/// A zero width still yields at least one line per paragraph so a tiny
/// terminal cannot produce an empty body.
#[must_use]
pub fn wrap(text: &str, width: u16) -> Vec<String> {
    let width = usize::from(width.max(1));
    let mut lines = Vec::new();

    for paragraph in text.split('\n') {
        let mut remaining: Vec<char> = paragraph.chars().collect();
        if remaining.is_empty() {
            lines.push(String::new());
            continue;
        }

        while remaining.len() > width {
            let candidate = &remaining[..=width.min(remaining.len() - 1)];
            let break_at = candidate.iter().rposition(|character| *character == ' ');
            let (line, rest) = match break_at {
                Some(position) if position > 0 => (
                    candidate[..position].iter().collect(),
                    remaining[position + 1..].to_vec(),
                ),
                _ => (
                    remaining[..width].iter().collect(),
                    remaining[width..].to_vec(),
                ),
            };
            lines.push(line);
            remaining = rest;
        }
        lines.push(remaining.into_iter().collect());
    }

    lines
}

#[cfg(test)]
mod tests {
    use super::wrap;

    #[test]
    fn short_text_is_one_line_per_paragraph() {
        assert_eq!(wrap("hello", 20), ["hello"]);
        assert_eq!(wrap("one\ntwo", 20), ["one", "two"]);
        assert_eq!(wrap("", 20), [""]);
    }

    #[test]
    fn breaks_after_the_last_space_in_the_window() {
        assert_eq!(wrap("one two three", 7), ["one two", "three"]);
    }

    #[test]
    fn a_word_longer_than_the_width_is_hard_broken() {
        assert_eq!(wrap("abcdefgh", 3), ["abc", "def", "gh"]);
    }

    #[test]
    fn zero_width_still_produces_a_line() {
        assert_eq!(wrap("x", 0), ["x"]);
    }
}
