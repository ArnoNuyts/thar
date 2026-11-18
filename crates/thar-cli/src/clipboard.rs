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
        match copy_with(program, args, text.as_bytes()) {
            Ok(()) => return Ok(()),
            Err(Some(message)) => failure = Some(message),
            Err(None) => {}
        }
    }
    Err(failure.map_or(ClipboardError::Unavailable, ClipboardError::Failed))
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
        match paste_with(program, args) {
            Ok(text) => return Ok(text),
            Err(Some(message)) => failure = Some(message),
            Err(None) => {}
        }
    }
    Err(failure.map_or(ClipboardError::Unavailable, ClipboardError::Failed))
}

/// Run one copy candidate.
///
/// `None` means the program was not found, so the next candidate may still
/// work; `Some(message)` means it ran and failed.
fn copy_with(
    program: &'static str,
    args: &'static [&'static str],
    input: &[u8],
) -> Result<(), Option<String>> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| spawn_error(program, error))?;

    if let Some(mut stdin) = child.stdin.take()
        && let Err(error) = stdin.write_all(input)
    {
        // Reap the child instead of leaving a zombie on the error path.
        drop(stdin);
        let _ = child.kill();
        let _ = child.wait();
        return Err(Some(format!("{program}: {error}")));
    }

    let status = child
        .wait()
        .map_err(|error| Some(format!("{program}: {error}")))?;
    if status.success() {
        Ok(())
    } else {
        Err(Some(exit_failure(program, status.code())))
    }
}

/// Run one paste candidate and decode its output as UTF-8.
///
/// `None` means the program was not found; `Some(message)` means it ran and
/// failed.
fn paste_with(
    program: &'static str,
    args: &'static [&'static str],
) -> Result<String, Option<String>> {
    let output = Command::new(program)
        .args(args)
        .output()
        .map_err(|error| spawn_error(program, error))?;
    if !output.status.success() {
        return Err(Some(exit_failure(program, output.status.code())));
    }
    String::from_utf8(output.stdout).map_err(|error| Some(error.to_string()))
}

/// Classify a spawn error: only `NotFound` means "try the next candidate
/// silently".
fn spawn_error(program: &'static str, error: io::Error) -> Option<String> {
    if error.kind() == io::ErrorKind::NotFound {
        None
    } else {
        Some(format!("{program}: {error}"))
    }
}

/// The bounded message for a command that started and exited non-zero.
fn exit_failure(program: &'static str, code: Option<i32>) -> String {
    format!("{program} exited with {}", code.unwrap_or(-1))
}

#[cfg(target_os = "macos")]
fn copy_commands() -> &'static [(&'static str, &'static [&'static str])] {
    &[("pbcopy", &[])]
}

#[cfg(target_os = "windows")]
fn copy_commands() -> &'static [(&'static str, &'static [&'static str])] {
    // `clip.exe` decodes stdin with the OEM code page and garbles non-ASCII
    // text. Read the pipe as raw bytes and decode them as UTF-8 instead;
    // changing `[Console]::InputEncoding` inside `-Command` both races
    // PowerShell's own stdin reader and leaves the shared console code page
    // changed after thar exits.
    &[(
        "powershell.exe",
        &[
            "-NoProfile",
            "-Command",
            "$ms = New-Object IO.MemoryStream; [Console]::OpenStandardInput().CopyTo($ms); Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString($ms.ToArray()))",
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
    // PowerShell's redirected stdout defaults to the OEM code page. Write the
    // UTF-8 bytes of the clipboard text to the raw output stream instead;
    // changing `[Console]::OutputEncoding` would leave the shared console code
    // page changed after thar exits. `-Raw` keeps the clipboard line ending
    // from gaining an extra trailing CRLF.
    &[(
        "powershell.exe",
        &[
            "-NoProfile",
            "-Command",
            "$b = [Text.Encoding]::UTF8.GetBytes((Get-Clipboard -Raw)); $o = [Console]::OpenStandardOutput(); $o.Write($b, 0, $b.Length)",
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
    use super::{ClipboardError, copy_commands, paste_commands};

    #[test]
    fn every_platform_has_at_least_one_command() {
        assert!(!copy_commands().is_empty());
        assert!(!paste_commands().is_empty());
    }

    #[test]
    fn unavailable_says_how_to_install_one() {
        assert_eq!(
            ClipboardError::Unavailable.to_string(),
            "No clipboard command found. On Linux, install wl-clipboard or xclip."
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
