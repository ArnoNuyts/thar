//! Clipboard copy and paste through the platform's command-line tool.
//!
//! This is a direct port of `logic/clipboard.ts`: no graphical toolkit, no
//! extra dependency, and the same command fallbacks. It lives in `thar-cli`
//! because it is host I/O (a child process), not todo-file storage.
//!
//! The error type separates "no command exists" from "a command ran and
//! failed". The first is an installation hint; the second carries the bounded
//! reason and nothing else, because the caller already prefixes the toast with
//! `Copy failed:` or `Paste failed:`. When the fallback list probes several
//! programs, a later "command not found" never hides a real failure.

use std::io::{self, Write};
use std::process::{Command, Stdio};

/// Why a clipboard operation failed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ClipboardError {
    /// No supported clipboard command could be started on this host.
    Unavailable,
    /// A clipboard command started but failed; the bounded reason.
    Failed(String),
}

impl core::fmt::Display for ClipboardError {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Unavailable => formatter
                .write_str("No clipboard command found. On Linux, install wl-clipboard or xclip."),
            // The caller owns the `Copy failed:` / `Paste failed:` prefix.
            Self::Failed(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for ClipboardError {}

/// Copy `text` to the system clipboard.
///
/// # Errors
///
/// Returns [`ClipboardError::Unavailable`] when every candidate command was
/// missing, or [`ClipboardError::Failed`] with the last real failure when a
/// command started but failed.
pub fn copy(text: &str) -> Result<(), ClipboardError> {
    let mut failure = None;
    for (program, args) in copy_commands() {
        match run_with_stdin(program, args, text.as_bytes()) {
            Ok(()) => return Ok(()),
            Err(command_failure) => record(&mut failure, command_failure),
        }
    }
    Err(aggregate(failure))
}

/// Read the system clipboard as text.
///
/// # Errors
///
/// Returns [`ClipboardError::Unavailable`] when every candidate command was
/// missing, or [`ClipboardError::Failed`] when a command ran but failed (a
/// non-zero exit, unreadable output, or invalid UTF-8).
pub fn paste() -> Result<String, ClipboardError> {
    let mut failure = None;
    for (program, args) in paste_commands() {
        match Command::new(program).args(*args).output() {
            Ok(output) if output.status.success() => {
                return String::from_utf8(output.stdout)
                    .map_err(|error| ClipboardError::Failed(error.to_string()));
            }
            Ok(output) => record(
                &mut failure,
                CommandFailure::Failed(format!(
                    "{program} exited with {}",
                    output.status.code().unwrap_or(-1)
                )),
            ),
            Err(error) => record(&mut failure, CommandFailure::spawn(program, error)),
        }
    }
    Err(aggregate(failure))
}

/// One failed candidate command.
enum CommandFailure {
    /// The program does not exist; a later candidate may still work.
    Missing,
    /// The program started and failed with this bounded message.
    Failed(String),
}

impl CommandFailure {
    /// Classify a spawn error: only `NotFound` means "try the next candidate
    /// silently".
    fn spawn(program: &'static str, error: io::Error) -> Self {
        if error.kind() == io::ErrorKind::NotFound {
            Self::Missing
        } else {
            Self::Failed(format!("{program}: {error}"))
        }
    }
}

/// Keep the last real failure; a missing candidate never overwrites it.
fn record(failure: &mut Option<String>, next: CommandFailure) {
    if let CommandFailure::Failed(message) = next {
        *failure = Some(message);
    }
}

/// Pick the error for a candidate list that produced no success.
fn aggregate(last_failure: Option<String>) -> ClipboardError {
    last_failure.map_or(ClipboardError::Unavailable, ClipboardError::Failed)
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
        return Err(CommandFailure::Failed(format!("{program}: {error}")));
    }

    let status = child
        .wait()
        .map_err(|error| CommandFailure::Failed(format!("{program}: {error}")))?;
    if status.success() {
        Ok(())
    } else {
        Err(CommandFailure::Failed(format!(
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
    // `clip.exe` decodes stdin with the OEM code page and garbles non-ASCII
    // text. PowerShell reads UTF-8 and writes the clipboard through
    // `Set-Clipboard`, which is Unicode-aware.
    &[(
        "powershell.exe",
        &[
            "-NoProfile",
            "-Command",
            "try { [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch {}; $input | Set-Clipboard",
        ],
    )]
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
    // PowerShell's redirected stdout defaults to the OEM code page; request
    // UTF-8 so non-ASCII clipboard text is not rejected as invalid UTF-8.
    &[(
        "powershell.exe",
        &[
            "-NoProfile",
            "-Command",
            "try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}; Get-Clipboard",
        ],
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
    use super::{ClipboardError, CommandFailure, aggregate, copy_commands, paste_commands, record};

    #[test]
    fn every_platform_has_at_least_one_command() {
        assert!(!copy_commands().is_empty());
        assert!(!paste_commands().is_empty());
    }

    #[test]
    fn no_candidates_at_all_is_unavailable() {
        assert_eq!(aggregate(None), ClipboardError::Unavailable);
        assert_eq!(
            ClipboardError::Unavailable.to_string(),
            "No clipboard command found. On Linux, install wl-clipboard or xclip."
        );
    }

    #[test]
    fn a_command_that_ran_and_failed_is_not_unavailable() {
        let error = aggregate(Some("xclip exited with 1".to_owned()));
        assert_eq!(
            error,
            ClipboardError::Failed("xclip exited with 1".to_owned())
        );
    }

    #[test]
    fn a_missing_later_candidate_does_not_hide_a_real_failure() {
        // The first candidate ran and failed; the fallback then did not exist.
        let mut failure = None;
        record(
            &mut failure,
            CommandFailure::Failed("wl-copy exited with 1".to_owned()),
        );
        record(&mut failure, CommandFailure::Missing);
        assert_eq!(
            aggregate(failure),
            ClipboardError::Failed("wl-copy exited with 1".to_owned())
        );
    }

    #[test]
    fn failed_displays_only_the_bounded_reason() {
        // The caller adds `Copy failed:` / `Paste failed:`; the error itself
        // must not repeat a second prefix.
        let error = ClipboardError::Failed("xclip exited with 1".to_owned());
        assert_eq!(error.to_string(), "xclip exited with 1");
    }
}
