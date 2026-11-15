//! Sort, visibility, and search over a todo list.
//!
//! Ports `logic/Todos.ts` and `utils/search-utils.ts`. Everything returns
//! indexes into the input slice so the caller keeps ownership and the sort can
//! be applied to any list without cloning:
//!
//! - [`sort_by_importance`] is the stable four-key order: open before done,
//!   first context (`None` first, then collated), overdue first, priority
//!   (missing last, then `A`..`Z`), input order for ties;
//! - [`filter_hidden`] keeps the todos visible in the overview at `today`;
//! - [`filter_by_search`] applies the every-term AND filter;
//! - [`extract_search_terms`] is the query normalizer both use.
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
//! The order was measured against the TypeScript oracle (Node's ICU, `en-US`
//! default, `sensitivity: variant`) and is pinned by the committed expectations
//! in `crates/thar-core/tests/domain-expectations.json`; the probe covered
//! every pair of two-character strings over the allowed alphabet. Priorities
//! only ever contain `A`..`Z`, where the collation order is the byte order.
//! Any character outside the allowed set (which the scanners cannot produce)
//! sorts after the known weights by scalar value, so the comparator stays a
//! total order.
//!
//! # Case folding
//!
//! `String.prototype.toLowerCase` and Rust's `char::to_lowercase` agree except
//! for the Greek final sigma: JavaScript applies the Unicode default
//! Final_Sigma rule (`"ΟΔΟΣ"` becomes `"οδος"`), while Rust always produces
//! `"οσ"`. [`js_lowercase`] adds the final-sigma case for a directly adjacent
//! cased letter, which covers every non-combining use. The remaining divergence
//! (a sigma followed by a case-ignorable character and then a cased letter)
//! cannot reach [`filter_by_search`]: the query normalizer strips every
//! non-ASCII character from both ends of a term, so a term can never end in
//! `σ`/`ς` and its internal sigmas only ever match a non-final text sigma,
//! where both implementations agree.

use core::cmp::Ordering;

use crate::date::TodoDate;
use crate::js::{is_js_whitespace, js_trim};
use crate::model::Todo;

/// Order todo indexes by importance at `today`.
///
/// The order is stable: equal keys keep their input order. The input slice is
/// never mutated.
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
/// let today = TodoDate::parse("2026-11-15").expect("valid");
/// assert_eq!(sort_by_importance(&todos, today), vec![1, 0]);
/// ```
#[must_use]
pub fn sort_by_importance(todos: &[Todo], today: TodoDate) -> Vec<usize> {
    // Precompute the keys once: `is_overdue` and the first-context lookup are
    // cheap, but the comparator runs O(n log n) times per keystroke.
    let keys: Vec<SortKey<'_>> = todos
        .iter()
        .map(|todo| SortKey {
            done: todo.is_done(),
            context: todo.contexts.first().map(String::as_str),
            overdue: todo.is_overdue(today),
            priority: todo.priority.map(|priority| priority.as_char()),
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
    priority: Option<char>,
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
#[must_use]
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

/// Keep the indexes of todos visible in the overview at `today`.
///
/// A todo is hidden by a non-`0` `h:` tag and by a future `t:` threshold.
#[must_use]
pub fn filter_hidden(todos: &[Todo], today: TodoDate) -> Vec<usize> {
    todos
        .iter()
        .enumerate()
        .filter(|(_, todo)| todo.is_visible_in_overview(today))
        .map(|(index, _)| index)
        .collect()
}

/// Keep the indexes of todos matching every term in `query`.
///
/// The query is lowercased, split on JavaScript whitespace, and stripped of
/// wrapper punctuation by [`extract_search_terms`]. Terms match the todo text
/// or the todo's contexts and projects; a leading `@`/`+` is stripped before
/// the context/project comparison, so `@work` also finds `+work`. An empty,
/// whitespace-only, or punctuation-only query matches every todo.
///
/// # Example
///
/// ```
/// use thar_core::{Todo, TodoId, filter_by_search};
///
/// let todos = vec![
///     Todo::parse_line("buy milk +work", TodoId::new(0)),
///     Todo::parse_line("walk dog", TodoId::new(1)),
/// ];
/// assert_eq!(filter_by_search(&todos, "@work"), vec![0]);
/// assert_eq!(filter_by_search(&todos, "!!!"), vec![0, 1]);
/// ```
#[must_use]
pub fn filter_by_search(todos: &[Todo], query: &str) -> Vec<usize> {
    let all = || -> Vec<usize> { (0..todos.len()).collect() };

    if js_trim(query).is_empty() {
        return all();
    }

    let terms = extract_search_terms(query);
    if terms.is_empty() {
        // No usable term: the oracle's `every` check is vacuously true.
        return all();
    }

    let mut matches = Vec::new();
    for (index, todo) in todos.iter().enumerate() {
        let text = js_lowercase(&todo.text);
        let contexts: Vec<String> = todo
            .contexts
            .iter()
            .map(|context| js_lowercase(context))
            .collect();
        let projects: Vec<String> = todo
            .projects
            .iter()
            .map(|project| js_lowercase(project))
            .collect();

        let matched = terms.iter().all(|term| {
            let normalized = term.strip_prefix(['@', '+']).unwrap_or(term);
            text.contains(term.as_str())
                || contexts.iter().any(|context| context.contains(normalized))
                || projects.iter().any(|project| project.contains(normalized))
        });

        if matched {
            matches.push(index);
        }
    }

    matches
}

/// Normalize a search query into the terms the filter matches.
///
/// Mirrors `extractSearchTerms` in `utils/search-utils.ts`: lowercase, trim,
/// split on JavaScript whitespace, drop empty parts, strip leading characters
/// that are not word characters/`@`/`+`, strip trailing characters that are
/// not word characters/`.`/`-`/`_`, and drop whatever became empty.
///
/// # Example
///
/// ```
/// use thar_core::extract_search_terms;
///
/// assert_eq!(extract_search_terms("/@work +bug/"), vec!["@work", "+bug"]);
/// assert_eq!(extract_search_terms("!!!"), Vec::<String>::new());
/// ```
#[must_use]
pub fn extract_search_terms(query: &str) -> Vec<String> {
    let lowered = js_lowercase(query);

    js_trim(&lowered)
        .split(is_js_whitespace)
        .filter(|part| !part.is_empty())
        .filter_map(|part| {
            let term = strip_term_wrappers(part);
            (!term.is_empty()).then(|| term.to_owned())
        })
        .collect()
}

/// Apply the oracle's `^[^\w@+]+|[^\w.\-_]+$` strip to one term.
///
/// The leading run is removed first and the trailing run second. The global
/// replacement in the oracle scans left to right, so both anchored
/// alternatives can fire in one pass; stripping the prefix cannot change the
/// suffix, which makes the two-step version equivalent.
fn strip_term_wrappers(term: &str) -> &str {
    let start = term
        .char_indices()
        .find(|(_, character)| is_term_start(*character))
        .map_or(term.len(), |(index, _)| index);
    let term = &term[start..];

    let end = term
        .char_indices()
        .rev()
        .find(|(_, character)| is_term_tail(*character))
        .map_or(0, |(index, character)| index + character.len_utf8());

    &term[..end]
}

/// `[\w@+]` with ASCII `\w`.
fn is_term_start(character: char) -> bool {
    character.is_ascii_alphanumeric() || matches!(character, '_' | '@' | '+')
}

/// `[\w.\-_]` with ASCII `\w`.
fn is_term_tail(character: char) -> bool {
    character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | '-')
}

/// `String.prototype.toLowerCase`, including the Greek final sigma.
///
/// Only the Final_Sigma context is special-cased; every other character uses
/// Rust's full Unicode lowercase mapping, which matches the oracle's default
/// case conversion. JavaScript skips case-ignorable characters (combining
/// marks, `.`, `:`, …) when it decides sigma; this implementation looks at the
/// immediately adjacent characters only, which is documented in the module
/// docs and cannot change a search result.
#[must_use]
pub fn js_lowercase(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut previous: Option<char> = None;
    let mut chars = text.chars().peekable();

    while let Some(character) = chars.next() {
        if character == '\u{03A3}' {
            let before = previous.is_some_and(is_cased);
            let after = chars.peek().copied().is_some_and(is_cased);
            output.push(if before && !after {
                '\u{03C2}'
            } else {
                '\u{03C3}'
            });
        } else {
            output.extend(character.to_lowercase());
        }
        previous = Some(character);
    }

    output
}

/// True for the Unicode `Cased` property, approximated without tables.
fn is_cased(character: char) -> bool {
    character.is_uppercase() || character.is_lowercase() || is_titlecase(character)
}

/// True for the `Lt` (titlecase) category, whose characters have both a
/// distinct lowercase and a distinct uppercase mapping.
fn is_titlecase(character: char) -> bool {
    character.is_alphabetic()
        && character.to_lowercase().next() != Some(character)
        && character.to_uppercase().next() != Some(character)
}

#[cfg(test)]
mod tests {
    use super::{
        extract_search_terms, filter_by_search, filter_hidden, js_lowercase, sort_by_importance,
    };
    use crate::date::TodoDate;
    use crate::model::{Priority, State, Todo, TodoId};

    fn today() -> TodoDate {
        TodoDate::parse("2026-11-15").expect("valid today")
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
            .map(|index| todos[index].serialize())
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
        let before: Vec<String> = list.iter().map(Todo::serialize).collect();
        let _ = sort_by_importance(&list, today());
        let after: Vec<String> = list.iter().map(Todo::serialize).collect();
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
    fn filter_hidden_drops_hidden_and_future_thresholds() {
        let list = todos(&[
            "visible",
            "hidden h:1",
            "not hidden h:0",
            "future t:2026-11-16",
            "today t:2026-11-15",
            "invalid t:2026-02-30",
        ]);
        assert_eq!(filter_hidden(&list, today()), vec![0, 2, 4, 5]);
    }

    #[test]
    fn search_matches_text_case_insensitively() {
        let list = todos(&["Buy Milk", "walk dog", "milk chocolate"]);
        assert_eq!(filter_by_search(&list, "MILK"), vec![0, 2]);
        assert_eq!(filter_by_search(&list, "milk"), vec![0, 2]);
    }

    #[test]
    fn search_matches_contexts_and_projects_across_prefixes() {
        let list = todos(&["fix bug +work", "buy milk @home", "walk dog"]);
        assert_eq!(filter_by_search(&list, "@work"), vec![0]);
        assert_eq!(filter_by_search(&list, "+home"), vec![1]);
        assert_eq!(filter_by_search(&list, "+work"), vec![0]);
        assert_eq!(filter_by_search(&list, "@home"), vec![1]);
    }

    #[test]
    fn search_requires_every_term() {
        let list = todos(&["buy milk", "buy bread", "milk tea", "buy milk @home"]);
        assert_eq!(filter_by_search(&list, "buy milk"), vec![0, 3]);
        assert_eq!(filter_by_search(&list, "buy milk @home"), vec![3]);
        assert_eq!(filter_by_search(&list, "zzz"), Vec::<usize>::new());
    }

    #[test]
    fn search_tolerates_punctuation_and_ignores_empty_queries() {
        let list = todos(&["buy milk", "walk dog @home"]);
        assert_eq!(filter_by_search(&list, ""), vec![0, 1]);
        assert_eq!(filter_by_search(&list, "   "), vec![0, 1]);
        assert_eq!(filter_by_search(&list, "!!!"), vec![0, 1]);
        assert_eq!(filter_by_search(&list, "milk,"), vec![0]);
        assert_eq!(filter_by_search(&list, "/@home"), vec![1]);
    }

    #[test]
    fn search_does_not_see_tags_that_were_stripped_from_the_text() {
        let list = todos(&["task due:2024-01-01", "due task"]);
        assert_eq!(filter_by_search(&list, "due"), vec![1]);
    }

    #[test]
    fn search_term_normalization_matches_the_oracle() {
        assert_eq!(extract_search_terms("buy milk"), vec!["buy", "milk"]);
        assert_eq!(extract_search_terms("@work +bug"), vec!["@work", "+bug"]);
        assert_eq!(extract_search_terms("/@work +bug/"), vec!["@work", "+bug"]);
        assert_eq!(extract_search_terms("/@home/"), vec!["@home"]);
        assert_eq!(extract_search_terms("..abc.."), vec!["abc.."]);
        assert_eq!(extract_search_terms("-x-"), vec!["x-"]);
        assert_eq!(extract_search_terms("!!!"), Vec::<String>::new());
        assert_eq!(extract_search_terms("@@@"), Vec::<String>::new());
        // `\w` is ASCII-only, so a non-ASCII term is stripped to nothing and
        // the query then matches every todo.
        assert_eq!(extract_search_terms("ΟΔΟΣ"), Vec::<String>::new());
        let list = todos(&["ΟΔΟΣ ΝΕΑ", "unrelated"]);
        assert_eq!(filter_by_search(&list, "ΟΔΟΣ"), vec![0, 1]);
    }

    #[test]
    fn lowercase_matches_javascript_including_the_final_sigma() {
        for (input, expected) in [
            ("HeLLo", "hello"),
            ("İ", "i\u{0307}"),
            ("ẞ", "ß"),
            ("Ǆ", "ǆ"),
            ("ǅ", "ǆ"),
            ("Σ", "σ"),
            ("ΑΣ", "ας"),
            ("ΑΣΑ", "ασα"),
            ("ΣΑ", "σα"),
            ("ΟΔΟΣ ΝΕΑ", "οδος νεα"),
            ("ΟΔΟΣ, ΝΕΑ", "οδος, νεα"),
            ("ΑΣ1Α", "ας1α"),
            ("ǅΣ", "ǆς"),
        ] {
            assert_eq!(js_lowercase(input), expected, "input {input:?}");
        }
    }

    #[test]
    fn final_sigma_can_only_match_where_the_oracle_agrees() {
        // A final sigma in the text can only be reached by a term that keeps a
        // sigma inside it, and such a term always has a word character after
        // it, so both implementations compare a non-final sigma.
        let list = todos(&["ΑΣ", "ΑΣΑ", "aσb", "aΣb"]);
        assert_eq!(filter_by_search(&list, "aσb"), vec![2, 3]);
        // A term ending in sigma is stripped, so the Greek text is only
        // reachable through an empty term (matches everything).
        assert_eq!(filter_by_search(&list, "ας"), vec![0, 1, 2, 3]);
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
