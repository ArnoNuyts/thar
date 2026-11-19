//! `thar-cli`: the `thar-rs` TUI binary.
//!
//! The binary opens a todo file read-only by default. `--write` enables the
//! write-capable path: it creates a missing file, keeps one `<file>.bak` before
//! the first save, refuses to overwrite an external edit, and replaces the file
//! atomically through [`thar_store`]. The read-only path links no writer in
//! practice: [`load`] reads and parses, [`terminal`] owns the terminal, and a
//! missing file is not created unless `--write` was passed. [`sync`] watches the
//! file for external edits in both modes and owns the reload and read-only
//! recovery policy (see the sync design notes under `docs/rust-port/`).
//!
//! The CLI surface mirrors `logic/cli.ts` for the flags the port supports:
//! `-f/--file`, `-h/--help`, `-v/--version`, `--write`, `--read-only`,
//! `--no-backup`, `--no-update-check`, and `--`. `update` is recognized and
//! rejected with a bounded message: self-update is a distribution concern, not a
//! feature of this binary. An invalid `THAR_MAX_*` override is fatal with exit
//! code 2, matching the TypeScript `InvalidLimitError`; it never silently falls
//! back to a default.

pub mod cli;
pub mod clipboard;
pub mod file;
pub mod sync;
pub mod terminal;

use std::ffi::OsString;
use std::process::ExitCode;

pub use cli::{CliCommand, CliError, DEFAULT_FILENAME, format_usage, parse_cli_args};
pub use file::{
    LoadError, LoadedFile, get_read_limits, load, load_with_limits, read_bytes, read_limits_from,
};
use terminal::{run_tui, today_local};

/// Version printed by `thar-rs --version`.
///
/// Release builds set `THAR_BUILD_VERSION` to the npm release version so a
/// downloaded binary reports the same version as its tag. Local builds and the
/// Rust workspace keep using the crate version.
pub const VERSION: &str = match option_env!("THAR_BUILD_VERSION") {
    Some(version) => version,
    None => env!("CARGO_PKG_VERSION"),
};

/// Entry point used by `main.rs` and the unit tests.
///
/// Arguments are the OS strings after the program name, so a non-UTF-8 todo
/// file name reaches the loader unchanged.
#[must_use]
pub fn run(args: &[OsString]) -> ExitCode {
    let command = match parse_cli_args(args) {
        Ok(command) => command,
        Err(error) => {
            eprintln!("thar-rs: {error}");
            eprintln!();
            eprintln!("{}", format_usage(VERSION));
            return ExitCode::from(2);
        }
    };

    match command {
        CliCommand::Help => {
            println!("{}", format_usage(VERSION));
            ExitCode::SUCCESS
        }
        CliCommand::Version => {
            println!("{VERSION}");
            ExitCode::SUCCESS
        }
        CliCommand::Update => {
            eprintln!("thar-rs: self-update is not supported by this build.");
            ExitCode::from(2)
        }
        CliCommand::Run { file, write } => run_editor(file, write),
    }
}

/// Open one todo file in the TUI, honouring the write flags.
///
/// `write` is the backup policy for a writable session; `None` is read-only.
fn run_editor(file: std::path::PathBuf, write: Option<thar_store::BackupPolicy>) -> ExitCode {
    // The Ink app creates a missing todo file during startup. Restore that only
    // in write mode; the read-only contract must not create anything.
    if write.is_some()
        && let Err(error) = thar_store::ensure_file(&file)
    {
        eprintln!("thar-rs: cannot create the todo file: {error}");
        return ExitCode::from(1);
    }

    let loaded = match load(&file) {
        Ok(loaded) => loaded,
        Err(error) => {
            // An invalid THAR_MAX_* override is a usage error (the TypeScript
            // InvalidLimitError path); every other load failure is exit 1.
            let code = match error {
                LoadError::InvalidLimit(_) => 2,
                _ => 1,
            };
            eprintln!("thar-rs: {error}");
            return ExitCode::from(code);
        }
    };

    // Build the watcher from what this session actually loaded: the same limits
    // and the exact bytes, so no environment value is read or file stat is
    // repeated between the load and the first poll.
    let sync = crate::sync::FileSync::from_load(&file, &loaded);

    let LoadedFile {
        todos,
        error,
        limits,
        ..
    } = loaded;

    let today = today_local();
    let mut app = thar_tui::App::new(file.clone(), todos, today);
    app.set_load_error(error);
    // `run_tui` derives the read-only flag from the presence of the store, so
    // write mode has one source of truth. The guard is created only in write
    // mode, even when `load_error` is already set (a file deleted between the
    // create and the read): the session then writes nothing until the watcher
    // reloads a file that exists again, which is the Ink app's recovery path.
    let mut guard = write.map(|policy| thar_store::SaveGuard::new(file, limits, policy));
    match run_tui(&mut app, guard.as_mut(), sync) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("thar-rs: {error}");
            ExitCode::from(1)
        }
    }
}
