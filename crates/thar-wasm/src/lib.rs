//! Minimal WebAssembly boundary for the Thar core.
//!
//! CP2a only needs a scaffold that proves the pipeline, the Node target, and
//! the size budget. The coarse batch API (`parse_file`, `serialize_file`,
//! `build_rows`, `apply_command`, …) lands in CP2b on top of [`thar_core`].
//!
//! Strings cross the boundary once per call; there are no per-row getters.

use wasm_bindgen::prelude::*;

/// Version of the embedded [`thar_core`], used by the Node smoke test.
#[wasm_bindgen(js_name = coreVersion)]
pub fn core_version() -> String {
    thar_core::VERSION.to_owned()
}

/// Number of non-blank lines in `text`.
///
/// This mirrors the loader's `line.trim()` filter without allocating a todo
/// list, which keeps the scaffold honest about UTF-8 and blank handling.
#[wasm_bindgen(js_name = recordCount)]
pub fn record_count(text: &str) -> usize {
    text.split('\n')
        .filter(|line| !thar_core::is_blank_line(line))
        .count()
}

#[cfg(test)]
mod tests {
    use super::{core_version, record_count};

    #[test]
    fn counts_non_blank_lines() {
        assert_eq!(record_count(""), 0);
        assert_eq!(record_count("\n\n"), 0);
        assert_eq!(record_count("one\ntwo\n"), 2);
        assert_eq!(record_count("a\n\nb\n"), 2);
        assert_eq!(record_count("  \n\u{FEFF}\ntext"), 1);
        assert_eq!(record_count("a\r\nb\r\n"), 2);
    }

    #[test]
    fn reports_the_core_version() {
        assert_eq!(core_version(), thar_core::VERSION);
        assert!(!core_version().is_empty());
    }
}
