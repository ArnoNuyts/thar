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

/// The same list without `write_all(`.
///
/// `clipboard.rs` legitimately writes clipboard text to a **child process
/// pipe**; every filesystem write API is still forbidden in that file. Keeping
/// the list local instead of skipping the file means a future `std::fs::write`
/// there cannot hide behind the pipe exception.
const CLIPBOARD_FORBIDDEN: [&str; 11] = [
    "fs::write",
    "File::create",
    "File::options",
    "OpenOptions",
    "fs::rename",
    "fs::remove_file",
    "fs::remove_dir",
    "remove_dir_all",
    "create_new",
    "set_len(",
    ".truncate(",
];

/// The write APIs forbidden in one source file.
fn forbidden_apis(path: &Path) -> &'static [&'static str] {
    if path.file_name().is_some_and(|name| name == "clipboard.rs") {
        &CLIPBOARD_FORBIDDEN
    } else {
        &FORBIDDEN
    }
}

/// Every forbidden API present in `source`.
fn violations(path: &Path, source: &str) -> Vec<&'static str> {
    forbidden_apis(path)
        .iter()
        .copied()
        .filter(|api| source.contains(api))
        .collect()
}

/// The part of a source file that is compiled into the binary.
///
/// Unit tests live in top-level `#[cfg(test)] mod …` blocks, whose scratch file
/// I/O is not part of the shipped binary, so those blocks are outside the
/// read-only guarantee. Each block is skipped from its attribute to the
/// matching closing brace at column 0, which is how rustfmt lays out a
/// top-level module. Everything else is scanned: production code before, after,
/// and between test modules.
///
/// A block that is not detected as a top-level test module is scanned, so a
/// missed exemption can only fail the guard loudly. It can never hide a write.
fn production_source(source: &str) -> String {
    let lines: Vec<&str> = source.lines().collect();
    let mut production = String::with_capacity(source.len());
    let mut index = 0;

    while index < lines.len() {
        let line = lines[index];
        let opens_test_module = line == "#[cfg(test)]"
            && lines.get(index + 1).is_some_and(|next| {
                let next = next.trim();
                next.starts_with("mod ") && next.ends_with('{')
            });

        if opens_test_module {
            index += 2;
            while index < lines.len() && lines[index] != "}" {
                index += 1;
            }
            index += 1;
            continue;
        }

        production.push_str(line);
        production.push('\n');
        index += 1;
    }

    production
}

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
        let production = production_source(&source);
        if production.contains("File::open")
            || production.contains("fs::read")
            || production.contains("fs::metadata")
        {
            found_read = true;
        }
        let violations = violations(path, &production);
        assert!(
            violations.is_empty(),
            "{} contains the write API {violations:?}; CP6 must stay read-only",
            path.display()
        );
    }

    // Guard against a scanner that silently reads the wrong tree.
    assert!(found_read, "the scanner did not see the loader's read path");
}

#[test]
fn clipboard_is_scanned_except_for_the_child_pipe_write() {
    let path = Path::new("clipboard.rs");
    assert!(
        violations(path, "stdin.write_all(input)?").is_empty(),
        "the child-pipe write is the one allowed write in clipboard.rs"
    );
    assert_eq!(
        violations(path, "std::fs::write(&path, bytes)?;"),
        ["fs::write"],
        "a filesystem write in clipboard.rs must still be rejected"
    );
    assert_eq!(
        violations(path, "let file = OpenOptions::new().create(true);"),
        ["OpenOptions"],
        "every filesystem API stays forbidden in clipboard.rs"
    );

    // The same source in another file is a violation even for `write_all(`.
    assert_eq!(
        violations(Path::new("terminal.rs"), "stdin.write_all(input)?;"),
        ["write_all("]
    );
}

#[test]
fn test_modules_are_outside_the_scan() {
    // Test-only scratch files do not ship. Production code before, between, or
    // after a test module must still be rejected, so the exemption cannot hide
    // a real write.
    let source = "\
std::fs::write(\"todo.txt\", bytes);
#[cfg(test)]
mod tests {
    std::fs::remove_file(\"todo.txt\");
}
std::fs::write(\"after.txt\", bytes);
#[cfg(test)]
mod more_tests {
    std::fs::remove_file(\"after.txt\");
}
std::fs::write(\"between.txt\", bytes);
";
    let production = production_source(source);
    assert_eq!(
        violations(Path::new("terminal.rs"), &production),
        ["fs::write"],
        "writes before, between, and after test modules must all be scanned"
    );
    assert!(
        !production.contains("remove_file"),
        "test-module bodies stay outside the scan"
    );
}
