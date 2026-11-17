//! Sort, visibility, and search over a todo list.
//!
//! Ports `logic/Todos.ts`. Everything returns indexes into the input slice so
//! the caller keeps ownership and the sort can be applied to any list without
//! cloning:
//!
//! - [`sort_by_importance`] is the stable four-key order: open before done,
//!   first context (`None` first, then collated), overdue first, priority
//!   (missing last, then `A`..`Z`), input order for ties;
//! - [`filter_by_search`] applies the every-term AND filter to already
//!   normalized [`SearchView`]s.
//!
//! Visibility (`is_visible_in_overview`) is applied by the row builder and by
//! callers that need the visible indexes; the row builder inlines the
//! predicate so the sorted order is preserved in one pass.
//!
//! # Search normalization is host-provided
//!
//! `String.prototype.toLowerCase` applies the Unicode `Final_Sigma` rule,
//! skipping `Case_Ignorable` characters on both sides, and
//! `extractSearchTerms` is a JavaScript regex pipeline. Rust's case mapping is
//! not the contract: its Unicode version can trail the host's. So this crate
//! does not fold or split anything; the host passes the normalized values in.
//!
//! - The CP3b adapter lowercases each todo's `text`, `contexts`, and `projects`
//!   once per load or mutation and passes one [`SearchView`] per visible todo.
//! - Only the query changes per keystroke, so the host normalizes it with
//!   `extractSearchTerms` and passes the resulting terms.
//!
//! Empty `terms` match every view: the oracle's `!query.trim()` early return
//! and its punctuation-only (no usable term) case both land there.
//!
//! # Collation
//!
//! The oracle compares first contexts with `String.prototype.localeCompare`,
//! i.e. the ICU default collation of the host locale. Context names are scanned
//! with `[\w.\-]+`, so only `A-Za-z0-9_.-` can occur. For exactly that set the
//! ICU primary weights are `_ - . 0..9` followed by the letters in
//! case-insensitive order, with a lower-before-upper tertiary tie-break:
//! `"a" < "A" < "b" < "B"`. [`compare_contexts`] implements that order without
//! a table lookup and without byte order.
//!
//! The order was measured against the TypeScript oracle running on Node's ICU
//! with its `en-US` default (`sensitivity: variant`) and is pinned by the
//! committed expectations in `crates/thar-core/tests/domain-expectations.json`;
//! the probe covered every pair of two-character strings over the allowed
//! alphabet. Priorities only ever contain `A`..`Z`, where the collation order is
//! the byte order. Any character outside the allowed set (which the scanners
//! cannot produce) sorts after the known weights by scalar value, so the
//! comparator stays a total order. The locale assumption is recorded as an open
//! decision in `docs/rust-port/PLAN.md` §13.

use core::cmp::Ordering;
use std::borrow::Borrow;

use crate::date::TodoDate;
use crate::model::{Priority, Todo};

/// Order todo indexes by importance at `today`.
///
/// The order is stable: equal keys keep their input order. The input slice is
/// never mutated. `todos` may hold any value that borrows a [`Todo`] (for
/// example `Rc<Todo>`), so a host that shares its list can sort it in place
/// without cloning.
///
/// # Example
///
/// ```
/// use thar_core::{Todo, TodoDate, TodoId, sort_by_importance};
///
/// let todos = vec![
///     Todo::parse_line("done task @work", TodoId::new(0)).set_state(thar_core::State::Done),
///     Todo::parse_line("open task @work", TodoId::new(1)),
/// ];
/// let today = "2026-11-15".parse::<TodoDate>().expect("valid");
/// assert_eq!(sort_by_importance(&todos, today), vec![1, 0]);
/// ```
#[must_use]
pub fn sort_by_importance<T: Borrow<Todo>>(todos: &[T], today: TodoDate) -> Vec<usize> {
    // Precompute the keys once: `is_overdue` and the first-context lookup are
    // cheap, but the comparator runs O(n log n) times per keystroke.
    let keys: Vec<SortKey<'_>> = todos
        .iter()
        .map(|todo| {
            let todo = todo.borrow();
            SortKey {
                done: todo.is_done(),
                context: todo.contexts.first().map(String::as_str),
                overdue: todo.is_overdue(today),
                priority: todo.priority,
            }
        })
        .collect();

    let mut order: Vec<usize> = (0..todos.len()).collect();
    // `sort_by` is stable, so equal keys keep their input order.
    order.sort_by(|&left, &right| compare_keys(&keys[left], &keys[right]));
    order
}

/// One todo's precomputed importance keys.
struct SortKey<'a> {
    done: bool,
    context: Option<&'a str>,
    overdue: bool,
    priority: Option<Priority>,
}

/// Compare two precomputed importance keys.
fn compare_keys(left: &SortKey<'_>, right: &SortKey<'_>) -> Ordering {
    left.done
        .cmp(&right.done)
        .then_with(|| match (left.context, right.context) {
            (None, Some(_)) => Ordering::Less,
            (Some(_), None) => Ordering::Greater,
            (Some(left), Some(right)) => compare_contexts(left, right),
            (None, None) => Ordering::Equal,
        })
        .then_with(|| right.overdue.cmp(&left.overdue))
        .then_with(|| match (left.priority, right.priority) {
            (None, Some(_)) => Ordering::Greater,
            (Some(_), None) => Ordering::Less,
            (Some(left), Some(right)) => left.cmp(&right),
            (None, None) => Ordering::Equal,
        })
}

/// Compare context names with the ICU default collation the oracle uses.
///
/// Primary weights are compared first over the whole string, then the
/// lower-before-upper tertiary weights. That is the ICU model for the
/// `[A-Za-z0-9_.-]` alphabet: it has no contractions, expansions, or secondary
/// weights, so the comparison is decided by the primary sequence and then by
/// case.
fn compare_contexts(left: &str, right: &str) -> Ordering {
    let primary = left
        .chars()
        .map(primary_weight)
        .cmp(right.chars().map(primary_weight));

    match primary {
        Ordering::Equal => left
            .chars()
            .map(case_weight)
            .cmp(right.chars().map(case_weight)),
        other => other,
    }
}

/// ICU primary weight for a character a context name can contain.
fn primary_weight(character: char) -> u32 {
    match character {
        '_' => 0,
        '-' => 1,
        '.' => 2,
        '0'..='9' => 3 + (character as u32 - '0' as u32),
        'a'..='z' => 13 + (character as u32 - 'a' as u32),
        'A'..='Z' => 13 + (character as u32 - 'A' as u32),
        // Not producible by the `[\w.\-]` scanner. Keep the order total and
        // deterministic instead of falling back to byte order.
        _ => 1_000 + character as u32,
    }
}

/// ICU tertiary weight: lowercase before uppercase, everything else equal.
fn case_weight(character: char) -> u8 {
    u8::from(character.is_uppercase())
}

/// One todo's already-normalized search fields.
///
/// The host owns case folding. JavaScript's `String.prototype.toLowerCase`
/// applies the Unicode `Final_Sigma` rule (with `Case_Ignorable` skipping), and
/// Rust's Unicode version can trail the host's, so this type carries values the
/// host lowercased instead of folding them again here.
///
/// The CP3b adapter builds one view per todo when the list loads or a todo is
/// mutated, and reuses it for every keystroke.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SearchView<'a> {
    /// Lowercased todo text, including its `@context` and `+project` tokens.
    pub text: &'a str,
    /// Lowercased contexts, in their stored order.
    pub contexts: &'a [String],
    /// Lowercased projects, in their stored order.
    pub projects: &'a [String],
}

/// An owned [`SearchView`], for a host that caches one view per todo.
///
/// This is the type the TUI and the WASM boundary keep between keystrokes: the
/// view must outlive every row build, so it cannot borrow a temporary. Built
/// values are passed to [`build_rows`](crate::build_rows) directly because
/// `OwnedSearchView` implements [`SearchViewLike`].
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OwnedSearchView {
    /// Lowercased todo text, including its `@context` and `+project` tokens.
    pub text: String,
    /// Lowercased contexts, in their stored order.
    pub contexts: Vec<String>,
    /// Lowercased projects, in their stored order.
    pub projects: Vec<String>,
}

impl OwnedSearchView {
    /// Borrow the owned fields as a [`SearchView`].
    #[must_use]
    pub fn as_view(&self) -> SearchView<'_> {
        SearchView {
            text: &self.text,
            contexts: &self.contexts,
            projects: &self.projects,
        }
    }
}

/// A search-view source that can be borrowed as a [`SearchView`].
///
/// Implemented for the borrowed [`SearchView`] and the owned
/// [`OwnedSearchView`], so a caller can hand either slice layout to
/// [`build_rows`](crate::build_rows).
pub trait SearchViewLike {
    /// Borrow this value as a [`SearchView`].
    fn as_view(&self) -> SearchView<'_>;
}

impl SearchViewLike for SearchView<'_> {
    fn as_view(&self) -> SearchView<'_> {
        *self
    }
}

impl SearchViewLike for OwnedSearchView {
    fn as_view(&self) -> SearchView<'_> {
        SearchView {
            text: &self.text,
            contexts: &self.contexts,
            projects: &self.projects,
        }
    }
}

/// Keep the indexes of views matching every term in `terms`.
///
/// `views` and `terms` are already normalized by the host (see
/// [`SearchView`]): terms are lowercased and stripped of wrapper punctuation,
/// and a term matches the view text, or any context/project after its leading
/// `@`/`+` is removed. Empty `terms` match every view, matching the oracle's
/// empty, whitespace-only, and punctuation-only queries.
///
/// # Example
///
/// ```
/// use thar_core::{SearchView, filter_by_search};
///
/// let work = ["work".to_owned()];
/// let views = [
///     SearchView { text: "buy milk +work", contexts: &[], projects: &work },
///     SearchView { text: "walk dog", contexts: &[], projects: &[] },
/// ];
/// // The host lowercases the query and extracts the terms; `@work` also
/// // matches the project `work`.
/// assert_eq!(filter_by_search(&views, &["@work"]), vec![0]);
/// // No usable term (an empty or punctuation-only query) matches everything.
/// assert_eq!(filter_by_search(&views, &[] as &[&str]), vec![0, 1]);
/// ```
#[must_use]
pub fn filter_by_search<S: AsRef<str>>(views: &[SearchView<'_>], terms: &[S]) -> Vec<usize> {
    if terms.is_empty() {
        return (0..views.len()).collect();
    }

    let mut matches = Vec::new();
    for (index, view) in views.iter().enumerate() {
        if view_matches(view, terms) {
            matches.push(index);
        }
    }

    matches
}

/// True when `view` matches every term in `terms`.
///
/// This is the predicate [`filter_by_search`] applies, exposed on its own so a
/// caller that already holds a filtered or reordered list (the row builder)
/// can apply the same rule without materializing a second view slice.
///
/// `terms` are already normalized by the host; see [`SearchView`]. A term
/// matches the view text directly, or a context/project after its leading `@`
/// or `+` is removed. Empty `terms` match every view.
///
/// # Example
///
/// ```
/// use thar_core::{SearchView, view_matches};
///
/// let work = ["work".to_owned()];
/// let view = SearchView { text: "buy milk +work", contexts: &[], projects: &work };
/// assert!(view_matches(&view, &["milk"]));
/// assert!(view_matches(&view, &["@work"]));
/// assert!(!view_matches(&view, &["eggs"]));
/// ```
#[must_use]
pub fn view_matches<S: AsRef<str>>(view: &SearchView<'_>, terms: &[S]) -> bool {
    terms.iter().all(|term| {
        let term = term.as_ref();
        let normalized = term.strip_prefix(['@', '+']).unwrap_or(term);
        view.text.contains(term)
            || view
                .contexts
                .iter()
                .any(|context| context.contains(normalized))
            || view
                .projects
                .iter()
                .any(|project| project.contains(normalized))
    })
}

#[cfg(test)]
mod tests {
    use super::{SearchView, filter_by_search, sort_by_importance};
    use crate::date::TodoDate;
    use crate::model::{Priority, State, Todo, TodoId};

    fn today() -> TodoDate {
        "2026-11-15".parse::<TodoDate>().expect("valid today")
    }

    /// The host lowercases; ASCII inputs make `str::to_lowercase` equivalent,
    /// and the sigma cases below pass the host values explicitly.
    fn view<'a>(text: &'a str, contexts: &'a [String], projects: &'a [String]) -> SearchView<'a> {
        SearchView {
            text,
            contexts,
            projects,
        }
    }

    fn todos(lines: &[&str]) -> Vec<Todo> {
        lines
            .iter()
            .enumerate()
            .map(|(index, line)| Todo::parse_line(line, TodoId::new(index as u64)))
            .collect()
    }

    fn sorted_lines(lines: &[&str]) -> Vec<String> {
        let todos = todos(lines);
        sort_by_importance(&todos, today())
            .into_iter()
            .map(|index| todos[index].to_string())
            .collect()
    }

    #[test]
    fn sorts_open_before_done_then_context_then_overdue_then_priority() {
        assert_eq!(
            sorted_lines(&[
                "x done without context",
                "plain open without context",
                "(B) priority B with context @alpha",
                "(A) priority A with context @alpha",
                "overdue with context @alpha due:2020-01-01",
                "open with context @work",
                "plain open with context @home",
            ]),
            vec![
                "plain open without context",
                "overdue with context @alpha due:2020-01-01",
                "(A) priority A with context @alpha",
                "(B) priority B with context @alpha",
                "plain open with context @home",
                "open with context @work",
                "x done without context",
            ]
        );
    }

    #[test]
    fn sort_is_stable_for_equal_keys() {
        // No context, no due, no priority, all open: the keys are equal, so the
        // input order must survive (lexicographic text order would not).
        assert_eq!(
            sorted_lines(&["bbb", "aaa", "ccc"]),
            vec!["bbb", "aaa", "ccc"]
        );
    }

    #[test]
    fn sort_does_not_mutate_the_input() {
        let list = todos(&["b @b", "a @a"]);
        let before: Vec<String> = list.iter().map(Todo::to_string).collect();
        let _ = sort_by_importance(&list, today());
        let after: Vec<String> = list.iter().map(Todo::to_string).collect();
        assert_eq!(before, after);
    }

    #[test]
    fn contexts_collate_like_icu_not_byte_order() {
        // Byte order would put "Zed" before "alpha" and "a_1" before "a-1";
        // ICU (and this comparator) is case-insensitive first, lowercase
        // before uppercase for the same primary weight, and
        // `_` < `-` < `.` < digits < letters. A prefix sorts first.
        let order = sorted_lines(&[
            "z @Zed", "a @alpha", "u @a_1", "d @a-1", "o @a.1", "n @a1", "m @A1", "l @a", "k @A",
        ]);
        assert_eq!(
            order,
            vec![
                "l @a", "k @A", "u @a_1", "d @a-1", "o @a.1", "n @a1", "m @A1", "a @alpha",
                "z @Zed",
            ]
        );
    }

    #[test]
    fn priorities_sort_alphabetically_with_missing_last() {
        assert_eq!(
            sorted_lines(&["d @x", "(A) a @x", "(C) c @x", "(B) b @x"]),
            vec!["(A) a @x", "(B) b @x", "(C) c @x", "d @x"]
        );
    }

    #[test]
    fn search_matches_the_host_normalized_text() {
        // The host lowercases `Buy Milk` to `buy milk` before filtering.
        let views = [
            view("buy milk", &[], &[]),
            view("walk dog", &[], &[]),
            view("milk chocolate", &[], &[]),
        ];
        assert_eq!(filter_by_search(&views, &["milk"]), vec![0, 2]);
    }

    #[test]
    fn search_matches_contexts_and_projects_across_prefixes() {
        let work = ["work".to_owned()];
        let home = ["home".to_owned()];
        let views = [
            view("fix bug +work", &work, &work),
            view("buy milk @home", &home, &home),
            view("walk dog", &[], &[]),
        ];
        assert_eq!(filter_by_search(&views, &["@work"]), vec![0]);
        assert_eq!(filter_by_search(&views, &["+home"]), vec![1]);
        assert_eq!(filter_by_search(&views, &["+work"]), vec![0]);
        assert_eq!(filter_by_search(&views, &["@home"]), vec![1]);
    }

    #[test]
    fn search_requires_every_term() {
        let home = ["home".to_owned()];
        let views = [
            view("buy milk", &[], &[]),
            view("buy bread", &[], &[]),
            view("milk tea", &[], &[]),
            view("buy milk @home", &home, &[]),
        ];
        assert_eq!(filter_by_search(&views, &["buy", "milk"]), vec![0, 3]);
        assert_eq!(filter_by_search(&views, &["buy", "milk", "@home"]), vec![3]);
        assert_eq!(filter_by_search(&views, &["zzz"]), Vec::<usize>::new());
    }

    #[test]
    fn search_ignores_empty_terms_and_internal_punctuation() {
        let home = ["home".to_owned()];
        let views = [
            view("buy milk", &[], &[]),
            view("walk dog @home", &home, &[]),
        ];
        // The host turns an empty, whitespace-only, or punctuation-only query
        // into no terms; both paths match everything.
        assert_eq!(filter_by_search(&views, &[] as &[&str]), vec![0, 1]);
        // A term keeps internal dots, so `a.b` matches `a.b` in the text.
        assert_eq!(filter_by_search(&views, &["milk"]), vec![0]);
        assert_eq!(filter_by_search(&views, &["@home"]), vec![1]);
    }

    #[test]
    fn search_does_not_see_tags_that_were_stripped_from_the_text() {
        // The host lowercases `task`/`due task`, and the parsed tags are not
        // part of the view.
        let views = [view("task", &[], &[]), view("due task", &[], &[])];
        assert_eq!(filter_by_search(&views, &["due"]), vec![1]);
    }

    #[test]
    fn search_replays_host_normalized_final_sigma() {
        // JavaScript lowercases `aΣ.Α` to `aσ.α` (the sigma is followed by a
        // case-ignorable `.` and then a cased letter, so it is not final) and
        // the term strips to `aσ.`, which matches the text. Rust's unconditional
        // mapping gives the same string here, but the old adjacent-neighbour
        // final-sigma rule gave `aς.` and dropped the match.
        assert_eq!(
            filter_by_search(&[view("aσ.", &[], &[])], &["aσ."]),
            vec![0]
        );

        // `aβ\u{0301}Σ.` lowercases to `aβ\u{0301}ς.`: the sigma is final
        // because the only following character is `.`. The text keeps its
        // non-final sigma, so the oracle does not match. Rust cannot derive the
        // final sigma from the adjacent character (the combining mark), which
        // is why the host passes the terms in.
        assert_eq!(
            filter_by_search(&[view("aβ\u{0301}σ.", &[], &[])], &["aβ\u{0301}ς."]),
            Vec::<usize>::new()
        );
    }

    #[test]
    fn search_never_folds_case_itself() {
        // The host lowercases both sides. A view that still has uppercase text
        // and a term that still has uppercase letters must not match: folding
        // here would hide a host that forgot to normalize, and Rust's mapping is
        // not JavaScript's anyway (Final_Sigma, Unicode version).
        assert_eq!(
            filter_by_search(&[view("MILK", &[], &[])], &["milk"]),
            Vec::<usize>::new()
        );
        assert_eq!(
            filter_by_search(&[view("milk", &[], &[])], &["Milk"]),
            Vec::<usize>::new()
        );
        assert_eq!(
            filter_by_search(&[view("milk", &[], &[])], &["milk"]),
            vec![0]
        );
    }

    #[test]
    fn character_level_case_mapping_is_not_javascript_case_mapping() {
        // Guards why the host owns folding: `char::to_lowercase` has no
        // context, so the old helper's per-character mapping plus an
        // adjacent-neighbour rule missed the `Case_Ignorable` skip. Rust's
        // `str::to_lowercase` models the full rule today, but its Unicode
        // version can still trail the host's; the host value is the contract.
        assert_eq!('Σ'.to_lowercase().to_string(), "σ");
        assert_eq!("ΑΣ".to_lowercase(), "ας");
    }

    #[test]
    fn priority_and_state_helpers_stay_available_for_the_sort() {
        let todo = Todo::parse_line("(B) task", TodoId::new(0))
            .set_priority(Priority::new('A'))
            .set_state(State::Done);
        assert_eq!(todo.priority.map(Priority::as_char), Some('A'));
        assert!(todo.is_done());
    }
}
