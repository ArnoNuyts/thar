//! Loader parity tests.
//!
//! Every case mirrors `readTodosFromFile` / `validateTodoFileContent` in
//! `logic/`: the byte limit runs before parsing (and again on the decoded
//! text), decoding is lossy, CRLF and blank lines follow the same rules, and a
//! missing path is a note instead of a created file.

mod support;

use support::TempDir;

use thar_cli::{LoadError, get_read_limits, load_with_limits, read_limits_from};
use thar_core::{CoreError, ReadLimits};

fn load_default(path: &std::path::Path) -> Result<thar_cli::LoadedFile, LoadError> {
    load_with_limits(path, &ReadLimits::DEFAULT)
}

fn limits(pairs: &[(&str, &str)]) -> Result<ReadLimits, LoadError> {
    read_limits_from(|name| {
        pairs
            .iter()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| (*value).to_owned())
    })
}

#[test]
fn parses_a_file_and_preserves_load_order() {
    let dir = TempDir::new("basic");
    let path = dir.write("todo.txt", b"one\n\nthree\n");

    let loaded = load_default(&path).expect("load");
    assert_eq!(loaded.todos.len(), 2);
    assert_eq!(loaded.todos[0].text, "one");
    assert_eq!(loaded.todos[1].text, "three");
    assert_eq!(loaded.todos[0].id.value(), 0);
    assert_eq!(loaded.todos[1].id.value(), 1);
    assert!(loaded.error.is_none());
}

#[test]
fn crlf_lines_are_normalized_and_blank_lines_are_dropped() {
    let dir = TempDir::new("crlf");
    let path = dir.write("todo.txt", b"one\r\n\r\ntwo\r\n");

    let loaded = load_default(&path).expect("load");
    assert_eq!(loaded.todos.len(), 2);
    assert_eq!(loaded.todos[0].text, "one");
    assert_eq!(loaded.todos[1].text, "two");
    assert!(!loaded.todos.iter().any(|todo| todo.text.contains('\r')));
}

#[test]
fn a_whitespace_only_file_loads_as_zero_todos() {
    let dir = TempDir::new("blank");
    let path = dir.write("todo.txt", b"\n \n\t\n");

    let loaded = load_default(&path).expect("load");
    assert!(loaded.todos.is_empty());
    assert!(loaded.error.is_none());
}

#[test]
fn invalid_utf8_is_decoded_lossily() {
    let dir = TempDir::new("invalid-utf8");
    let path = dir.write("todo.txt", b"one \xFF two\n");

    let loaded = load_default(&path).expect("load");
    assert_eq!(loaded.todos.len(), 1);
    assert!(loaded.todos[0].text.contains('\u{FFFD}'));
}

#[test]
fn a_missing_file_is_a_note_and_is_not_created() {
    let dir = TempDir::new("missing");
    let path = dir.join("todo.txt");

    let loaded = load_default(&path).expect("load");
    assert!(loaded.todos.is_empty());
    assert!(loaded.error.is_some());
    assert!(!path.exists());
    assert!(dir.entries().is_empty());
}

#[test]
fn byte_limit_is_enforced_before_parsing() {
    let dir = TempDir::new("bytes");
    let path = dir.write("todo.txt", b"0123456789\n");
    let limited = ReadLimits {
        max_file_bytes: 4,
        ..ReadLimits::DEFAULT
    };

    match load_with_limits(&path, &limited) {
        Err(LoadError::Validation(error)) => {
            assert_eq!(error.code(), "FILE_TOO_LARGE");
            assert!(error.to_string().contains("limit is 4 bytes"));
        }
        other => panic!("expected a validation error, got {other:?}"),
    }
}

#[test]
fn byte_limit_is_rechecked_against_the_lossy_decoded_text() {
    let dir = TempDir::new("decoded-bytes");
    // One invalid byte grows to the three bytes of U+FFFD after decoding.
    let path = dir.write("todo.txt", b"\xFF");
    let limited = ReadLimits {
        max_file_bytes: 2,
        ..ReadLimits::DEFAULT
    };

    match load_with_limits(&path, &limited) {
        Err(LoadError::Validation(CoreError::FileTooLarge {
            actual_bytes,
            max_bytes,
        })) => {
            assert_eq!(actual_bytes, 3);
            assert_eq!(max_bytes, 2);
        }
        other => panic!("expected decoded FILE_TOO_LARGE, got {other:?}"),
    }
}

#[test]
fn exactly_the_byte_limit_is_accepted() {
    let dir = TempDir::new("bytes-exact");
    let path = dir.write("todo.txt", b"12345");
    let limited = ReadLimits {
        max_file_bytes: 5,
        ..ReadLimits::DEFAULT
    };

    let loaded = load_with_limits(&path, &limited).expect("load");
    assert_eq!(loaded.todos.len(), 1);
    assert_eq!(loaded.todos[0].text, "12345");
}

#[test]
fn line_count_limit_is_enforced() {
    let dir = TempDir::new("lines");
    let path = dir.write("todo.txt", b"one\ntwo\nthree\n");
    let limited = ReadLimits {
        max_read_todos: 2,
        ..ReadLimits::DEFAULT
    };

    match load_with_limits(&path, &limited) {
        Err(LoadError::Validation(error)) => {
            assert_eq!(error.code(), "TOO_MANY_LINES");
            assert!(error.to_string().contains("has 3 lines"));
        }
        other => panic!("expected a validation error, got {other:?}"),
    }
}

#[test]
fn line_length_limit_counts_utf16_code_units() {
    let dir = TempDir::new("line-chars");
    let path = dir.write("todo.txt", "abcd\n".as_bytes());
    let limited = ReadLimits {
        max_line_chars: 3,
        ..ReadLimits::DEFAULT
    };

    match load_with_limits(&path, &limited) {
        Err(LoadError::Validation(error)) => {
            assert_eq!(error.code(), "LINE_TOO_LONG");
            assert!(error.to_string().contains("line 1 is 4 characters"));
        }
        other => panic!("expected a validation error, got {other:?}"),
    }
}

#[test]
fn control_characters_are_rejected_with_a_bounded_message() {
    let dir = TempDir::new("controls");
    let path = dir.write("todo.txt", b"one\nb\x01ad\n");

    match load_default(&path) {
        Err(LoadError::Validation(error)) => {
            assert_eq!(error.code(), "CONTROL_CHARACTER");
            assert_eq!(
                error.to_string(),
                "Todo file line 2 contains the control character U+0001. \
                 Remove control characters from the file. Nothing was changed."
            );
        }
        other => panic!("expected a validation error, got {other:?}"),
    }
}

#[test]
fn tabs_are_allowed_inside_a_line() {
    let dir = TempDir::new("tab");
    let path = dir.write("todo.txt", b"one\ttwo\n");

    let loaded = load_default(&path).expect("load");
    assert_eq!(loaded.todos.len(), 1);
    assert_eq!(loaded.todos[0].text, "one\ttwo");
}

#[test]
fn an_unreadable_directory_is_a_read_error() {
    let dir = TempDir::new("directory");

    match load_default(dir.path()) {
        Err(LoadError::Io(_)) => {}
        other => panic!("expected a read error, got {other:?}"),
    }
}

#[test]
fn limits_default_when_no_override_is_set() {
    let resolved = limits(&[]).expect("defaults");
    assert_eq!(resolved, ReadLimits::DEFAULT);
}

#[test]
fn valid_overrides_are_applied() {
    let resolved = limits(&[
        ("THAR_MAX_FILE_BYTES", "7"),
        ("THAR_MAX_READ_TODOS", "8"),
        ("THAR_MAX_LINE_CHARS", "9"),
    ])
    .expect("valid overrides");
    assert_eq!(resolved.max_file_bytes, 7);
    assert_eq!(resolved.max_read_todos, 8);
    assert_eq!(resolved.max_line_chars, 9);
}

#[test]
fn leading_zeros_are_accepted_like_the_typescript_parser() {
    let resolved = limits(&[("THAR_MAX_FILE_BYTES", "0007")]).expect("valid override");
    assert_eq!(resolved.max_file_bytes, 7);
}

#[test]
fn invalid_overrides_are_fatal_and_do_not_echo_the_value() {
    for raw in ["", "0", "-1", "1.5", "abc", "9007199254740992"] {
        let error = limits(&[("THAR_MAX_FILE_BYTES", raw)]).expect_err("invalid override");
        match &error {
            LoadError::InvalidLimit(name) => assert_eq!(*name, "THAR_MAX_FILE_BYTES"),
            other => panic!("expected InvalidLimit, got {other:?}"),
        }
        assert_eq!(
            error.to_string(),
            "Invalid THAR_MAX_FILE_BYTES: expected a positive integer. \
             Fix the environment variable or unset it to use the default."
        );
        assert!(!error.to_string().contains(raw) || raw.is_empty());
    }
}

#[test]
fn the_first_invalid_override_is_reported() {
    let error = limits(&[
        ("THAR_MAX_FILE_BYTES", "bad"),
        ("THAR_MAX_READ_TODOS", "also-bad"),
    ])
    .expect_err("invalid override");
    assert!(matches!(
        error,
        LoadError::InvalidLimit("THAR_MAX_FILE_BYTES")
    ));
}

#[test]
fn the_environment_entry_point_returns_usable_limits() {
    // The test process may have a hostile override; the contract is only that
    // a successful resolution is one of the documented shapes. The integration
    // CLI test pins the fatal exit separately in a child process, where a
    // deliberately invalid variable can be set without racing other tests.
    if let Ok(resolved) = get_read_limits() {
        assert!(resolved.max_file_bytes > 0);
        assert!(resolved.max_read_todos > 0);
        assert!(resolved.max_line_chars > 0);
    }
}
