//! The read-only guarantee at the source level.
//!
//! A runtime test can only prove the paths it exercises. This test scans every
//! Rust source file in the `thar-cli` and `thar-tui` crates and fails if a
//! write-capable API appears, so the CP6 binary cannot accidentally link a
//! writer later. `thar-core` has no I/O at all.

use std::path::{Path, PathBuf};

/// Filesystem APIs that would make the binary able to modify user data.
const FORBIDDEN: [&str; 12] = [
    "fs::write",
    "File::create",
    "File::options",
    "OpenOptions",
    "fs::rename",
    "fs::remove_file",
    "fs::remove_dir",
    "remove_dir_all",
    "create_new",
    "write_all(",
    "set_len(",
    ".truncate(",
];

fn rust_sources(directory: &Path, found: &mut Vec<PathBuf>) {
    let entries = std::fs::read_dir(directory)
        .unwrap_or_else(|error| panic!("read {}: {error}", directory.display()));
    for entry in entries {
        let entry = entry.expect("read source entry");
        let path = entry.path();
        if path.is_dir() {
            rust_sources(&path, found);
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            found.push(path);
        }
    }
}

#[test]
fn the_tui_crates_contain_no_write_path() {
    let crate_root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut sources = Vec::new();
    for relative in ["src", "../thar-tui/src"] {
        let root = crate_root.join(relative);
        let before = sources.len();
        rust_sources(&root, &mut sources);
        assert!(
            sources.len() > before,
            "no sources under {}",
            root.display()
        );
    }

    let mut found_read = false;
    for path in &sources {
        let source = std::fs::read_to_string(path)
            .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
        if source.contains("File::open")
            || source.contains("fs::read")
            || source.contains("fs::metadata")
        {
            found_read = true;
        }
        for forbidden in FORBIDDEN {
            assert!(
                !source.contains(forbidden),
                "{} contains the write API `{forbidden}`; CP6 must stay read-only",
                path.display()
            );
        }
    }

    // Guard against a scanner that silently reads the wrong tree.
    assert!(found_read, "the scanner did not see the loader's read path");
}
