//! Native-host search normalization and the cached list model.
//!
//! `thar-core` deliberately does not case-fold or split: the TypeScript host
//! owns `String.prototype.toLowerCase` (with its `Final_Sigma` rule) and the
//! `extractSearchTerms` regex pipeline. A native process has to provide the
//! same two operations itself, once per load/mutation for the views and once
//! per keystroke for the terms.
//!
//! The baseline implementation here is ASCII-exact and Unicode-approximate:
//! [`normalize`] uses `str::to_lowercase`, and [`extract_search_terms`] uses a
//! whitespace split close to `/\s+/`. CP6's search-parity work replaces the
//! Unicode edges with a JS-faithful port and pins them against the TypeScript
//! oracle; the row plumbing below does not depend on which implementation wins.

use thar_core::Todo;

/// One todo's cached, lowercased search input.
///
/// Owned because the views outlive each row build: `thar-core::build_rows`
/// borrows them, so they cannot be built as temporaries inside the call.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OwnedView {
    /// Lowercased `Todo::text`, including its `@context`/`+project` tokens.
    pub text: String,
    /// Lowercased contexts, in stored order.
    pub contexts: Vec<String>,
    /// Lowercased projects, in stored order.
    pub projects: Vec<String>,
}

/// Lowercase one string the way the search views and terms need it.
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
#[must_use]
pub fn extract_search_terms(query: &str) -> Vec<String> {
    query
        .to_lowercase()
        .split_whitespace()
        .filter(|term| !term.is_empty())
        .map(strip_term_wrappers)
        .filter(|term| !term.is_empty())
        .collect()
}

/// Remove leading characters outside `[A-Za-z0-9_@+]` and trailing characters
/// outside `[A-Za-z0-9_.\-_]`, like the oracle's two regexes.
fn strip_term_wrappers(term: &str) -> String {
    let start = term
        .char_indices()
        .find(|&(_, ch)| is_word(ch) || ch == '@' || ch == '+')
        .map_or(term.len(), |(index, _)| index);
    let end = term
        .char_indices()
        .rev()
        .find(|&(_, ch)| is_word(ch) || ch == '.' || ch == '-')
        .map_or(start, |(index, ch)| index + ch.len_utf8());

    term[start..end.max(start)].to_owned()
}

/// JavaScript's `\w`: ASCII letters, digits, and underscore.
const fn is_word(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_'
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
    }

    #[test]
    fn normalize_handles_non_ascii() {
        assert_eq!(normalize("ÄÖÜ"), "äöü");
    }
}
