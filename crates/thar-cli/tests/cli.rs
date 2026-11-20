//! CLI parity and exit-code tests for the `thar-rs` binary.
//!
//! These spawn the real binary, so they pin `run`'s exit codes, stdout/stderr
//! split, and the environment-limit path without driving a terminal.

mod support;

use support::{TempDir, stderr, stdout, thar};

#[test]
fn help_exits_zero_and_prints_usage_to_stdout() {
    for flag in ["--help", "-h"] {
        let output = thar().arg(flag).output().expect("run thar-rs");
        assert_eq!(output.status.code(), Some(0), "{flag}");
        let text = stdout(&output);
        assert!(text.contains("Usage:"), "{flag}: {text}");
        assert!(text.contains("--no-update-check"), "{flag}: {text}");
        assert!(text.contains("--no-backup"), "{flag}: {text}");
        assert!(text.contains("saved atomically"), "{flag}: {text}");
        assert!(!text.contains("--write"), "{flag}: {text}");
        assert!(!text.contains("read-only"), "{flag}: {text}");
        assert!(stderr(&output).is_empty(), "{flag}");
    }
}

#[test]
fn removed_write_flags_are_unknown_options() {
    for flag in ["--write", "--read-only"] {
        let output = thar().arg(flag).output().expect("run thar-rs");
        assert_eq!(output.status.code(), Some(2), "{flag}");
        let text = stderr(&output);
        assert!(text.contains("Unknown option:"), "{flag}: {text}");
        assert!(text.contains(flag), "{flag}: {text}");
        assert!(text.contains("Usage:"), "{flag}: {text}");
        assert!(stdout(&output).is_empty(), "{flag}");
    }
}

#[test]
fn no_backup_is_accepted_without_a_write_flag() {
    let output = thar()
        .args(["--no-backup", "--help"])
        .output()
        .expect("run thar-rs");
    assert_eq!(output.status.code(), Some(0));
    assert!(stdout(&output).contains("Usage:"));
}

#[test]
fn version_exits_zero_and_prints_only_the_version() {
    for flag in ["--version", "-v"] {
        let output = thar().arg(flag).output().expect("run thar-rs");
        assert_eq!(output.status.code(), Some(0), "{flag}");
        assert_eq!(stdout(&output).trim_end(), thar_cli::VERSION, "{flag}");
        assert!(stderr(&output).is_empty(), "{flag}");
    }
}

#[test]
fn no_update_check_is_accepted_with_help() {
    let output = thar()
        .args(["--no-update-check", "--help"])
        .output()
        .expect("run thar-rs");
    assert_eq!(output.status.code(), Some(0));
    assert!(stdout(&output).contains("Usage:"));
}

#[cfg(unix)]
#[test]
fn a_non_utf8_file_argument_is_accepted() {
    use std::ffi::OsString;
    use std::os::unix::ffi::OsStringExt;

    // The old `std::env::args()` path panicked on this. `args_os` must pass
    // the bytes through parsing; `--help` keeps the run from opening a file.
    let name = OsString::from_vec(b"todo-\xFF.txt".to_vec());
    let output = thar()
        .arg("--help")
        .arg(&name)
        .output()
        .expect("run thar-rs");
    assert_eq!(output.status.code(), Some(0));
    assert!(stdout(&output).contains("Usage:"));
    assert!(stderr(&output).is_empty());
}

#[test]
fn unknown_option_is_a_usage_error() {
    let output = thar().arg("--nope").output().expect("run thar-rs");
    assert_eq!(output.status.code(), Some(2));
    let text = stderr(&output);
    assert!(text.contains("Unknown option: --nope"), "{text}");
    assert!(text.contains("Usage:"), "{text}");
    assert!(stdout(&output).is_empty());
}

#[test]
fn a_missing_file_value_is_a_usage_error() {
    let output = thar().arg("--file").output().expect("run thar-rs");
    assert_eq!(output.status.code(), Some(2));
    let text = stderr(&output);
    assert!(text.contains("--file requires a path."), "{text}");
    assert!(text.contains("Usage:"), "{text}");
}

#[test]
fn an_empty_file_value_is_a_usage_error() {
    let output = thar().arg("--file=").output().expect("run thar-rs");
    assert_eq!(output.status.code(), Some(2));
    let text = stderr(&output);
    assert!(text.contains("Todo file path cannot be empty."), "{text}");
    assert!(text.contains("Usage:"), "{text}");
}

#[test]
fn two_positional_files_are_a_usage_error() {
    let output = thar()
        .args(["one.txt", "two.txt"])
        .output()
        .expect("run thar-rs");
    assert_eq!(output.status.code(), Some(2));
    let text = stderr(&output);
    assert!(
        text.contains("Only one todo file may be specified."),
        "{text}"
    );
    assert!(text.contains("Usage:"), "{text}");
}

#[test]
fn a_positional_file_plus_a_file_flag_is_a_usage_error() {
    let output = thar()
        .args(["one.txt", "--file", "two.txt"])
        .output()
        .expect("run thar-rs");
    assert_eq!(output.status.code(), Some(2));
    assert!(
        stderr(&output).contains("Only one todo file may be specified."),
        "{}",
        stderr(&output)
    );
}

#[test]
fn update_is_recognized_and_rejected_explicitly() {
    for args in [vec!["update"], vec!["update", "--check"]] {
        let output = thar().args(&args).output().expect("run thar-rs");
        assert_eq!(output.status.code(), Some(2), "{args:?}");
        let text = stderr(&output);
        assert!(
            text.contains("self-update is not supported"),
            "{args:?}: {text}"
        );
        assert!(stdout(&output).is_empty(), "{args:?}");
    }
}

#[test]
fn an_invalid_limit_override_is_fatal_with_exit_two() {
    let dir = TempDir::new("cli-invalid-limit");
    let path = dir.join("unused.txt");
    let output = thar()
        .env("THAR_MAX_FILE_BYTES", "nope")
        .arg("--file")
        .arg(&path)
        .output()
        .expect("run thar-rs");
    assert_eq!(output.status.code(), Some(2));
    let text = stderr(&output);
    assert_eq!(
        text,
        "thar-rs: Invalid THAR_MAX_FILE_BYTES: expected a positive integer. \
         Fix the environment variable or unset it to use the default.\n"
    );
    assert!(!text.contains("nope"));
    assert!(stdout(&output).is_empty());
    assert!(
        !path.exists(),
        "a usage error must not create the todo file"
    );
}

#[test]
fn a_zero_limit_override_is_fatal() {
    for (name, value) in [("THAR_MAX_READ_TODOS", "0"), ("THAR_MAX_LINE_CHARS", "-1")] {
        let dir = TempDir::new("cli-zero-limit");
        let path = dir.join("unused.txt");
        let output = thar()
            .env(name, value)
            .arg("--file")
            .arg(&path)
            .output()
            .expect("run thar-rs");
        assert_eq!(output.status.code(), Some(2), "{name}");
        assert!(
            stderr(&output).contains(&format!("Invalid {name}:")),
            "{name}: {}",
            stderr(&output)
        );
        assert!(
            !path.exists(),
            "{name}: a usage error must not create the file"
        );
    }
}

#[test]
fn a_byte_limit_override_is_used_by_the_real_load() {
    let dir = TempDir::new("cli-bytes");
    let path = dir.write("todo.txt", b"hello\n");

    let output = thar()
        .env("THAR_MAX_FILE_BYTES", "2")
        .arg("--file")
        .arg(&path)
        .output()
        .expect("run thar-rs");
    assert_eq!(output.status.code(), Some(1));
    let text = stderr(&output);
    assert!(
        text.contains("Todo file is 6 bytes; the limit is 2 bytes."),
        "{text}"
    );
    assert!(text.contains("Nothing was changed."), "{text}");
}

#[test]
fn line_and_character_limit_overrides_are_used_by_the_real_load() {
    let dir = TempDir::new("cli-lines");
    let lines = dir.write("lines.txt", b"one\ntwo\n");
    let output = thar()
        .env("THAR_MAX_READ_TODOS", "1")
        .arg("--file")
        .arg(&lines)
        .output()
        .expect("run thar-rs");
    assert_eq!(output.status.code(), Some(1));
    assert!(
        stderr(&output).contains("Todo file has 2 lines; the limit is 1."),
        "{}",
        stderr(&output)
    );

    let chars = dir.write("chars.txt", b"abcd\n");
    let output = thar()
        .env("THAR_MAX_LINE_CHARS", "3")
        .arg("--file")
        .arg(&chars)
        .output()
        .expect("run thar-rs");
    assert_eq!(output.status.code(), Some(1));
    assert!(
        stderr(&output).contains("Todo file line 1 is 4 characters; the limit is 3."),
        "{}",
        stderr(&output)
    );
}
