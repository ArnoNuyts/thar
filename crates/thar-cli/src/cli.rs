//! Command-line parsing, mirroring `logic/cli.ts`.
//!
//! The surface is the TUI's: one todo file plus `--write`, `--read-only`,
//! `--no-backup` and `--no-update-check`, the script-compatible `--help` and
//! `--version`, and the `update` subcommand (which reports that self-update is
//! unsupported). Parsing produces a [`CliCommand`] so the startup path cannot
//! read a flag that was never set.
//!
//! Arguments are [`OsString`]s, not `String`s: a todo file name is a filesystem
//! path and may be non-UTF-8. Flags are recognized only when the argument is
//! valid UTF-8; any other argument is a positional file path and reaches the
//! loader unchanged. A non-UTF-8 argument that starts with `-` is still an
//! option-shaped token, so it is rejected instead of becoming a file name
//! (use `--` to pass such a path deliberately).

use std::ffi::{OsStr, OsString};
use std::path::PathBuf;

use thar_store::BackupPolicy;

/// Default todo file, relative to the process working directory.
pub const DEFAULT_FILENAME: &str = "todo.txt";

/// True when the raw platform bytes start with the ASCII option marker.
///
/// This is deliberately byte-based: [`OsStr::to_str`] fails for a non-UTF-8
/// argument, but the leading `-` is still readable on every supported host.
fn starts_with_dash(value: &OsStr) -> bool {
    value.as_encoded_bytes().first() == Some(&b'-')
}

/// The parsed command line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CliCommand {
    /// Print the usage text and exit successfully.
    Help,
    /// Print the crate version and exit successfully.
    Version,
    /// The `update` subcommand was requested.
    ///
    /// `--check` and `--yes` are accepted for command-line parity; this build
    /// reports that self-update is unsupported regardless.
    Update,
    /// Open the TUI for one todo file.
    Run {
        /// Todo file to open.
        file: PathBuf,
        /// `--write` was passed: the backup policy to save with.
        ///
        /// `None` means read-only; the parser never combines a policy with
        /// `--read-only`, so the invalid "writable without a policy" case
        /// cannot be represented.
        write: Option<BackupPolicy>,
    },
}

/// A bounded usage error.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CliError {
    message: String,
}

impl CliError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl core::fmt::Display for CliError {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for CliError {}

/// Usage text; the flags match the Ink app's help.
#[must_use]
pub fn format_usage(version: &str) -> String {
    [
        format!("thar-rs {version}"),
        String::new(),
        "A todo.txt TUI for the terminal.".to_owned(),
        String::new(),
        "Usage:".to_owned(),
        "  thar-rs [options] [file]".to_owned(),
        String::new(),
        "Arguments:".to_owned(),
        format!("  file                  Todo file to open (default: ./{DEFAULT_FILENAME})"),
        String::new(),
        "Options:".to_owned(),
        "  -f, --file <path>     Todo file to open".to_owned(),
        "  -h, --help            Show this help".to_owned(),
        "  -v, --version         Show version".to_owned(),
        "  --write               Allow edits; default is read-only".to_owned(),
        "  --read-only           Force the read-only default".to_owned(),
        "  --no-backup           Skip todo.txt.bak before the first save (needs --write)"
            .to_owned(),
        "  --no-update-check     Accepted for CLI parity".to_owned(),
        String::new(),
        "Without --write this binary never creates, saves, or archives todos.".to_owned(),
        "With --write, edits are debounced and saved atomically; todo.txt.bak keeps".to_owned(),
        "the original until the first save of the session.".to_owned(),
    ]
    .join("\n")
}

/// Parse the arguments after the program name.
///
/// Flags are matched through [`OsStr::to_str`]. A non-UTF-8 argument is a
/// positional file path unless it starts with `-`, which is rejected as an
/// unknown option; `--` still allows such a path. `--file` consumes the next
/// argument as an [`OsString`] without decoding it. Help wins over version,
/// matching the startup order in [`crate::run`].
///
/// # Errors
///
/// Returns a [`CliError`] for an unknown option, a missing `--file` value, an
/// empty path, more than one file argument, `--write` together with
/// `--read-only`, or `--no-backup` without `--write`.
pub fn parse_cli_args(argv: &[OsString]) -> Result<CliCommand, CliError> {
    if argv.first().and_then(|argument| argument.to_str()) == Some("update") {
        let rest = &argv[1..];
        // `update --version` prints the version today, so it is still a
        // version request rather than an update run.
        if rest
            .iter()
            .any(|argument| matches!(argument.to_str(), Some("--version" | "-v")))
        {
            return Ok(CliCommand::Version);
        }
        return Ok(CliCommand::Update);
    }

    let mut file: Option<PathBuf> = None;
    let mut help = false;
    let mut version = false;
    let mut write = false;
    let mut read_only_flag = false;
    let mut no_backup = false;
    let mut end_of_options = false;

    let mut set_file = |value: &OsStr| -> Result<(), CliError> {
        if value.is_empty() {
            return Err(CliError::new("Todo file path cannot be empty."));
        }
        if file.is_some() {
            return Err(CliError::new("Only one todo file may be specified."));
        }
        file = Some(PathBuf::from(value));
        Ok(())
    };

    let mut iterator = argv.iter();
    while let Some(argument) = iterator.next() {
        // Only valid UTF-8 can be a flag. A non-UTF-8 argument falls through
        // to the positional branch below and is preserved byte for byte.
        let flag = if end_of_options {
            None
        } else {
            argument.to_str()
        };

        match flag {
            Some("--") => end_of_options = true,
            Some("-h" | "--help") => help = true,
            Some("-v" | "--version") => version = true,
            // Accepted for command-line parity; this build has no update check.
            Some("--no-update-check") => {}
            Some("--write") => write = true,
            Some("--read-only") => read_only_flag = true,
            Some("--no-backup") => no_backup = true,
            Some(name @ ("-f" | "--file")) => {
                let value = iterator
                    .next()
                    .ok_or_else(|| CliError::new(format!("{name} requires a path.")))?;
                set_file(value)?;
            }
            Some(value) if value.starts_with("--file=") => {
                set_file(OsStr::new(&value["--file=".len()..]))?;
            }
            Some(value) if value.starts_with('-') && value != "-" => {
                return Err(CliError::new(format!("Unknown option: {value}")));
            }
            // A non-UTF-8 token cannot be checked as a flag, but an argument
            // that starts with `-` is still option-shaped. Treating it as a
            // path would let `--file=<bad bytes>` silently create a file whose
            // name is the whole option.
            _ if !end_of_options && starts_with_dash(argument) && argument != "-" => {
                return Err(CliError::new(format!(
                    "Unknown option: {}",
                    argument.to_string_lossy()
                )));
            }
            _ => set_file(argument.as_os_str())?,
        }
    }

    if write && read_only_flag {
        return Err(CliError::new(
            "--write and --read-only cannot be used together.",
        ));
    }
    if no_backup && !write {
        return Err(CliError::new("--no-backup requires --write."));
    }

    if help {
        return Ok(CliCommand::Help);
    }
    if version {
        return Ok(CliCommand::Version);
    }

    let policy = if no_backup {
        BackupPolicy::None
    } else {
        BackupPolicy::Bak
    };
    Ok(CliCommand::Run {
        file: file.unwrap_or_else(|| PathBuf::from(DEFAULT_FILENAME)),
        // `--no-backup` already requires `--write`, so a policy can only
        // exist in write mode.
        write: write.then_some(policy),
    })
}

#[cfg(test)]
mod tests {
    use super::{CliCommand, DEFAULT_FILENAME, format_usage, parse_cli_args};
    use std::ffi::OsString;
    use std::path::{Path, PathBuf};
    use thar_store::BackupPolicy;

    fn args(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    fn parse(values: &[&str]) -> CliCommand {
        parse_cli_args(&args(values)).expect("valid arguments")
    }

    fn run(values: &[&str]) -> (PathBuf, Option<BackupPolicy>) {
        match parse(values) {
            CliCommand::Run { file, write } => (file, write),
            other => panic!("expected a run command, got {other:?}"),
        }
    }

    #[test]
    fn defaults_to_todo_txt() {
        let (file, write) = run(&[]);
        assert_eq!(file, Path::new(DEFAULT_FILENAME));
        assert_eq!(write, None);
        assert!(!matches!(
            parse(&[]),
            CliCommand::Help | CliCommand::Version
        ));
    }

    #[test]
    fn accepts_a_positional_file_and_the_file_flags() {
        assert_eq!(run(&["work.txt"]).0, Path::new("work.txt"));
        assert_eq!(run(&["-f", "work.txt"]).0, Path::new("work.txt"));
        assert_eq!(run(&["--file=work.txt"]).0, Path::new("work.txt"));
    }

    #[test]
    fn keeps_scripts_compatible_flags() {
        assert_eq!(parse(&["--help"]), CliCommand::Help);
        assert_eq!(parse(&["-h"]), CliCommand::Help);
        assert_eq!(parse(&["-v"]), CliCommand::Version);
        assert_eq!(parse(&["--version"]), CliCommand::Version);
        assert!(matches!(
            parse(&["--no-update-check"]),
            CliCommand::Run { .. }
        ));
    }

    #[test]
    fn help_wins_over_version_like_startup_does() {
        assert_eq!(parse(&["--version", "--help"]), CliCommand::Help);
    }

    #[test]
    fn rejects_unknown_options_and_duplicate_files() {
        assert!(parse_cli_args(&args(&["--nope"])).is_err());
        assert!(parse_cli_args(&args(&["-f"])).is_err());
        assert!(parse_cli_args(&args(&["one", "two"])).is_err());
        assert!(parse_cli_args(&args(&["--file="])).is_err());
    }

    #[test]
    fn double_dash_ends_option_parsing() {
        let (file, ..) = run(&["--", "--help"]);
        assert_eq!(file, Path::new("--help"));
        assert_ne!(parse(&["--", "--help"]), CliCommand::Help);
    }

    #[test]
    fn update_subcommand_is_recognized_but_not_a_file() {
        assert_eq!(parse(&["update", "--check"]), CliCommand::Update);
        assert_eq!(parse(&["update"]), CliCommand::Update);
        assert_eq!(parse(&["update", "--yes"]), CliCommand::Update);
        assert_eq!(parse(&["update", "-y", "--check"]), CliCommand::Update);
        assert_eq!(parse(&["update", "--version"]), CliCommand::Version);
    }

    #[test]
    fn accepts_write_mode_and_backup_flags() {
        let (file, write) = run(&["--write", "work.txt"]);
        assert_eq!(write, Some(BackupPolicy::Bak));
        assert_eq!(file, Path::new("work.txt"));

        let (_, write) = run(&["--write", "--no-backup"]);
        assert_eq!(write, Some(BackupPolicy::None));

        let (_, write) = run(&["--read-only"]);
        assert_eq!(write, None);
    }

    #[test]
    fn write_and_read_only_together_are_a_usage_error() {
        assert!(parse_cli_args(&args(&["--write", "--read-only"])).is_err());
        // The conflict is a parse error even when help was also requested.
        assert!(parse_cli_args(&args(&["--help", "--write", "--read-only"])).is_err());
    }

    #[test]
    fn usage_names_the_binary_and_the_read_only_contract() {
        let usage = format_usage("0.1.0");
        assert!(usage.contains("thar-rs 0.1.0"));
        assert!(usage.contains("--no-update-check"));
        assert!(usage.contains("--write"));
        assert!(usage.contains("read-only"));
    }

    #[test]
    fn command_derives_debug_and_eq() {
        let command = parse(&[]);
        let clone: CliCommand = command.clone();
        assert_eq!(command, clone);
    }

    #[cfg(unix)]
    #[test]
    fn a_non_utf8_positional_path_is_preserved() {
        use std::os::unix::ffi::{OsStrExt, OsStringExt};

        let raw = b"todo-\xFF.txt".to_vec();
        let command = parse_cli_args(&[OsString::from_vec(raw.clone())]).expect("valid");
        match command {
            CliCommand::Run { file, .. } => {
                assert_eq!(file.as_os_str().as_bytes(), raw);
            }
            other => panic!("expected a run command, got {other:?}"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn the_file_flag_consumes_a_non_utf8_value_unchanged() {
        use std::os::unix::ffi::{OsStrExt, OsStringExt};

        let raw = b"work-\xFE.txt".to_vec();
        let command = parse_cli_args(&[OsString::from("--file"), OsString::from_vec(raw.clone())])
            .expect("valid");
        match command {
            CliCommand::Run { file, .. } => {
                assert_eq!(file.as_os_str().as_bytes(), raw);
            }
            other => panic!("expected a run command, got {other:?}"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_non_utf8_option_shaped_argument_is_not_a_file() {
        use std::os::unix::ffi::OsStringExt;

        let mut raw = b"--file=".to_vec();
        raw.push(0xFF);
        let error = parse_cli_args(&[OsString::from_vec(raw)]).expect_err("rejected");
        assert!(error.to_string().contains("Unknown option"), "{error}");
    }

    #[cfg(unix)]
    #[test]
    fn a_non_utf8_path_after_double_dash_is_still_a_file() {
        use std::os::unix::ffi::{OsStrExt, OsStringExt};

        let mut raw = b"-work-".to_vec();
        raw.push(0xFF);
        let command = parse_cli_args(&[OsString::from("--"), OsString::from_vec(raw.clone())])
            .expect("valid");
        match command {
            CliCommand::Run { file, .. } => {
                assert_eq!(file.as_os_str().as_bytes(), raw);
            }
            other => panic!("expected a run command, got {other:?}"),
        }
    }

    #[test]
    fn no_backup_requires_write_mode() {
        let error = parse_cli_args(&args(&["--no-backup"])).expect_err("rejected");
        assert_eq!(error.to_string(), "--no-backup requires --write.");
        assert_eq!(run(&["--write", "--no-backup"]).1, Some(BackupPolicy::None));
    }

    // A lone UTF-16 surrogate is not valid UTF-8 but is a legal Windows
    // filename component. A bare positional token must be preserved verbatim as
    // the path, while a value attached to the `--file=` flag cannot be checked
    // as a flag and is therefore rejected as option-shaped. Neither case may
    // panic while decoding.
    #[cfg(windows)]
    fn lone_surrogate() -> OsString {
        use std::os::windows::ffi::OsStringExt;

        OsString::from_wide(&[0xD800])
    }

    #[cfg(windows)]
    #[test]
    fn a_lone_surrogate_positional_path_does_not_panic() {
        let command = parse_cli_args(&[lone_surrogate()])
            .expect("a lone surrogate positional path must be preserved");
        match command {
            CliCommand::Run { file, .. } => {
                assert_eq!(file.as_os_str(), lone_surrogate().as_os_str());
            }
            other => panic!("expected a run command, got {other:?}"),
        }
    }

    #[cfg(windows)]
    #[test]
    fn a_lone_surrogate_after_the_file_flag_does_not_panic() {
        use std::os::windows::ffi::OsStringExt;

        let mut wide: Vec<u16> = "--file=".encode_utf16().collect();
        wide.push(0xD800);
        // A non-UTF-8 token cannot be checked as a flag, so `--file=<bad>` is
        // rejected as option-shaped; it must never become the path.
        let result = parse_cli_args(&[OsString::from_wide(&wide)]);
        assert!(
            result.is_err(),
            "a non-UTF-8 --file= value must be rejected, got {result:?}"
        );
    }
}
