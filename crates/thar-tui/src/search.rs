//! Native-host search normalization and the cached list model's search input.
//!
//! `thar-core` deliberately does not case-fold or split: the TypeScript host
//! owns `String.prototype.toLowerCase` (including its `Final_Sigma` rule) and
//! the `extractSearchTerms` regex pipeline. A native process has to provide
//! the same two operations itself, once per load/mutation for the views and
//! once per keystroke for the terms.
//!
//! Both functions here are ports of the oracle's behaviour:
//!
//! - [`normalize`] delegates to [`str::to_lowercase`], which implements the
//!   Unicode unconditional lowercase mappings plus the `Final_Sigma` condition
//!   (skipping `Case_Ignorable` characters on both sides). A Greek capital
//!   sigma becomes a final sigma (`ς`) only when it ends a word, exactly like
//!   JavaScript's `String.prototype.toLowerCase`.
//! - [`extract_search_terms`] lowercases, splits on JavaScript's `\s` set
//!   (which is not `char::is_whitespace`), and strips the oracle's wrapper
//!   punctuation with ASCII-only `\w` semantics.

use thar_core::Todo;

pub use thar_core::OwnedSearchView as OwnedView;

/// Lowercase one string the way the search views and terms need it.
///
/// This is JavaScript's `String.prototype.toLowerCase`, and Rust's
/// [`str::to_lowercase`] implements the same mapping: the unconditional
/// lowercase mappings plus the Unicode `Final_Sigma` rule, which ignores
/// `Case_Ignorable` characters on both sides of a Greek capital sigma.
/// `"aβ\u{0301}Σ."` lowercases to `"aβ\u{0301}ς."` while `"aΣ.\u{0301}a"`
/// lowercases to `"aσ.\u{0301}a"`.
///
/// # Example
///
/// ```
/// use thar_tui::search::normalize;
///
/// assert_eq!(normalize("ΑΣ"), "ας");
/// assert_eq!(normalize("ΑΣ Α"), "ας α");
/// assert_eq!(normalize("aΣ.Α"), "aσ.α");
/// ```
#[must_use]
pub fn normalize(value: &str) -> String {
    value.to_lowercase()
}

/// Build the persistent search view for one todo.
#[must_use]
pub fn view_for(todo: &Todo) -> OwnedView {
    OwnedView {
        text: normalize(&todo.text),
        contexts: todo.contexts.iter().map(|value| normalize(value)).collect(),
        projects: todo.projects.iter().map(|value| normalize(value)).collect(),
    }
}

/// One search term after `extractSearchTerms` has run.
///
/// The return value is the terms that survived trimming and wrapper-punctuation
/// stripping. An empty result matches every todo, exactly like the oracle's
/// empty and punctuation-only queries.
///
/// The pipeline is
/// `toLowerCase().trim().split(/\s+/).filter(Boolean).map(strip).filter(Boolean)`,
/// where `\s` is the ECMAScript whitespace set
/// ([`thar_core::is_js_whitespace`]) and `\w` is ASCII-only.
#[must_use]
pub fn extract_search_terms(query: &str) -> Vec<String> {
    normalize(query)
        .split(thar_core::is_js_whitespace)
        .filter(|term| !term.is_empty())
        .map(strip_term_wrappers)
        .filter(|term| !term.is_empty())
        .collect()
}

/// Remove leading characters outside `[A-Za-z0-9_@+]` and trailing characters
/// outside `[A-Za-z0-9_.\-_]`, like the oracle's two regex alternatives.
fn strip_term_wrappers(term: &str) -> String {
    let start = term
        .char_indices()
        .find(|&(_, character)| is_word(character) || character == '@' || character == '+')
        .map_or(term.len(), |(index, _)| index);
    let end = term
        .char_indices()
        .rev()
        .find(|&(_, character)| is_word(character) || character == '.' || character == '-')
        .map_or(start, |(index, character)| index + character.len_utf8());

    term[start..end.max(start)].to_owned()
}

/// JavaScript's `\w`: ASCII letters, digits, and underscore.
const fn is_word(character: char) -> bool {
    character.is_ascii_alphanumeric() || character == '_'
}

#[cfg(test)]
mod tests {
    use super::{extract_search_terms, normalize, strip_term_wrappers, view_for};
    use thar_core::{Todo, TodoId};

    #[test]
    fn views_are_lowercased_and_keep_their_order() {
        let todo = Todo::parse_line("Write Docs @Work +Thar", TodoId::new(0));
        let view = view_for(&todo);
        assert_eq!(view.text, "write docs @work +thar");
        assert_eq!(view.contexts, ["work"]);
        assert_eq!(view.projects, ["thar"]);
    }

    #[test]
    fn terms_are_lowercased_and_split_on_whitespace() {
        assert_eq!(
            extract_search_terms("  Write   DOCS\t@Work "),
            ["write", "docs", "@work"]
        );
    }

    #[test]
    fn terms_split_on_javascript_whitespace_only() {
        // U+FEFF is in ECMAScript's `\s`; U+0085 (NEL) is not, unlike Rust's
        // `char::is_whitespace`.
        assert_eq!(
            extract_search_terms("alpha\u{FEFF}beta\u{00A0}gamma"),
            ["alpha", "beta", "gamma"]
        );
        assert_eq!(
            extract_search_terms("alpha\u{0085}beta"),
            ["alpha\u{0085}beta"]
        );
        assert_eq!(
            extract_search_terms("\u{3000}\u{2028}\u{2029}"),
            Vec::<String>::new()
        );
    }

    #[test]
    fn terms_strip_wrapper_punctuation_only() {
        // A trailing dot is inside the allowed tail class, so it is kept.
        assert_eq!(
            extract_search_terms("(docs), !!@work +thar..."),
            ["docs", "@work", "+thar..."]
        );
        assert_eq!(extract_search_terms("!!!"), Vec::<String>::new());
        assert_eq!(extract_search_terms(""), Vec::<String>::new());
        assert_eq!(strip_term_wrappers("a.b"), "a.b");
        assert_eq!(strip_term_wrappers("...a..."), "a...");
        assert_eq!(strip_term_wrappers("@!!!"), "");
    }

    #[test]
    fn normalize_handles_non_ascii() {
        assert_eq!(normalize("ÄÖÜ"), "äöü");
        assert_eq!(normalize("İ"), "i\u{0307}");
    }

    #[test]
    fn sigma_is_final_only_at_the_end_of_a_word() {
        // Focused corpus for the Final_Sigma rule: `str::to_lowercase` owns the
        // `Cased`/`Case_Ignorable` tables, so these cases pin the mapping
        // without duplicating them here.
        assert_eq!(normalize("ΑΣ"), "ας");
        assert_eq!(normalize("ΑΣ."), "ας.");
        assert_eq!(normalize("ΑΣ Α"), "ας α");
        assert_eq!(normalize("ΑΣΑ"), "ασα");
        assert_eq!(normalize("aΣ.Α"), "aσ.α");
        assert_eq!(normalize("aβ\u{0301}Σ."), "aβ\u{0301}ς.");
        assert_eq!(normalize("Σ"), "σ");
        assert_eq!(normalize("\u{0301}Σ"), "\u{0301}σ");

        // A combining mark or other Case_Ignorable character after the sigma is
        // skipped, so the sigma still ends the word; a cased letter after the
        // mark makes it non-final.
        assert_eq!(normalize("ΑΣ\u{0301}"), "ας\u{0301}");
        assert_eq!(normalize("ΑΣ\u{0301}Α"), "ασ\u{0301}α");
        assert_eq!(normalize("Α\u{0301}Σ"), "α\u{0301}ς");
        // Soft hyphen (Cf), apostrophe (MidLetter), and modifier letters (Lm)
        // are all Case_Ignorable.
        assert_eq!(normalize("ΑΣ\u{00AD}Α"), "ασ\u{00AD}α");
        assert_eq!(normalize("ΑΣ'"), "ας'");
        assert_eq!(normalize("ΑΣ'\u{0301}Α"), "ασ'\u{0301}α");
        assert_eq!(normalize("ΑΣ\u{02B0}Α"), "ασ\u{02B0}α");
    }
}
