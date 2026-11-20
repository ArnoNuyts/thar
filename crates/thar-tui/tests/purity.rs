//! Architectural guard: the TUI crate must not perform ambient I/O.
//!
//! All filesystem, process and network access belongs to `thar-cli` and
//! `thar-store`. Keeping the state, input and rendering layers I/O-free is what
//! lets the whole app run against `TestBackend` and synthetic events.

use std::path::{Path, PathBuf};

const FORBIDDEN: [&str; 4] = ["std::fs", "std::process", "std::net", "OpenOptions"];

fn rust_files(directory: &Path, found: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(directory).expect("read crate source") {
        let path = entry.expect("source entry").path();
        if path.is_dir() {
            rust_files(&path, found);
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            found.push(path);
        }
    }
}

#[test]
fn the_tui_crate_has_no_ambient_io() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    rust_files(&root, &mut files);
    assert!(!files.is_empty(), "no sources under {}", root.display());

    for path in files {
        let source = std::fs::read_to_string(&path).expect("read source");
        for api in FORBIDDEN {
            assert!(
                !source.contains(api),
                "{} contains {api}; filesystem and process I/O must live in \
                 thar-cli or thar-store",
                path.display()
            );
        }
    }
}
