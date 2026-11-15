//! Minimal WebAssembly boundary for the Thar core.
//!
//! `CP2a` only needs a scaffold that proves the pipeline, the Node target, and
//! the size budget. The coarse batch API (`parse_file`, `serialize_file`,
//! `build_rows`, `apply_command`, …) lands in `CP2b` on top of [`thar_core`].
//!
//! Strings cross the boundary once per call; there are no per-row getters.
//!
//! Decoding is lossy on the JS side before a value reaches this boundary:
//! `String::from_utf8_lossy` turns invalid file bytes into `U+FFFD`, exactly as
//! the TypeScript reader does. This crate therefore only ever sees valid UTF-8.

#![forbid(unsafe_code)]
#![deny(missing_docs)]

use wasm_bindgen::prelude::*;

/// Version of the embedded [`thar_core`], used by the Node smoke test.
#[wasm_bindgen(js_name = coreVersion)]
#[must_use]
pub fn core_version() -> String {
    thar_core::VERSION.to_owned()
}

/// Number of non-blank lines in `text`.
///
/// This is the `CP2a` scaffold used to prove the pipeline, not a load path: it
/// filters with the core's JS-whitespace blank test, but it intentionally does
/// **not** strip CRLF, enforce the read limits, reject control characters, or
/// parse records. It is replaced by the real batch API (or removed) in `CP2b`.
#[wasm_bindgen(js_name = recordCount)]
#[must_use]
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
        // The scaffold does not strip CRLF: `a\r` is a non-blank line.
        assert_eq!(record_count("a\r\nb\r\n"), 2);
    }

    #[test]
    fn reports_the_core_version() {
        assert_eq!(core_version(), thar_core::VERSION);
        assert!(!core_version().is_empty());
    }
}
