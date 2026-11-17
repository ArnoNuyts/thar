//! Clipboard copy and paste through the platform's command-line tool.
//!
//! This is a direct port of `logic/clipboard.ts`: no graphical toolkit, no
//! extra dependency, and the same command fallbacks. It lives in `thar-cli`
//! because it is host I/O (a child process), not todo-file storage.
//!
//! The error type separates "no command exists" from "a command ran and
//! failed". The first is an installation hint; the second carries the bounded
//! reason. That distinction matters because the fallback list probes several
//! programs: a missing `wl-copy` followed by a missing `xclip` means the host
//! has no clipboard tool at all, while a command that exits non-zero is a
//! failure the user may be able to fix.

use std::io::{self, Write};
use std::process::{Command, Stdio};

/// Why a clipboard operation failed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ClipboardError {
    /// No supported clipboard command could be started on this host.
    Unavailable,
    /// A clipboard command started but failed.
    Failed(String),
}

impl core::fmt::Display for ClipboardError {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Unavailable => formatter
                .write_str("No clipboard command found. On Linux, install wl-clipboard or xclip."),
            Self::Failed(message) => write!(formatter, "Clipboard failed: {message}"),
        }
    }
}

impl std::error::Error for ClipboardError {}

/// Copy `text` to the system clipboard.
///
/// # Errors
///
/// Returns [`ClipboardError::Unavailable`] when every candidate command failed
/// to start because it does not exist, or [`ClipboardError::Failed`] when a
/// command started but failed (or a non-zero exit).
pub fn copy(text: &str) -> Result<(), ClipboardError> {
    let mut last_failure = None;
    let mut all_not_found = true;

    for (program, args) in copy_commands() {
        match run_with_stdin(program, args, text.as_bytes()) {
            Ok(()) => return Ok(()),
            Err(failure) => {
                if !failure.spawned_missing() {
                    all_not_found = false;
                }
                last_failure = Some(failure);
            }
        }
    }

    Err(aggregate(last_failure, all_not_found))
}

/// Read the system clipboard as text.
///
/// # Errors
///
/// Returns [`ClipboardError::Unavailable`] when every candidate command failed
/// to start because it does not exist, or [`ClipboardError::Failed`] when a
/// command ran but failed (a non-zero exit, unreadable output, or invalid
/// UTF-8).
pub fn paste() -> Result<String, ClipboardError> {
    let mut last_failure = None;
    let mut all_not_found = true;

    for (program, args) in paste_commands() {
        match Command::new(program).args(*args).output() {
            Ok(output) if output.status.success() => {
                return String::from_utf8(output.stdout)
                    .map_err(|error| ClipboardError::Failed(error.to_string()));
            }
            Ok(output) => {
                all_not_found = false;
                last_failure = Some(CommandFailure::ran(format!(
                    "{program} exited with {}",
                    output.status.code().unwrap_or(-1)
                )));
            }
            Err(error) => {
                if error.kind() != io::ErrorKind::NotFound {
                    all_not_found = false;
                }
                last_failure = Some(CommandFailure::spawn(program, error));
            }
        }
    }

    Err(aggregate(last_failure, all_not_found))
}

/// One failed clipboard command, with enough information to classify it.
enum CommandFailure {
    /// The process could not be spawned. The original [`io::Error`] is kept so
    /// the classification uses its kind without losing the OS detail.
    Spawn {
        /// The command that could not be started.
        program: &'static str,
        /// The original spawn error.
        error: io::Error,
    },
    /// The command started and then failed; the message is already bounded.
    Ran {
        /// A bounded description for [`ClipboardError::Failed`].
        message: String,
    },
}

impl CommandFailure {
    /// A command that started and then failed.
    fn ran(message: impl Into<String>) -> Self {
        Self::Ran {
            message: message.into(),
        }
    }

    /// A command that could not be spawned.
    fn spawn(program: &'static str, error: io::Error) -> Self {
        Self::Spawn { program, error }
    }

    /// True only when the command itself was missing, so the candidate list can
    /// still classify every failure as [`ClipboardError::Unavailable`].
    fn spawned_missing(&self) -> bool {
        match self {
            Self::Spawn { error, .. } => error.kind() == io::ErrorKind::NotFound,
            Self::Ran { .. } => false,
        }
    }

    /// The bounded payload, produced only when this becomes a
    /// [`ClipboardError::Failed`].
    fn into_message(self) -> String {
        match self {
            Self::Spawn { program, error } => format!("{program}: {error}"),
            Self::Ran { message } => message,
        }
    }
}

/// Pick the error for a candidate list that produced no success.
///
/// `Unavailable` is reserved for the case where every candidate failed to
/// spawn with [`io::ErrorKind::NotFound`] (or the list was empty), so a missing
/// tool shows the install hint. Any command that actually ran and failed is a
/// [`ClipboardError::Failed`] with the last bounded message, which is the only
/// place the failure is stringified.
fn aggregate(last_failure: Option<CommandFailure>, all_not_found: bool) -> ClipboardError {
    match last_failure {
        Some(failure) if !all_not_found => ClipboardError::Failed(failure.into_message()),
        _ => ClipboardError::Unavailable,
    }
}

fn run_with_stdin(
    program: &'static str,
    args: &'static [&'static str],
    input: &[u8],
) -> Result<(), CommandFailure> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| CommandFailure::spawn(program, error))?;

    if let Some(mut stdin) = child.stdin.take()
        && let Err(error) = stdin.write_all(input)
    {
        // Reap the child instead of leaving a zombie on the error path.
        drop(stdin);
        let _ = child.kill();
        let _ = child.wait();
        return Err(CommandFailure::ran(format!("{program}: {error}")));
    }

    let status = child
        .wait()
        .map_err(|error| CommandFailure::ran(format!("{program}: {error}")))?;
    if status.success() {
        Ok(())
    } else {
        Err(CommandFailure::ran(format!(
            "{program} exited with {}",
            status.code().unwrap_or(-1)
        )))
    }
}

#[cfg(target_os = "macos")]
fn copy_commands() -> &'static [(&'static str, &'static [&'static str])] {
    &[("pbcopy", &[])]
}

#[cfg(target_os = "windows")]
fn copy_commands() -> &'static [(&'static str, &'static [&'static str])] {
    &[("clip", &[])]
}

#[cfg(all(unix, not(target_os = "macos")))]
fn copy_commands() -> &'static [(&'static str, &'static [&'static str])] {
    &[("wl-copy", &[]), ("xclip", &["-selection", "clipboard"])]
}

#[cfg(target_os = "macos")]
fn paste_commands() -> &'static [(&'static str, &'static [&'static str])] {
    &[("pbpaste", &[])]
}

#[cfg(target_os = "windows")]
fn paste_commands() -> &'static [(&'static str, &'static [&'static str])] {
    &[(
        "powershell.exe",
        &["-NoProfile", "-Command", "Get-Clipboard"],
    )]
}

#[cfg(all(unix, not(target_os = "macos")))]
fn paste_commands() -> &'static [(&'static str, &'static [&'static str])] {
    &[
        ("wl-paste", &["--no-newline"]),
        ("xclip", &["-selection", "clipboard", "-o"]),
    ]
}

#[cfg(test)]
mod tests {
    use super::{ClipboardError, CommandFailure, aggregate, copy_commands, paste_commands};
    use std::io;

    #[test]
    fn every_platform_has_at_least_one_command() {
        assert!(!copy_commands().is_empty());
        assert!(!paste_commands().is_empty());
    }

    #[test]
    fn no_candidates_at_all_is_unavailable() {
        assert_eq!(aggregate(None, true), ClipboardError::Unavailable);
    }

    #[test]
    fn every_missing_program_is_unavailable_with_the_install_hint() {
        let missing = CommandFailure::spawn("xclip", io::Error::from(io::ErrorKind::NotFound));
        assert!(missing.spawned_missing());
        match &missing {
            CommandFailure::Spawn { error, .. } => {
                assert_eq!(
                    error.kind(),
                    io::ErrorKind::NotFound,
                    "the original io::Error is kept, not only its kind"
                );
            }
            CommandFailure::Ran { .. } => panic!("expected a spawn failure"),
        }
        let error = aggregate(Some(missing), true);
        assert_eq!(error, ClipboardError::Unavailable);
        assert_eq!(
            error.to_string(),
            "No clipboard command found. On Linux, install wl-clipboard or xclip."
        );
    }

    #[test]
    fn a_command_that_ran_and_failed_is_not_unavailable() {
        let message = "xclip exited with 1".to_owned();
        let failure = CommandFailure::ran(message.clone());
        assert!(!failure.spawned_missing());
        let error = aggregate(Some(failure), false);
        assert_eq!(error, ClipboardError::Failed(message));
        assert_eq!(error.to_string(), "Clipboard failed: xclip exited with 1");
    }

    #[test]
    fn errors_are_cloneable_and_debuggable() {
        let error = ClipboardError::Failed("reason".to_owned());
        let clone = error.clone();
        assert_eq!(error, clone);
        assert!(format!("{error:?}").contains("Failed"));
    }
}
