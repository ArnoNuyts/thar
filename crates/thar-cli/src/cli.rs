//! Command-line parsing, mirroring `logic/cli.ts`.
//!
//! The supported surface is the one CP6 needs: the file argument and the three
//! flags that keep `thar-rs` script-compatible (`--help`, `--version`,
//! `--no-update-check`). Anything that would need the writer, the updater, or
//! an interactive modal is rejected here rather than halfway through startup.

/// Default todo file, relative to the process working directory.
pub const DEFAULT_FILENAME: &str = "todo.txt";

/// Parsed command-line options.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CliOptions {
    /// Todo file to open.
    pub file: String,
    /// Print usage and exit.
    pub help: bool,
    /// Print the version and exit.
    pub version: bool,
    /// Accepted for CLI parity; CP6 has no update check to disable.
    pub no_update_check: bool,
    /// The `update` subcommand was requested.
    pub update: bool,
    /// `update --check` was requested.
    pub update_check_only: bool,
    /// `update --yes` was requested.
    pub update_yes: bool,
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
        "A read-only Rust todo.txt TUI for the terminal.".to_owned(),
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
        "  --no-update-check     Accepted for CLI parity".to_owned(),
        String::new(),
        "This binary is read-only: it never creates, saves, or archives todos.".to_owned(),
        "Editing, the command menu and the modals arrive with CP7.".to_owned(),
    ]
    .join("\n")
}

/// Parse the arguments after the program name.
///
/// # Errors
///
/// Returns a [`CliError`] for an unknown option, a missing `--file` value, an
/// empty path, or more than one file argument.
pub fn parse_cli_args(argv: &[String]) -> Result<CliOptions, CliError> {
    if argv.first().map(String::as_str) == Some("update") {
        return Ok(CliOptions {
            file: DEFAULT_FILENAME.to_owned(),
            help: false,
            version: argv.iter().any(|arg| arg == "--version" || arg == "-v"),
            no_update_check: false,
            update: true,
            update_check_only: argv.iter().any(|arg| arg == "--check"),
            update_yes: argv.iter().any(|arg| arg == "--yes" || arg == "-y"),
        });
    }

    let mut file: Option<String> = None;
    let mut help = false;
    let mut version = false;
    let mut no_update_check = false;
    let mut end_of_options = false;

    let mut set_file = |value: &str| -> Result<(), CliError> {
        if value.is_empty() {
            return Err(CliError::new("Todo file path cannot be empty."));
        }
        if file.is_some() {
            return Err(CliError::new("Only one todo file may be specified."));
        }
        file = Some(value.to_owned());
        Ok(())
    };

    let mut index = 0;
    while index < argv.len() {
        let argument = &argv[index];

        if !end_of_options && argument == "--" {
            end_of_options = true;
            index += 1;
            continue;
        }

        if !end_of_options && (argument == "-h" || argument == "--help") {
            help = true;
            index += 1;
            continue;
        }

        if !end_of_options && (argument == "-v" || argument == "--version") {
            version = true;
            index += 1;
            continue;
        }

        if !end_of_options && argument == "--no-update-check" {
            no_update_check = true;
            index += 1;
            continue;
        }

        if !end_of_options && (argument == "-f" || argument == "--file") {
            let value = argv
                .get(index + 1)
                .ok_or_else(|| CliError::new(format!("{argument} requires a path.")))?;
            set_file(value)?;
            index += 2;
            continue;
        }

        if !end_of_options && let Some(value) = argument.strip_prefix("--file=") {
            set_file(value)?;
            index += 1;
            continue;
        }

        if !end_of_options && argument.starts_with('-') && argument != "-" {
            return Err(CliError::new(format!("Unknown option: {argument}")));
        }

        set_file(argument)?;
        index += 1;
    }

    Ok(CliOptions {
        file: file.unwrap_or_else(|| DEFAULT_FILENAME.to_owned()),
        help,
        version,
        no_update_check,
        update: false,
        update_check_only: false,
        update_yes: false,
    })
}

#[cfg(test)]
mod tests {
    use super::{CliOptions, DEFAULT_FILENAME, format_usage, parse_cli_args};

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn defaults_to_todo_txt() {
        let options = parse_cli_args(&args(&[])).expect("valid");
        assert_eq!(options.file, DEFAULT_FILENAME);
        assert!(!options.help && !options.version && !options.update);
    }

    #[test]
    fn accepts_a_positional_file_and_the_file_flags() {
        assert_eq!(
            parse_cli_args(&args(&["work.txt"])).expect("valid").file,
            "work.txt"
        );
        assert_eq!(
            parse_cli_args(&args(&["-f", "work.txt"]))
                .expect("valid")
                .file,
            "work.txt"
        );
        assert_eq!(
            parse_cli_args(&args(&["--file=work.txt"]))
                .expect("valid")
                .file,
            "work.txt"
        );
    }

    #[test]
    fn keeps_scripts_compatible_flags() {
        let options = parse_cli_args(&args(&["--help"])).expect("valid");
        assert!(options.help);
        assert!(parse_cli_args(&args(&["-v"])).expect("valid").version);
        assert!(
            parse_cli_args(&args(&["--no-update-check"]))
                .expect("valid")
                .no_update_check
        );
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
        let options = parse_cli_args(&args(&["--", "--help"])).expect("valid");
        assert!(!options.help);
        assert_eq!(options.file, "--help");
    }

    #[test]
    fn update_subcommand_is_recognized_but_not_a_file() {
        let options = parse_cli_args(&args(&["update", "--check"])).expect("valid");
        assert!(options.update);
        assert!(options.update_check_only);
        assert_eq!(options.file, DEFAULT_FILENAME);
    }

    #[test]
    fn usage_names_the_binary_and_the_read_only_contract() {
        let usage = format_usage("0.1.0");
        assert!(usage.contains("thar-rs 0.1.0"));
        assert!(usage.contains("--no-update-check"));
        assert!(usage.contains("read-only"));
    }

    #[test]
    fn options_derive_debug_and_eq() {
        let options = parse_cli_args(&args(&[])).expect("valid");
        let clone: CliOptions = options.clone();
        assert_eq!(options, clone);
    }
}
