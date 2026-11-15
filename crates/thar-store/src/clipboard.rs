//! Clipboard copy and paste through the platform's command-line tool.
//!
//! This is a direct port of `logic/clipboard.ts`: no graphical toolkit, no
//! extra dependency, and the same command fallbacks. A missing tool is a
//! bounded error the TUI shows as a toast.

use std::io::Write;
use std::process::{Command, Stdio};

use crate::error::StoreError;

/// Copy `text` to the system clipboard.
///
/// # Errors
///
/// Returns [`StoreError::ClipboardUnavailable`] when no supported command
/// exists, or [`StoreError::ClipboardFailed`] when every candidate failed.
pub fn copy(text: &str) -> Result<(), StoreError> {
    let mut last_error = None;

    for (program, args) in copy_commands() {
        match run_with_stdin(program, args, text.as_bytes()) {
            Ok(()) => return Ok(()),
            Err(message) => last_error = Some(message),
        }
    }

    Err(match last_error {
        Some(message) => StoreError::ClipboardFailed { message },
        None => StoreError::ClipboardUnavailable,
    })
}

/// Read the system clipboard as text.
///
/// # Errors
///
/// Returns [`StoreError::ClipboardUnavailable`] when no supported command
/// exists, or [`StoreError::ClipboardFailed`] when every candidate failed.
pub fn paste() -> Result<String, StoreError> {
    let mut last_error = None;

    for (program, args) in paste_commands() {
        match Command::new(program).args(*args).output() {
            Ok(output) if output.status.success() => {
                return String::from_utf8(output.stdout).map_err(|error| {
                    StoreError::ClipboardFailed {
                        message: error.to_string(),
                    }
                });
            }
            Ok(output) => {
                last_error = Some(format!(
                    "{program} exited with {}",
                    output.status.code().unwrap_or(-1)
                ));
            }
            Err(error) => last_error = Some(format!("{program}: {error}")),
        }
    }

    Err(match last_error {
        Some(message) => StoreError::ClipboardFailed { message },
        None => StoreError::ClipboardUnavailable,
    })
}

fn run_with_stdin(
    program: &'static str,
    args: &'static [&'static str],
    input: &[u8],
) -> Result<(), String> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("{program}: {error}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(input)
            .map_err(|error| format!("{program}: {error}"))?;
    }

    let status = child
        .wait()
        .map_err(|error| format!("{program}: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "{program} exited with {}",
            status.code().unwrap_or(-1)
        ))
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
    use super::{copy_commands, paste_commands};

    #[test]
    fn every_platform_has_at_least_one_command() {
        assert!(!copy_commands().is_empty());
        assert!(!paste_commands().is_empty());
    }
}
