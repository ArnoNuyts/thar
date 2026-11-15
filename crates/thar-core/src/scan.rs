//! Hand-written scanners for the `todo.txt` grammar.
//!
//! These replace the TypeScript regular expressions:
//!
//! - `/^x\s+/`, `/^\([A-Z]\)\s+/`, and `/^\d{4}-\d{2}-\d{2}(?=\s|$)/` for the
//!   line prefix;
//! - `/(^|\s)\+(?<name>[\w.\-]+)/g` and the `@context` twin;
//! - `/(^|\s)(?<key>[A-Za-z]+):(?<value>[^\s]+)/g` for tags.
//!
//! Matching is leftmost, non-overlapping, and left-to-right with the same
//! greediness as the regex engine, because tag order and duplicate-key
//! appending are observable in the serialized output.

use crate::date::TodoDate;
use crate::js::{is_js_whitespace, whitespace_prefix_len};
use crate::model::Priority;

/// Metadata discovered at the start of a line.
///
/// Leading date tokens are only consumed by the caller when they are valid and
/// unambiguous; otherwise the raw text is kept so the line round-trips.
#[derive(Debug)]
pub(crate) struct Prefix<'a> {
    /// The line starts with the `x` done marker and at least one whitespace.
    pub(crate) has_done_marker: bool,
    /// Priority from a leading `(A) .. (Z)` marker.
    pub(crate) priority: Option<Priority>,
    /// Byte index of the first leading date token (after `x` and priority).
    pub(crate) date_start_index: usize,
    /// Byte index after the consumed date tokens and their trailing whitespace.
    pub(crate) end_index: usize,
    /// Up to two leading `YYYY-MM-DD` tokens.
    pub(crate) date_tokens: Vec<&'a str>,
    /// The subset of `date_tokens` that is not a valid [`TodoDate`].
    pub(crate) invalid_date_tokens: Vec<&'a str>,
}

/// Scan the optional `x`, priority, and leading date tokens.
///
/// Mirrors `scanTodoPrefix` in `logic/dates.ts`, including byte-for-byte
/// whitespace semantics.
pub(crate) fn scan_prefix(line: &str) -> Prefix<'_> {
    let mut index = 0;

    let mut has_done_marker = false;
    if let Some(rest) = line.strip_prefix('x') {
        let whitespace = whitespace_prefix_len(rest);
        if whitespace > 0 {
            has_done_marker = true;
            index = 1 + whitespace;
        }
    }

    let mut priority = None;
    if let Some((candidate, consumed)) = priority_prefix(&line[index..]) {
        priority = Some(candidate);
        index += consumed;
    }

    let date_start_index = index;
    let mut date_tokens = Vec::new();
    while date_tokens.len() < 2 {
        let Some(token) = leading_date_token(&line[index..]) else {
            break;
        };
        date_tokens.push(token);
        index += token.len();
        index += whitespace_prefix_len(&line[index..]);
    }

    let invalid_date_tokens = date_tokens
        .iter()
        .copied()
        .filter(|token| TodoDate::parse(token).is_none())
        .collect();

    Prefix {
        has_done_marker,
        priority,
        date_start_index,
        end_index: index,
        date_tokens,
        invalid_date_tokens,
    }
}

/// Match `^\([A-Z]\)\s+`, returning the priority and the consumed byte length.
fn priority_prefix(rest: &str) -> Option<(Priority, usize)> {
    let mut characters = rest.char_indices();
    if characters.next()?.1 != '(' {
        return None;
    }
    let letter = characters.next()?.1;
    let priority = Priority::new(letter)?;
    if characters.next()?.1 != ')' {
        return None;
    }
    let whitespace = whitespace_prefix_len(characters.as_str());
    if whitespace == 0 {
        return None;
    }
    // '(' + ASCII letter + ')' is three bytes.
    Some((priority, 3 + whitespace))
}

/// Match `^\d{4}-\d{2}-\d{2}(?=\s|$)`, returning the token without the
/// lookahead whitespace.
fn leading_date_token(rest: &str) -> Option<&str> {
    // `get` keeps the slice on a char boundary instead of panicking on a
    // multi-byte character inside the first ten bytes.
    let token = rest.get(..10)?;
    if !is_date_token(token) {
        return None;
    }
    match rest[10..].chars().next() {
        None => Some(token),
        Some(character) if is_js_whitespace(character) => Some(token),
        Some(_) => None,
    }
}

/// `\d{4}-\d{2}-\d{2}` with ASCII digits only (JS `\d` is not Unicode).
fn is_date_token(token: &str) -> bool {
    token
        .as_bytes()
        .iter()
        .enumerate()
        .all(|(index, byte)| match index {
            4 | 7 => *byte == b'-',
            _ => byte.is_ascii_digit(),
        })
}

/// Extract `+project` names in encounter order, without duplicates.
pub(crate) fn scan_projects(text: &str) -> Vec<String> {
    scan_tag_names(text, '+')
}

/// Extract `@context` names in encounter order, without duplicates.
pub(crate) fn scan_contexts(text: &str) -> Vec<String> {
    scan_tag_names(text, '@')
}

/// Shared `(^|\s)[+@]([\w.\-]+)` scanner.
///
/// `\w` in the TS pattern is the ASCII class `[A-Za-z0-9_]`; a project or
/// context must start the line or follow whitespace, so `x@y` and email
/// addresses are not contexts.
///
/// Borrowed slices are only allocated when a name is kept.
fn scan_tag_names(text: &str, sigil: char) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    let mut index = 0;

    while index < text.len() {
        let Some((start, cursor)) = word_start(text, index) else {
            index = next_char_index(text, index);
            continue;
        };
        let Some(after_sigil) = text[cursor..].strip_prefix(sigil) else {
            index = next_char_index(text, start);
            continue;
        };
        let name_len = after_sigil
            .char_indices()
            .find(|(_, character)| !is_tag_name_char(*character))
            .map_or(after_sigil.len(), |(index, _)| index);

        if name_len == 0 {
            index = next_char_index(text, start);
            continue;
        }

        let name = &after_sigil[..name_len];
        if !names.iter().any(|existing| existing == name) {
            names.push(name.to_owned());
        }

        index = cursor + sigil.len_utf8() + name_len;
    }

    names
}

/// A tag found while scanning text.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ScannedTag<'a> {
    /// Byte range of the whole match, including the leading whitespace.
    pub(crate) range: core::ops::Range<usize>,
    /// The tag key.
    pub(crate) key: &'a str,
    /// The tag value (never empty).
    pub(crate) value: &'a str,
}

/// Extract `key:value` tags and the text with every tag token removed.
///
/// The TS oracle scans with a global regex, removes the matches in one pass,
/// and then trims the remainder. Duplicate keys are *not* merged here; the
/// model decides how to store them. Returned order is encounter order.
pub(crate) fn scan_tags(text: &str) -> (Vec<ScannedTag<'_>>, String) {
    let mut tags = Vec::new();
    let mut index = 0;

    while index < text.len() {
        let Some(tag) = tag_at(text, index) else {
            index = next_char_index(text, index);
            continue;
        };

        index = tag.range.end;
        tags.push(tag);
    }

    let mut stripped = String::with_capacity(text.len());
    let mut cursor = 0;
    for tag in &tags {
        stripped.push_str(&text[cursor..tag.range.start]);
        cursor = tag.range.end;
    }
    stripped.push_str(&text[cursor..]);

    (tags, stripped)
}

/// Match the tag regex starting exactly at `index`.
fn tag_at(text: &str, index: usize) -> Option<ScannedTag<'_>> {
    let (start, cursor) = word_start(text, index)?;
    let rest = &text[cursor..];

    let key_len = rest
        .char_indices()
        .find(|(_, character)| !character.is_ascii_alphabetic())
        .map_or(rest.len(), |(index, _)| index);
    if key_len == 0 {
        return None;
    }

    let after_key = &rest[key_len..];
    let after_colon = after_key.strip_prefix(':')?;
    let value_len = after_colon
        .char_indices()
        .find(|(_, character)| is_js_whitespace(*character))
        .map_or(after_colon.len(), |(index, _)| index);
    if value_len == 0 {
        return None;
    }

    let key_end = cursor + key_len;
    let value_start = key_end + 1;
    let value_end = value_start + value_len;

    Some(ScannedTag {
        range: start..value_end,
        key: &text[cursor..key_end],
        value: &text[value_start..value_end],
    })
}

/// Resolve `(^|\s)` at `index`, returning `(match_start, cursor)`.
///
/// The regex engine tries `^` before `\s`. At index 0 both alternatives are
/// possible; the `^` branch can only win when the first character is not
/// whitespace, because every caller requires a non-whitespace character after
/// the group (`+`, `@`, or an ASCII letter).
fn word_start(text: &str, index: usize) -> Option<(usize, usize)> {
    let character = text[index..].chars().next()?;
    if is_js_whitespace(character) {
        Some((index, index + character.len_utf8()))
    } else if index == 0 {
        Some((0, 0))
    } else {
        None
    }
}

/// Byte index of the next character after the one at `index`.
fn next_char_index(text: &str, index: usize) -> usize {
    text[index..]
        .chars()
        .next()
        .map_or(text.len(), |character| index + character.len_utf8())
}

/// `[\w.\-]` with ASCII `\w`.
fn is_tag_name_char(character: char) -> bool {
    character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | '-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scans_done_priority_and_dates() {
        let prefix = scan_prefix("x (A) 2024-02-29 2023-05-04 body");
        assert!(prefix.has_done_marker);
        assert_eq!(prefix.priority.map(Priority::as_char), Some('A'));
        assert_eq!(prefix.date_tokens, vec!["2024-02-29", "2023-05-04"]);
        assert!(prefix.invalid_date_tokens.is_empty());
        assert_eq!(
            &"x (A) 2024-02-29 2023-05-04 body"[prefix.end_index..],
            "body"
        );
    }

    #[test]
    fn stops_after_two_date_tokens() {
        let line = "2024-01-01 2024-01-02 2024-01-03 body";
        let prefix = scan_prefix(line);
        assert_eq!(prefix.date_tokens.len(), 2);
        assert_eq!(&line[prefix.end_index..], "2024-01-03 body");
    }

    #[test]
    fn date_token_requires_whitespace_or_end() {
        let prefix = scan_prefix("2024-01-01,body");
        assert!(prefix.date_tokens.is_empty());
        assert_eq!(prefix.end_index, 0);
        assert_eq!(prefix.date_start_index, 0);
    }

    #[test]
    fn marks_invalid_date_tokens() {
        let prefix = scan_prefix("x 0000-01-01 2023-02-29 body");
        assert_eq!(prefix.date_tokens, vec!["0000-01-01", "2023-02-29"]);
        assert_eq!(prefix.invalid_date_tokens, vec!["0000-01-01", "2023-02-29"]);
    }

    #[test]
    fn x_without_whitespace_is_not_done() {
        assert!(!scan_prefix("x").has_done_marker);
        assert!(!scan_prefix("xyz").has_done_marker);
        assert!(!scan_prefix("X task").has_done_marker);
        assert!(scan_prefix("x\ttask").has_done_marker);
    }

    #[test]
    fn priority_requires_a_uppercase_letter_and_whitespace() {
        assert!(scan_prefix("(A) task").priority.is_some());
        assert!(scan_prefix("(Z)\ttask").priority.is_some());
        assert!(scan_prefix("(a) task").priority.is_none());
        assert!(scan_prefix("(AB) task").priority.is_none());
        assert!(scan_prefix("(A)task").priority.is_none());
    }

    #[test]
    fn scans_projects_and_contexts_at_word_starts() {
        assert_eq!(
            scan_projects("+a +b x+y +a +c."),
            vec!["a".to_owned(), "b".to_owned(), "c.".to_owned()]
        );
        assert_eq!(
            scan_contexts("@home x@y email@example.com @home"),
            vec!["home".to_owned()]
        );
        assert!(scan_contexts("email@example.com").is_empty());
    }

    #[test]
    fn project_names_stop_at_punctuation() {
        assert_eq!(scan_projects("+a/b"), vec!["a".to_owned()]);
        assert_eq!(scan_projects("+a_b.c-d1"), vec!["a_b.c-d1".to_owned()]);
    }

    #[test]
    fn scans_tags_left_to_right() {
        let (tags, stripped) = scan_tags("alpha:one beta:two,three text");
        assert_eq!(tags.len(), 2);
        assert_eq!((tags[0].key, tags[0].value), ("alpha", "one"));
        assert_eq!((tags[1].key, tags[1].value), ("beta", "two,three"));
        assert_eq!(stripped, " text");
    }

    #[test]
    fn tag_at_line_start_is_removed_without_leading_whitespace() {
        let (tags, stripped) = scan_tags("alpha:one single tag");
        assert_eq!((tags[0].key, tags[0].value), ("alpha", "one"));
        assert_eq!(tags[0].range, 0..9);
        assert_eq!(stripped, " single tag");
    }

    #[test]
    fn leading_whitespace_is_part_of_the_tag_match() {
        let (tags, stripped) = scan_tags(" alpha:one");
        assert_eq!(tags[0].range, 0..10);
        assert_eq!(stripped, "");
    }

    #[test]
    fn url_parses_as_an_http_tag() {
        let (tags, _) = scan_tags("see http://example.com now");
        assert_eq!(tags.len(), 1);
        assert_eq!((tags[0].key, tags[0].value), ("http", "//example.com"));
    }

    #[test]
    fn keys_are_ascii_letters_only() {
        let (tags, _) = scan_tags("h1:1 a_b:1 Due:x");
        assert_eq!(tags.len(), 1);
        assert_eq!(tags[0].key, "Due");
    }

    #[test]
    fn tags_require_a_value() {
        let (tags, stripped) = scan_tags("empty: key: value");
        assert!(tags.is_empty());
        assert_eq!(stripped, "empty: key: value");
    }

    #[test]
    fn adjacent_tags_do_not_all_match() {
        // `a:1b:2` is one tag; `c:3 d:4` are two.
        let (tags, _) = scan_tags("a:1b:2 c:3 d:4");
        assert_eq!(tags.len(), 3);
        assert_eq!((tags[0].key, tags[0].value), ("a", "1b:2"));
    }

    #[test]
    fn non_ascii_letters_are_not_tag_keys() {
        let (tags, _) = scan_tags("über:1 日本:2");
        assert!(tags.is_empty());
    }
}
